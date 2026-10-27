import { normalizeTaxId, isValidTaxId, formatTaxId } from './core.js';
/*
 * Public CAGEF adapter. Protocol verified against the official ZK application.
 * All desktop, widget and download identifiers are discovered in responses.
 * ZK responses contain JavaScript literals; this file never evaluates them.
 */

const SOURCE_URL = 'https://www.cagef.mg.gov.br/fornecedor-web';
const HOSTS = new Set(['www.cagef.mg.gov.br', 'cagef.mg.gov.br']);
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;

function problem(message, code = 'CAGEF_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cancelled() {
  const error = new Error('Consulta ao CAGEF cancelada.');
  error.name = 'AbortError';
  return error;
}

function assertAllowedUrl(value, relativeTo = SOURCE_URL) {
  let url;
  try { url = new URL(value, relativeTo); } catch {
    throw problem('O CAGEF retornou um endereço inválido.', 'CAGEF_PROTOCOL');
  }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password
      || (url.port && url.port !== '443')
      || !/^\/fornecedor-web(?:[;/]|$)/.test(url.pathname)) {
    throw problem('O CAGEF retornou um endereço fora do serviço oficial esperado.', 'CAGEF_UNSAFE_URL');
  }
  return url.href;
}

function quoted(source, at) {
  const quote = source[at];
  if (quote !== "'" && quote !== '"') throw problem('Resposta inesperada do CAGEF.', 'CAGEF_PROTOCOL');
  let value = '';
  for (let i = at + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === quote) return { value, end: i + 1 };
    if (char !== '\\') { value += char; continue; }
    i += 1;
    const escaped = source[i];
    if (escaped === 'x' || escaped === 'u') {
      const length = escaped === 'x' ? 2 : 4;
      const hex = source.slice(i + 1, i + 1 + length);
      if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) {
        throw problem('Resposta inesperada do CAGEF.', 'CAGEF_PROTOCOL');
      }
      value += String.fromCharCode(parseInt(hex, 16));
      i += length;
    } else if (escaped === '\n') {
      // JavaScript line continuation, present in some ZK responses.
    } else if (escaped === '\r') {
      if (source[i + 1] === '\n') i += 1;
    } else {
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
    }
  }
  throw problem('O CAGEF retornou uma resposta incompleta.', 'CAGEF_PROTOCOL');
}

function skipComment(source, at) {
  if (source.slice(at, at + 2) === '//') {
    const end = source.indexOf('\n', at + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source.slice(at, at + 2) === '/*') {
    const end = source.indexOf('*/', at + 2);
    if (end < 0) throw problem('Resposta incompleta do CAGEF.', 'CAGEF_PROTOCOL');
    return end + 2;
  }
  return at;
}

function closing(source, at) {
  const pairs = { '[': ']', '{': '}', '(': ')' };
  const stack = [pairs[source[at]]];
  if (!stack[0]) throw problem('Resposta inesperada do CAGEF.', 'CAGEF_PROTOCOL');
  for (let i = at + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "'" || char === '"') { i = quoted(source, i).end - 1; continue; }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) { i = afterComment - 1; continue; }
    if (pairs[char]) {
      if (stack.length > 100) throw problem('Resposta excessivamente complexa do CAGEF.', 'CAGEF_PROTOCOL');
      stack.push(pairs[char]);
    } else if (char === ']' || char === '}' || char === ')') {
      if (stack.pop() !== char) throw problem('O formato da resposta do CAGEF mudou.', 'CAGEF_PROTOCOL');
      if (!stack.length) return i;
    }
  }
  throw problem('O CAGEF retornou uma resposta incompleta.', 'CAGEF_PROTOCOL');
}

function parts(source, start, end) {
  const result = [];
  let first = start;
  for (let i = start; i < end; i += 1) {
    const char = source[i];
    if (char === "'" || char === '"') { i = quoted(source, i).end - 1; continue; }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) { i = afterComment - 1; continue; }
    if (char === '[' || char === '{' || char === '(') { i = closing(source, i); continue; }
    if (char === ',') { result.push([first, i]); first = i + 1; }
  }
  result.push([first, end]);
  return result;
}

