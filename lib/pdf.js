import { extractTaxIds as extractCnpjs, isValidTaxId as isValidCnpj, normalizeTaxId as normalizeCnpj } from "./core.js";

const LOAD_TIMEOUT_MS = 45_000;
const PAGE_TIMEOUT_MS = 30_000;
const DOCUMENT_TIMEOUT_MS = 180_000;
let pdfJsModule;

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Decode standard base64 without visiting a URL or using a remote service. */
export function base64ToBytes(value) {
  if (typeof value !== "string") throw new TypeError("O conteúdo em base64 deve ser texto.");
  const compact = value.replace(/[\t\n\r\f ]/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new TypeError("Conteúdo em base64 inválido.");
  }
  let binary;
  try {
    binary = atob(compact);
  } catch {
    throw new TypeError("Conteúdo em base64 inválido.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encode bytes in bounded chunks; the input buffer is never changed. */
export function bytesToBase64(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("Os bytes devem ser um Uint8Array.");
  const chunks = [];
  // Divisible by three: only the final chunk may contain base64 padding.
  const chunkSize = 24_576;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(btoa(String.fromCharCode(...value.subarray(offset, offset + chunkSize))));
  }
  return chunks.join("");
}

async function loadPdfJs() {
  pdfJsModule ??= import("../vendor/pdf.mjs").then((module) => {
    module.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.mjs", import.meta.url).href;
    return module;
  });
  return pdfJsModule;
}

function hasPdfHeader(bytes) {
  // PDF readers may accept a small leading preamble before the PDF signature.
  const prefix = String.fromCharCode(...bytes.subarray(0, 1024));
  return prefix.includes("%PDF-");
}

function textFromItems(items) {
  const fragments = [];
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    fragments.push(item.str, item.hasEOL ? "\n" : " ");
  }
  return fragments.join("")
    .replace(/[\t ]+\n/gu, "\n")
    .replace(/\n[\t ]+/gu, "\n")
    .replace(/[\t ]{2,}/gu, " ")
    .trim();
}

/**
 * Extract selectable text locally with the bundled PDF.js worker.
 *
 * Input: a base64 string or Uint8Array. Bytes are copied before PDF.js can
 * transfer their buffer to its worker. onPage({ page, text, pageCount }) is
 * optional and may return a promise. Page numbers start at one.
 *
 * Return: { pages: [{ page, text }], pageCount, emptyPages: [page], limited }.
 * Empty pages are reported; OCR is deliberately not attempted. Timeouts are
 * 45s to load, 30s per page operation and 180s overall. Abort and timeout paths
 * destroy the PDF loading task and its worker, as does normal completion.
 */
export async function readPdf(base64OrUint8, { signal, maxPages = 1000, onPage } = {}) {
  if (signal?.aborted) throw namedError("AbortError", "Leitura do PDF cancelada.");
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError("O limite de páginas deve ser um inteiro positivo.");
  }
  if (onPage !== undefined && typeof onPage !== "function") {
    throw new TypeError("onPage deve ser uma função.");
  }
  if (typeof base64OrUint8 !== "string" && !(base64OrUint8 instanceof Uint8Array)) {
    throw new TypeError("Informe o PDF em base64 ou como Uint8Array.");
  }
  const original = typeof base64OrUint8 === "string" ? base64ToBytes(base64OrUint8) : base64OrUint8;
  if (!original.length || !hasPdfHeader(original)) {
    throw new TypeError("O arquivo recebido não contém uma assinatura de PDF válida.");
  }
  const data = new Uint8Array(original);
  let loadingTask;
  let document;
  let destruction;
  let cancellationError;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });

  function destroy() {
    if (!destruction) {
      destruction = Promise.resolve()
        .then(() => (loadingTask || document)?.destroy())
        .catch(() => {});
    }
    return destruction;
  }

  function cancel(error) {
    if (cancellationError) return;
    cancellationError = error;
    rejectCancellation(error);
    void destroy();
  }

  function ensureActive() {
    if (cancellationError) throw cancellationError;
    if (signal?.aborted) throw namedError("AbortError", "Leitura do PDF cancelada.");
  }

  async function bounded(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = namedError("TimeoutError", message);
        cancel(error);
        reject(error);
      }, milliseconds);
    });
    try {
      return await Promise.race([promise, cancellation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const onAbort = () => cancel(namedError("AbortError", "Leitura do PDF cancelada."));
  signal?.addEventListener("abort", onAbort, { once: true });
  const overallTimer = setTimeout(() => {
    cancel(namedError("TimeoutError", "A leitura do PDF excedeu o limite de 180 segundos."));
  }, DOCUMENT_TIMEOUT_MS);

  try {
    const pdfjs = await bounded(loadPdfJs(), LOAD_TIMEOUT_MS, "O leitor de PDF demorou demais para carregar.");
    ensureActive();
    loadingTask = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      useWasm: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      standardFontDataUrl: new URL("../vendor/standard_fonts/", import.meta.url).href,
      verbosity: 0,
    });
    document = await bounded(loadingTask.promise, LOAD_TIMEOUT_MS, "O PDF demorou demais para abrir.");
    ensureActive();
    const pageCount = document.numPages;
    const pages = [];
    const emptyPages = [];
    const lastPage = Math.min(maxPages, pageCount);

    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      ensureActive();
      const page = await bounded(
        document.getPage(pageNumber), PAGE_TIMEOUT_MS,
        `A página ${pageNumber} demorou demais para abrir.`,
      );
      try {
        const content = await bounded(
          page.getTextContent(), PAGE_TIMEOUT_MS,
          `A extração de texto da página ${pageNumber} excedeu o limite de tempo.`,
        );
        ensureActive();
        const text = textFromItems(content.items);
        pages.push({ page: pageNumber, text });
        if (!text) emptyPages.push(pageNumber);
        if (onPage) {
          await bounded(
            Promise.resolve(onPage({ page: pageNumber, text, pageCount })), PAGE_TIMEOUT_MS,
            `O processamento da página ${pageNumber} excedeu o limite de tempo.`,
          );
        }
      } finally {
        // The loading task can already be destroyed if the user cancelled.
        try { page.cleanup(); } catch {}
      }
    }
    ensureActive();
    return { pages, pageCount, emptyPages, limited: lastPage < pageCount };
  } finally {
    clearTimeout(overallTimer);
    signal?.removeEventListener("abort", onAbort);
    // Always request destruction. Do not keep a cancelled UI waiting forever
    // if a damaged worker also fails to acknowledge its own destruction.
    let cleanupTimer;
    try {
      await Promise.race([
        destroy(),
        new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 2000); }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}

const CRC_TITLE = /\bCERTIFICADO\s+DE\s+REGISTRO\s+CADASTRAL(?:\s+DO\s+FORNECEDOR\b(?:\s*[-–—:/]?\s*CRC\b)?|\s*[-–—:/]?\s*CRC\b)/iu;
const DATA_REPORT_TITLE = /\bRELAT[ÓO]RIO\s+(?:DE\s+)?DADOS\b/iu;
const IDENTIFICATION_TITLE = /\bIDENTIFICA[ÇC][ÃA]O\b/iu;
const IDENTIFICATION_END = /(?:^|\n)[\t ]*(?:CONTATOS|ENDERE[ÇC]OS?|REPRESENTANTES?|QUADRO\s+SOCIET[ÁA]RIO|CREDENCIAMENTO|HABILITA[ÇC][ÃA]O|REGULARIDADE|DOCUMENTA[ÇC][ÃA]O)\b/iu;
const SUPPLIER_NAME_LABEL = /\b(?:NOME\s+DO\s+FORNECEDOR|NOME\s+EMPRESARIAL|RAZ[ÃA]O\s+SOCIAL)\s*[:：]?\s*/iu;
const SUPPLIER_NEXT_LABEL = /\b(?:NOME\s+FANTASIA|NATUREZA\s+JUR[ÍI]DICA|CNPJ|CPF|INSCRI[ÇC][ÃA]O\s+ESTADUAL|TIPO\s+DE\s+FORNECEDOR)\b/iu;
const EMISSION_LABEL = /\bEMITIDO\s+EM\b/giu;
const EMISSION_VALUE = /^\s*:\s*(\d{2})\s*\/\s*(\d{2})\s*\/\s*(\d{4})\s+[ÀA]S\s+(\d{2})\s*:\s*(\d{2})\s*:\s*(\d{2})(?!\d)/iu;

function calendarValid(year, month, day, hour, minute, second) {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function emissionFromParts(parts) {
  const [day, month, year, hour, minute, second] = parts;
  if (!calendarValid(...[year, month, day, hour, minute, second].map(Number))) return null;
  const documentDate = `${day}/${month}/${year}`;
  return {
    emittedAt: `${year}-${month}-${day}T${hour}:${minute}:${second}-03:00`,
    documentDate,
    emittedAtText: `${documentDate} ${hour}:${minute}:${second}`,
  };
}

function supplierNameFromBlock(block) {
  const label = block.match(SUPPLIER_NAME_LABEL);
  if (!label) return "";
  const value = block.slice(label.index + label[0].length);
  const nextLabel = value.search(SUPPLIER_NEXT_LABEL);
  return value.slice(0, nextLabel < 0 ? 300 : nextLabel)
    .replace(/\s+/gu, " ").trim();
}

/**
 * Inspect certificate text without accepting a supplier merely mentioned
 * elsewhere in the PDF. The first CNPJ field inside IDENTIFICAÇÃO is the only
 * source for the primary identity. The title, identity and explicit "Emitido
 * em:" footer must all validate for isCrc to be true.
 *
 * issues and issueCodes are parallel arrays. emissionFound distinguishes a
 * genuinely missing label from a printed but invalid/ambiguous timestamp, so
 * a caller can restrict any manual date fallback to the former case.
 */
export function inspectCrcText(text, expectedCnpj) {
  const result = {
    isCrc: false,
    titleValid: false,
    identityValid: false,
    emissionValid: false,
    emissionFound: false,
    cnpj: "",
    supplierName: "",
    emittedAt: "",
    documentDate: "",
    emittedAtText: "",
    issues: [],
    issueCodes: [],
  };
  const addIssue = (code, message) => {
    result.issueCodes.push(code);
    result.issues.push(message);
  };
  const normalizedText = typeof text === "string"
    ? text.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/[\u00a0\u202f]/gu, " ").replace(/\u200B/gu, "")
    : "";
  const header = normalizedText.slice(0, 1800);
  if (DATA_REPORT_TITLE.test(header)) {
    addIssue("DATA_REPORT_NOT_CRC", "O PDF é um relatório de dados, e não o Certificado de Registro Cadastral.");
  } else if (!CRC_TITLE.test(header)) {
    addIssue("CRC_TITLE_MISSING", "O título do Certificado de Registro Cadastral do Fornecedor não foi identificado.");
  } else {
    result.titleValid = true;
  }

  const identityIssueCount = result.issues.length;
  const identification = normalizedText.match(IDENTIFICATION_TITLE);
  if (!identification) {
    addIssue("IDENTIFICATION_MISSING", "O bloco IDENTIFICAÇÃO do fornecedor não foi localizado no PDF.");
  } else {
    let block = normalizedText.slice(identification.index + identification[0].length, identification.index + 2200);
    const sectionEnd = block.search(IDENTIFICATION_END);
    if (sectionEnd >= 0) block = block.slice(0, sectionEnd);
    const label = block.match(/\b(?:CNPJ|CPF)(?:\s*\/\s*(?:CPF|CNPJ))?\b/iu);
    if (!label) {
      addIssue("PRIMARY_CNPJ_MISSING", "O CPF/CNPJ principal não foi encontrado no bloco IDENTIFICAÇÃO.");
    } else {
      const value = block.slice(label.index + label[0].length).replace(/^[\s:：-]+/u, "");
      // Adding this exact label permits the core parser's cautious handling
      // of compact alphanumeric CNPJs. No non-whitespace field text is skipped.
      const prefix = 'CPF/CNPJ ';
      const primary = extractCnpjs(prefix + value.slice(0, 160)).find(item =>
        item.start === prefix.length &&
        (label[0].toUpperCase().includes('CPF') || item.type !== 'CPF') &&
        (label[0].toUpperCase().includes('CNPJ') || item.type === 'CPF'));
      if (!primary) {
        addIssue("PRIMARY_CNPJ_INVALID", "O valor imediatamente após o CPF/CNPJ principal está ausente ou é inválido.");
      } else {
        result.cnpj = primary.cnpj;
      }
    }
    result.supplierName = supplierNameFromBlock(block);
  }
  if (expectedCnpj !== undefined && expectedCnpj !== null && expectedCnpj !== "") {
    const expected = normalizeCnpj(expectedCnpj);
    if (!isValidCnpj(expected)) {
      addIssue("EXPECTED_CNPJ_INVALID", "O CPF/CNPJ informado para a consulta é inválido.");
    } else if (result.cnpj && result.cnpj !== expected) {
      addIssue("CNPJ_MISMATCH", "O CPF/CNPJ principal do certificado é diferente do fornecedor selecionado.");
    }
  }
  result.identityValid = Boolean(result.cnpj) && result.issues.length === identityIssueCount;

  const emissionLabels = [...normalizedText.matchAll(EMISSION_LABEL)];
  result.emissionFound = emissionLabels.length > 0;
  if (!result.emissionFound) {
    addIssue("EMISSION_MISSING", "O rodapé com a data e a hora de emissão não foi encontrado no texto do PDF.");
  } else {
    const emissions = [];
    let invalidEmission = false;
    for (const label of emissionLabels) {
      const tail = normalizedText.slice(label.index + label[0].length, label.index + label[0].length + 100);
      const match = tail.match(EMISSION_VALUE);
      const emission = match ? emissionFromParts(match.slice(1)) : null;
      if (!emission) invalidEmission = true;
      else emissions.push(emission);
    }
    if (invalidEmission) {
      addIssue("EMISSION_INVALID", "A data ou a hora impressa após Emitido em está incompleta ou é inválida.");
    } else if (new Set(emissions.map((item) => item.emittedAt)).size !== 1) {
      addIssue("EMISSION_AMBIGUOUS", "O PDF contém rodapés com datas ou horas de emissão diferentes.");
    } else {
      Object.assign(result, emissions[0]);
      result.emissionValid = true;
    }
  }
  result.isCrc = result.titleValid && result.identityValid && result.emissionValid;
  return result;
}

/** Build a safe filename from a valid CNPJ and the validated -03:00 instant. */
export function buildCrcFileName(cnpj, emittedAt) {
  const normalized = normalizeCnpj(cnpj);
  if (!isValidCnpj(normalized)) throw new TypeError("Não é possível nomear o arquivo com um CPF/CNPJ inválido.");
  const match = typeof emittedAt === "string"
    ? emittedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})-03:00$/u)
    : null;
  if (!match || !calendarValid(...match.slice(1).map(Number))) {
    throw new TypeError("A data de emissão deve ser um instante válido com o fuso -03:00.");
  }
  const [, year, month, day, hour, minute, second] = match;
  return `CRC_${normalized}_${year}-${month}-${day}_${hour}-${minute}-${second}.pdf`;
}
