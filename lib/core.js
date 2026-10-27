/**
 * CNPJ and date helpers shared by the extension's browser contexts.
 *
 * CNPJ values are always strings, so leading zeroes survive. The alphanumeric
 * check-digit calculation uses each character's ASCII code minus 48, including
 * letters (A = 17), as specified by Receita Federal:
 * https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/perguntas-e-respostas/cnpj/cnpj-alfanumerico.pdf
 */

const SPACE = String.raw`[\s\u200B]`;
const OPTIONAL_SPACE = `${SPACE}*`;
const DASH = String.raw`[-\u2010\u2011\u2012\u2013\u2014\u2212]`;
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const COMPACT_CNPJ = /^[A-Za-z0-9]{12}[0-9]{2}$/;
const FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

// Separators establish a CNPJ's shape even when a PDF splits individual glyphs
// or inserts line breaks. Letter removal is deliberately never used.
function groupPattern(length, numeric = false) {
  const character = numeric ? "[0-9]" : "[A-Za-z0-9]";
  return `(${character}(?:${OPTIONAL_SPACE}${character}){${length - 1}})`;
}

const FORMATTED_SOURCE =
  `${groupPattern(2)}${OPTIONAL_SPACE}\\.${OPTIONAL_SPACE}` +
  `${groupPattern(3)}${OPTIONAL_SPACE}\\.${OPTIONAL_SPACE}` +
  `${groupPattern(3)}${OPTIONAL_SPACE}/${OPTIONAL_SPACE}` +
  `${groupPattern(4)}${OPTIONAL_SPACE}${DASH}${OPTIONAL_SPACE}` +
  groupPattern(2, true);

// Some extracted PDFs preserve group spacing but omit punctuation. This
// restricted 2 / 3 / 3 / 4 / 2 grammar never joins arbitrary prose together.
const SPACED_SOURCE =
  `([A-Za-z0-9]{2})${SPACE}+([A-Za-z0-9]{3})${SPACE}+` +
  `([A-Za-z0-9]{3})${SPACE}+([A-Za-z0-9]{4})${SPACE}+([0-9]{2})`;

const FORMATTED_CNPJ = new RegExp(`^(?:${FORMATTED_SOURCE})$`, "u");
const SPACED_CNPJ = new RegExp(`^(?:${SPACED_SOURCE})$`, "u");
const CNPJ_LABEL = /\bC\s*\.?\s*N\s*\.?\s*P\s*\.?\s*J\b\.?/iu;

/**
 * Return 14 uppercase characters for a CNPJ-shaped string, or "".
 *
 * Accepted shapes: 14 contiguous characters; canonical punctuation with
 * optional whitespace; or whitespace-separated groups of 2, 3, 3, 4 and 2.
 * This function checks shape, not check digits. It rejects prose containing a
 * CNPJ, numbers (which can lose leading zeroes), prefixes and trailing labels.
 */
export function normalizeCnpj(value) {
  if (typeof value !== "string") return "";
  const candidate = value.replace(/^[\s\u200B]+|[\s\u200B]+$/gu, "");
  if (COMPACT_CNPJ.test(candidate)) return candidate.toUpperCase();

  const match = candidate.match(FORMATTED_CNPJ) || candidate.match(SPACED_CNPJ);
  if (!match) return "";
  return match.slice(1).join("").replace(/[\s\u200B]/gu, "").toUpperCase();
}

function checkDigit(characters, weights) {
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += (characters.charCodeAt(index) - 48) * weights[index];
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Validate numeric and alphanumeric CNPJs, including both check digits. */
export function isValidCnpj(value) {
  const cnpj = normalizeCnpj(value);
  if (!cnpj || /^([A-Z0-9])\1{13}$/.test(cnpj)) return false;
  return (
    checkDigit(cnpj, FIRST_WEIGHTS) === Number(cnpj[12]) &&
    checkDigit(cnpj, SECOND_WEIGHTS) === Number(cnpj[13])
  );
}

/** Format a CNPJ-shaped value; callers can validate check digits separately. */
export function formatCnpj(value) {
  const cnpj = normalizeCnpj(value);
  if (!cnpj) return "";
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/` +
    `${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

function hasTokenBoundaries(text, start, end) {
  // Array.from preserves supplementary Unicode letters at either boundary.
  const before = start > 0 ? Array.from(text.slice(Math.max(0, start - 2), start)).at(-1) : "";
  const after = end < text.length ? Array.from(text.slice(end, end + 2))[0] : "";
  return !TOKEN_CHARACTER.test(before) && !TOKEN_CHARACTER.test(after);
}

function hasNearbyCnpjLabel(text, start, end) {
  // A preceding label can include common prose such as "inscrito no CNPJ sob
  // o nº". Limit distance and paragraph breaks to avoid borrowing a heading
  // from a different field. An immediately following "(CNPJ)" is also useful.
  const before = text.slice(Math.max(0, start - 64), start);
  const labelMatches = [...before.matchAll(new RegExp(CNPJ_LABEL.source, "giu"))];
  const lastLabel = labelMatches.at(-1);
  if (lastLabel) {
    const between = before.slice(lastLabel.index + lastLabel[0].length);
    if (!/\n[\t \r]*\n/u.test(between)) return true;
  }
  const after = text.slice(end, end + 24);
  return new RegExp(`^[\\s:;,(\\[–—-]*${CNPJ_LABEL.source}`, "iu").test(after);
}

function occurrenceContext(text, start, end) {
  const from = Math.max(0, start - 80);
  const to = Math.min(text.length, end + 100);
  const excerpt = text.slice(from, to).replace(/[\s\u200B]+/gu, " ").trim();
  return `${from > 0 ? "…" : ""}${excerpt}${to < text.length ? "…" : ""}`;
}

/**
 * Find valid CNPJs in extracted HTML/PDF text.
 *
 * Each result is { cnpj, formatted, start, end, context }. Offsets are UTF-16
 * string indexes; end is exclusive. Repeated appearances of the same CNPJ
 * remain separate, preserving the evidence a document scanner needs. Only
 * duplicate/overlapping matches from different recognition patterns collapse.
 *
 * Formatted CNPJs and contiguous 14-digit CNPJs need no label. Unformatted
 * alphanumeric values and punctuation-free spaced groups need a nearby CNPJ
 * label, because their shape can otherwise describe unrelated identifiers.
 */
export function extractCnpjs(text) {
  if (typeof text !== "string" || !text) return [];
  const occurrences = [];
  const patterns = [
    { source: FORMATTED_SOURCE, requiresLabel: false },
    { source: "[A-Za-z0-9]{12}[0-9]{2}", requiresLabel: "alphanumeric" },
    { source: SPACED_SOURCE, requiresLabel: true },
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, "gu"))) {
      const start = match.index;
      const end = start + match[0].length;
      if (!hasTokenBoundaries(text, start, end)) continue;
      const cnpj = normalizeCnpj(match[0]);
      if (!isValidCnpj(cnpj)) continue;
      const needsLabel = pattern.requiresLabel === true ||
        (pattern.requiresLabel === "alphanumeric" && /[A-Z]/.test(cnpj));
      if (needsLabel && !hasNearbyCnpjLabel(text, start, end)) continue;

      occurrences.push({
        cnpj,
        formatted: formatCnpj(cnpj),
        start,
        end,
        context: occurrenceContext(text, start, end),
      });
    }
  }
  // Resolve overlapping recognition patterns after sorting, avoiding a
  // quadratic scan when a long process repeats the same CNPJ many times.
  let previousEnd = -1;
  return occurrences
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((item) => {
      if (item.start < previousEnd) return false;
      previousEnd = item.end;
      return true;
    });
}