function simpleValue(source) {
  const value = source.trim();
  if (value[0] === "'" || value[0] === '"') return quoted(value, 0).value;
  // Decode only a single inert ZK widget reference; never evaluate literals.
  if (value[0] === '{' && value.at(-1) === '}') {
    const match = /^\{\s*(?:\$u|"\$u"|'\$u')\s*:\s*/.exec(value);
    if (match && ["'", '"'].includes(value[match[0].length])) {
      const ref = quoted(value, match[0].length);
      if (/^\s*\}$/.test(value.slice(ref.end))) return { $u: ref.value };
    }
    return undefined;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function attributes(source, start, end) {
  const result = Object.create(null);
  for (const [from, to] of parts(source, start + 1, end)) {
    const part = source.slice(from, to);
    const match = /^\s*([\w$]+)\s*:\s*([\s\S]*)$/.exec(part);
    if (match) result[match[1]] = simpleValue(match[2]);
  }
  return result;
}

function widgets(source) {
  const result = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "'" || source[i] === '"') { i = quoted(source, i).end - 1; continue; }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) { i = afterComment - 1; continue; }
    if (source[i] !== '[') continue;
    const head = /^\[\s*(['"])((?:zul|zkmax)\.[\w.]+)\1\s*,\s*(['"])([\w-]+)\3\s*,\s*\{/.exec(source.slice(i));
    if (!head) continue;
    const attrsStart = i + head[0].length - 1;
    const attrsEnd = closing(source, attrsStart);
    const end = closing(source, i);
    const args = parts(source, i + 1, end);
    const children = args[4];
    result.push({
      type: head[2], uuid: head[4], attrs: attributes(source, attrsStart, attrsEnd),
      start: i, end, childrenStart: children?.[0] ?? end, childrenEnd: children?.[1] ?? end,
    });
    if (result.length > 2500) throw problem('Resposta excessivamente grande do CAGEF.', 'CAGEF_PROTOCOL');
  }
  return result;
}

function byId(nodes, id) { return nodes.find(node => node.attrs.id === id); }
function need(node, label) {
  if (!node) throw problem(`Não foi possível localizar ${label} no CAGEF. O portal pode ter mudado.`, 'CAGEF_PROTOCOL');
  return node;
}
function inside(node, parent) { return node.start > parent.childrenStart && node.end < parent.childrenEnd; }
function normalizeLabel(text) { return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
function cleanText(text) { return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700); }

function commands(source, wanted) {
  const found = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "'" || source[i] === '"') { i = quoted(source, i).end - 1; continue; }
    const afterComment = skipComment(source, i);
    if (afterComment !== i) { i = afterComment - 1; continue; }
    if (source[i] !== '[') continue;
    let cursor = i + 1;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
    if (source[cursor] !== "'" && source[cursor] !== '"') continue;
    const key = quoted(source, cursor);
    if (!wanted.has(key.value)) continue;
    const args = parts(source, i + 1, closing(source, i));
    if (args.length < 2) continue;
    const raw = source.slice(...args[1]).trim();
    if (raw[0] === '[') {
      found.push({ name: key.value, args: parts(raw, 1, closing(raw, 0)).map(range => simpleValue(raw.slice(...range))) });
    }
  }
  return found;
}

function serverMessage(source) {
  const msgs = commands(source, new Set(['alert', 'wrongValue', 'showNotification', 'showWrongValue']));
  for (const command of msgs) {
    const values = command.name.toLowerCase().includes('wrongvalue') ? command.args.slice(1) : command.args;
    const text = values.find(value => typeof value === 'string' && value.trim());
    if (text) return cleanText(text);
  }
  const nodes = widgets(source);
  const box = nodes.find(node => /messagebox/i.test(node.type) || /msgbox/i.test(node.attrs.id ?? ''));
  if (box) return cleanText(nodes.filter(node => inside(node, box) && node.type === 'zul.wgt.Label').map(node => node.attrs.value ?? node.attrs.label ?? '').join(' '));
  return '';
}

function desktop(source) {
  const marker = source.indexOf('zkmx(');
  if (marker < 0) {
    throw problem('A área pública do CAGEF não respondeu como esperado. Abra o portal e verifique se está disponível.', 'CAGEF_UNAVAILABLE');
  }
  const start = source.indexOf('[', marker);
  const end = closing(source, start);
  const args = parts(source, start + 1, end);
  if (!args[2]) throw problem('Não foi possível iniciar a consulta pública ao CAGEF.', 'CAGEF_PROTOCOL');
  const raw = source.slice(...args[2]).trim();
  const props = attributes(raw, 0, closing(raw, 0));
  if (typeof props.dt !== 'string' || typeof props.uu !== 'string') {
    throw problem('Não foi possível identificar a sessão pública do CAGEF.', 'CAGEF_PROTOCOL');
  }
  return { id: props.dt, endpoint: assertAllowedUrl(props.uu), nodes: widgets(source.slice(start, end + 1)) };
}

async function limitedBody(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw problem('O arquivo do CAGEF ultrapassa o limite de 20 MB.', 'CAGEF_SIZE_LIMIT');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw problem('A resposta do CAGEF excedeu o limite permitido.', 'CAGEF_SIZE_LIMIT');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw problem('A resposta do CAGEF excedeu o limite permitido.', 'CAGEF_SIZE_LIMIT');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function asBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Open an independent ZK desktop and locate exactly one matching public row.
// Issuance deliberately requires the CRC control before performing the search;
// name lookup is also valid for suppliers that cannot issue a CRC.
async function querySupplier(cnpj, { onProgress, signal, fetchImpl = fetch } = {}, requireCrc = false) {
  const normalized = normalizeTaxId(cnpj);
  if (!isValidTaxId(normalized)) throw problem('Informe um CPF ou CNPJ completo e válido.', 'CAGEF_CNPJ');
  if (signal?.aborted) throw cancelled();
  const masked = formatTaxId(normalized);
  const isCpf = normalized.length === 11;
  const progress = message => { try { onProgress?.(message); } catch { /* UI updates do not affect the request. */ } };

  async function request(url, body, pdf = false) {
    if (signal?.aborted) throw cancelled();
    const checked = assertAllowedUrl(url);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(checked, {
        method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
        signal: controller.signal,
        ...(body ? { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } } : {}),
      });
      if (response.url) assertAllowedUrl(response.url);
      if (!response.ok) throw problem(`O CAGEF respondeu com erro HTTP ${response.status}. Tente novamente mais tarde.`, 'CAGEF_HTTP');
      const bytes = await limitedBody(response, pdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES);
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw problem('O CAGEF demorou mais de 45 segundos para responder. Tente novamente.', 'CAGEF_TIMEOUT');
      if (pdf) {
        if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
          throw problem('O CAGEF não retornou um PDF válido. O documento não foi preparado para inclusão no SEI.', 'CAGEF_NOT_PDF');
        }
        return bytes;
      }
      const text = new TextDecoder('utf-8').decode(bytes);
      if (/Request Rejected|Access Denied|Acesso negado/i.test(text)) {
        throw problem('O portal CAGEF bloqueou a consulta. Abra a área pública para verificar o acesso.', 'CAGEF_BLOCKED');
      }
      return text;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw problem('O CAGEF demorou mais de 45 segundos para responder. Tente novamente.', 'CAGEF_TIMEOUT');
      if (error.code) throw error;
      throw problem('Não foi possível acessar o CAGEF. Verifique a conexão e a disponibilidade do portal.', 'CAGEF_NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  progress('Abrindo a consulta pública do CAGEF…');
  const initial = desktop(await request(SOURCE_URL));
  async function send(events) {
    const body = new URLSearchParams({ dtid: initial.id });
    events.forEach(([name, uuid, data], index) => {
      body.set(`cmd_${index}`, name);
      body.set(`uuid_${index}`, uuid);
      body.set(`data_${index}`, JSON.stringify(data));
    });
    return request(initial.endpoint, body.toString());
  }
  const menu = need(byId(initial.nodes, 'consultaFornecedoresItemMenu'), 'a consulta de fornecedores');
  const query = widgets(await send([['onClick', menu.uuid, { which: 1 }]]));
  const input = need(byId(query, isCpf ? 'cpfBox' : 'cnpjBox'), isCpf ? 'o campo CPF' : 'o campo CNPJ');
  if (isCpf) {
    const group = need(byId(query, 'tipoPessoa'), 'a seleção do tipo de pessoa');
    const radio = need(query.find(node => node.type === 'zul.wgt.Radio' && inside(node, group) && normalizeLabel(node.attrs.label) === 'pessoa fisica'), 'a opção Pessoa Física');
    const switched = await send([['onCheck', radio.uuid, { '': true }]]);
    const updates = commands(switched, new Set(['setAttr']));
    if (!updates.some(({ args }) => args[0]?.$u === input.uuid && args[1] === 'visible' && args[2] === true)) {
      throw problem('O CAGEF não confirmou a seleção de Pessoa Física. Abra o portal para conferir.', 'CAGEF_PROTOCOL');
    }
  }
  const search = need(query.find(node => node.type === 'zul.wgt.Button' && normalizeLabel(node.attrs.label) === 'pesquisar'), 'o botão Pesquisar');
  const crc = requireCrc ? need(byId(query, 'botaoEmitirCRC'), 'o botão Emitir CRC do Fornecedor') : undefined;

  progress(`Consultando ${masked} no CAGEF…`);
  const searchText = await send([
    ['onChange', input.uuid, { value: masked, start: masked.length }],
    ['onClick', search.uuid, { which: 1 }],
  ]);
  const resultNodes = widgets(searchText);
  const list = byId(resultNodes, 'listaSelecao');
  if (!list) {
    const detail = serverMessage(searchText);
    throw problem(detail ? `CAGEF: ${detail}` : `O CAGEF não encontrou fornecedor para o CPF/CNPJ ${masked}.`, 'CAGEF_NOT_FOUND');
  }
  const headers = resultNodes.filter(node => node.type === 'zul.sel.Listheader' && inside(node, list));
  const cnpjHeaders = headers.filter(node => node.attrs.id === 'headCpfCnpj');
  if (cnpjHeaders.length !== 1) {
    throw problem('Não foi possível identificar com segurança a coluna CPF/CNPJ no CAGEF. O portal pode ter mudado.', 'CAGEF_PROTOCOL');
  }
  const cnpjColumn = headers.indexOf(cnpjHeaders[0]);
  const nameHeaders = headers.filter(node => node.attrs.id === 'headNome');
  const nameColumn = nameHeaders.length === 1 ? headers.indexOf(nameHeaders[0]) : -1;
  const rows = resultNodes.filter(node => node.type === 'zul.sel.Listitem' && inside(node, list)).map(row => ({
    row,
    cells: resultNodes.filter(node => node.type === 'zul.sel.Listcell' && inside(node, row)).map(cell => cell.attrs.label ?? ''),
  }));
  const matches = rows.filter(({ cells }) => {
    const candidate = cells[cnpjColumn];
    return String(candidate ?? '').toUpperCase().replace(/[.\-/\s]/g, '') === normalized;
  });
  if (matches.length !== 1) {
    throw problem(matches.length > 1
      ? 'O CAGEF retornou mais de um cadastro para o mesmo CPF/CNPJ. Confira o fornecedor diretamente no portal.'
      : `O CAGEF não encontrou um cadastro correspondente ao CPF/CNPJ ${masked}.`, 'CAGEF_NOT_FOUND');
  }
  const match = matches[0];
  // Never infer a supplier name from a neighboring column or another row.
  // Incomplete/ambiguous columns leave the optional name unavailable.
  const supplierName = nameColumn >= 0 && match.cells.length === headers.length
    && typeof match.cells[nameColumn] === 'string' ? cleanText(match.cells[nameColumn]) : '';
  return { normalized, supplierName, progress, request, send, list, match, crc };
}

/**
 * Look up the official supplier name by CNPJ. This stops after the public search
 * response: it never selects a supplier, issues a certificate or downloads a PDF.
 * An empty supplierName means the matching row has no unambiguous name column.
 */
export async function lookupSupplier(cnpj, options = {}) {
  const { normalized, supplierName } = await querySupplier(cnpj, options);
  return { cnpj: normalized, supplierName, sourceUrl: SOURCE_URL };
}

/**
 * Issue one original CRC through the public CAGEF application.
 * onProgress receives Portuguese status strings. generatedAt records the start
 * of issuance; prefer the PDF's printed timestamp when validating its contents.
 */
export async function generateCrc(cnpj, options = {}) {
  const { normalized, supplierName, progress, request, send, list, match, crc } = await querySupplier(cnpj, options, true);
  const selection = await send([['onSelect', list.uuid, { items: [match.row.uuid], reference: match.row.uuid, clearFirst: true, selectAll: false }]]);
  const selectionError = serverMessage(selection);
  if (selectionError) throw problem(`CAGEF: ${selectionError}`, 'CAGEF_UNAVAILABLE');

  progress('Emitindo o CRC original do fornecedor…');
  const generatedAt = new Date().toISOString();
  const emission = await send([['onClick', crc.uuid, { which: 1 }]]);
  const downloads = commands(emission, new Set(['download']));
  if (downloads.length !== 1 || typeof downloads[0].args[0] !== 'string') {
    const detail = serverMessage(emission);
    throw problem(detail ? `O CAGEF não emitiu o CRC: ${detail}`
      : 'O CAGEF não disponibilizou o CRC. Confira se o fornecedor possui Cadastro Geral vigente; o cadastro somente por unidade de compra não gera CRC.', 'CAGEF_NO_CRC');
  }
  const downloadUrl = assertAllowedUrl(downloads[0].args[0]);
  if (!new URL(downloadUrl).pathname.startsWith('/fornecedor-web/zkau/view/')) {
    throw problem('O CAGEF retornou um caminho de download diferente do esperado.', 'CAGEF_PROTOCOL');
  }
  progress('Baixando o PDF original do CRC…');
  const bytes = await request(downloadUrl, undefined, true);
  return {
    base64: asBase64(bytes), mime: 'application/pdf',
    fileName: `CRC_${normalized}_${generatedAt.slice(0, 19).replace(/[-:]/g, '')}Z.pdf`,
    generatedAt, cnpj: normalized, supplierName, sourceUrl: SOURCE_URL,
  };
}