const BRAZIL_DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function brazilDateParts(value) {
  if (value === null || !["string", "number", "object"].includes(typeof value)) return null;
  if (typeof value === "object" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Object.fromEntries(
    BRAZIL_DATE_TIME.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** DD/MM/YYYY in America/Sao_Paulo; invalid dates return "". */
export function formatBrazilDate(date = new Date()) {
  const parts = brazilDateParts(date);
  return parts ? `${parts.day}/${parts.month}/${parts.year}` : "";
}

/** DD/MM/YYYY HH:mm:ss in America/Sao_Paulo; invalid dates return "". */
export function formatBrazilDateTime(date = new Date()) {
  const parts = brazilDateParts(date);
  return parts
    ? `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`
    : "";
}


const CPF_FORMATTED_SOURCE = `${groupPattern(3, true)}${OPTIONAL_SPACE}\\.${OPTIONAL_SPACE}${groupPattern(3, true)}${OPTIONAL_SPACE}\\.${OPTIONAL_SPACE}${groupPattern(3, true)}${OPTIONAL_SPACE}${DASH}${OPTIONAL_SPACE}${groupPattern(2, true)}`;
const CPF_FORMATTED = new RegExp(`^(?:${CPF_FORMATTED_SOURCE})$`, 'u');
/** CPF values remain strings, including leading zeroes. */
export function normalizeCpf(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (/^\d{11}$/.test(v)) return v;
  if (!CPF_FORMATTED.test(v)) return '';
  return v.replace(/\D/g, '');
}
export function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (!cpf || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let n = 9; n <= 10; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
    const digit = (sum * 10 % 11) % 10;
    if (digit !== Number(cpf[n])) return false;
  }
  return true;
}
export function formatCpf(value) {
  const cpf = normalizeCpf(value);
  return cpf ? `${cpf.slice(0,3)}.${cpf.slice(3,6)}.${cpf.slice(6,9)}-${cpf.slice(9)}` : '';
}
export function normalizeTaxId(value) { return normalizeCpf(value) || normalizeCnpj(value); }
export function isValidTaxId(value) { return isValidCpf(value) || isValidCnpj(value); }
export function formatTaxId(value) { return formatCpf(value) || formatCnpj(value); }
export function extractCpfs(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  for (const match of text.matchAll(new RegExp(`${CPF_FORMATTED_SOURCE}|\\d{11}`, 'gu'))) {
    const start = match.index, end = start + match[0].length;
    if (!hasTokenBoundaries(text, start, end) || !isValidCpf(match[0])) continue;
    // Compact numbers require an explicit adjacent CPF label; never slice CNPJs.
    if (!match[0].includes('.') && !/\bCPF(?:\s*\/\s*CNPJ)?\s*[:：-]?\s*$/iu.test(text.slice(Math.max(0,start-24),start))) continue;
    const cpf = normalizeCpf(match[0]);
    found.push({cpf, cnpj:cpf, taxId:cpf, type:'CPF', formatted:formatCpf(cpf), start,end,context:occurrenceContext(text,start,end)});
  }
  return found;
}
// cnpj remains a compatibility key for existing panel/receipt messages.
export function extractTaxIds(text) {
  const companies = extractCnpjs(text).map(x=>({...x,taxId:x.cnpj,type:'CNPJ'}));
  return [...companies,...extractCpfs(text).filter(x=>!companies.some(c=>x.start<c.end && x.end>c.start))].sort((a,b)=>a.start-b.start);
}
