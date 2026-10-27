import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCnpjs } from '../lib/core.js';
import { identifySupplierNames, supplierNameKey } from '../lib/suppliers.js';
import { htmlDocumentContent, mergeCandidates } from '../lib/documents.js';
import { readDocument } from '../lib/scanner.js';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { ({ JSDOM } = await import(new URL('../../crc-test-tools/node_modules/jsdom/lib/api.js', import.meta.url))); }

const FIRST = '12.345.678/0001-95';
const SECOND = '00.000.000/0001-91';
const ALPHANUMERIC = '12.ABC.345/01DE-35';
const COMPANY = 'Água & Sol Comércio Ltda.';
const URL_SEI = 'https://www.sei.mg.gov.br/sei/controlador.php?acao=documento_visualizar&id_procedimento=42&id_documento=100';
const namesFrom = text => identifySupplierNames(text, extractCnpjs(text));

function htmlText(html) {
  const dom = new JSDOM('');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
  try { return htmlDocumentContent(html, URL_SEI, '100', '42').text; }
  finally {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
    dom.window.close();
  }
}

test('explicit legal-name fields work before and after the CNPJ on one line or adjacent lines', () => {
  for (const text of [
    `Razão Social: ${COMPANY}\nCNPJ: ${FIRST}`,
    `CNPJ: ${FIRST}\nNome Empresarial: ${COMPANY}`,
    `Razão Social: ${COMPANY}; CNPJ: ${FIRST}`,
    `CNPJ ${FIRST} Razão Social ${COMPANY}`,
    `Nome Empresarial\n${COMPANY}\nCNPJ\n${FIRST}`,
  ]) {
    const [found] = namesFrom(text);
    assert.equal(found.supplierName, COMPANY, text);
    assert.equal(found.supplierNameSource, 'document');
  }
});

test('enrichment leaves source text, offsets, contexts, order and input occurrences unchanged', () => {
  const text = `Razão Social: ${COMPANY}\nCNPJ: ${FIRST}\n\nMencionado novamente: ${FIRST}`;
  const original = extractCnpjs(text);
  const snapshot = structuredClone(original);
  const found = identifySupplierNames(text, original);
  assert.deepEqual(original, snapshot);
  assert.equal(found.length, 2);
  for (let index = 0; index < found.length; index++) {
    assert.notEqual(found[index], original[index]);
    const { supplierName, supplierNameSource, ...rest } = found[index];
    assert.deepEqual(rest, original[index]);
    assert.equal(text.slice(found[index].start, found[index].end), FIRST);
  }
  assert.equal(found[1].supplierName, undefined, 'A repeated mention does not borrow a label from an earlier paragraph');
});

test('multiple suppliers in separate forms receive only their own explicitly labeled names', () => {
  const text = `CONTRATANTE\nRazão Social: Administração de Teste S.A.\nCNPJ: ${FIRST}\n\nFORNECEDOR\nCNPJ: ${SECOND}\nNome Empresarial: ${COMPANY}`;
  const found = namesFrom(text);
  assert.deepEqual(found.map(item => item.supplierName), ['Administração de Teste S.A.', COMPANY]);
});

test('mixed or adjacent entity blocks without clear structure remain unnamed', () => {
  for (const text of [
    `CNPJ: ${FIRST}\nRazão Social: ${COMPANY}\nCNPJ: ${SECOND}`,
    `Razão Social: ${COMPANY}\nCNPJ: ${FIRST}\nCNPJ: ${SECOND}`,
    `Razão Social: Empresa Primeira Ltda.\nCNPJ: ${FIRST}\nRazão Social: Empresa Segunda Ltda.\nCNPJ: ${SECOND}`,
    `Razão Social: Empresa Primeira Ltda. CNPJ: ${FIRST} Razão Social: Empresa Segunda Ltda. CNPJ: ${SECOND}`,
  ]) assert.ok(namesFrom(text).every(item => !item.supplierName), text);
});

test('ordinary nearby prose and document subjects never supply a company name', () => {
  for (const text of [
    `${COMPANY}\nCNPJ: ${FIRST}`,
    `Assunto: ${COMPANY}\nCNPJ: ${FIRST}`,
    `No documento a Razão Social: ${COMPANY} foi mencionada.\nCNPJ: ${FIRST}`,
    `Razão Social: ${COMPANY}\nDestinatário: Outra pessoa\nCNPJ: ${FIRST}`,
  ]) assert.equal(namesFrom(text)[0].supplierName, undefined, text);
});

test('trade names, address values and missing-value markers do not become legal names', () => {
  for (const name of ['Rua das Flores, 100', 'Av. Brasil 200', 'Endereço: Rua Um', 'Não informado', 'Não consta', 'contato@example.org']) {
    assert.equal(namesFrom(`CNPJ: ${FIRST}\nRazão Social: ${name}`)[0].supplierName, undefined, name);
  }
  assert.equal(namesFrom(`CNPJ: ${FIRST}\nNome Fantasia: Loja da Esquina`)[0].supplierName, undefined);
  assert.equal(namesFrom(`Razão Social:\nNome Fantasia: Loja da Esquina\nCNPJ: ${FIRST}`)[0].supplierName, undefined);
});

test('a following trade-name or address field is excluded from an otherwise explicit legal name', () => {
  const [found] = namesFrom(`CNPJ: ${FIRST}\nRazão Social: ${COMPANY} Nome Fantasia: Loja Solar Endereço: Rua Um`);
  assert.equal(found.supplierName, COMPANY);
});

test('alphanumeric CNPJs retain their legal-name association', () => {
  const [found] = namesFrom(`Nome Empresarial: Tecnologia Exemplo S.A.\nCNPJ: ${ALPHANUMERIC}`);
  assert.equal(found.cnpj, '12ABC34501DE35');
  assert.equal(found.supplierName, 'Tecnologia Exemplo S.A.');
});

test('HTML field tables preserve cell boundaries and accept values before or after the CNPJ field', () => {
  for (const html of [
    `<table><tr><td>Razão Social</td><td><p>${COMPANY}</p></td></tr><tr><td>CNPJ</td><td>${FIRST}</td></tr></table>`,
    `<table><tr><td>CNPJ</td><td>${FIRST}</td><td>Nome Empresarial</td><td>${COMPANY}</td></tr></table>`,
  ]) {
    const text = htmlText(html);
    assert.ok(text.includes('\t'));
    assert.equal(namesFrom(text)[0].supplierName, COMPANY, text);
  }
});

test('HTML supplier tables use labeled columns for each row, including reverse column order and indented source', () => {
  for (const reverse of [false, true]) {
    const row = (left, right, tag = 'td') => `\n  <tr>\n    <${tag}>${reverse ? right : left}</${tag}>\n    <${tag}>${reverse ? left : right}</${tag}>\n  </tr>\n`;
    const text = htmlText(`<table><thead>${row('Razão Social', 'CNPJ', 'th')}</thead><tbody>${row(COMPANY, FIRST)}${row('Empresa de Exemplo S.A.', SECOND)}</tbody></table>`);
    assert.deepEqual(namesFrom(text).map(item => item.supplierName), [COMPANY, 'Empresa de Exemplo S.A.'], text);
  }
});

test('unnamed and malformed table columns cannot borrow the previous row name', () => {
  for (const html of [
    `<table><tr><th>Nome Fantasia</th><th>CNPJ</th></tr><tr><td>Loja Solar</td><td>${FIRST}</td></tr></table>`,
    `<table><tr><th>Razão Social</th><th>CNPJ</th></tr><tr><td>${COMPANY}</td><td>${FIRST}</td></tr><tr><td></td><td>${SECOND}</td></tr></table>`,
    `<table><tr><th>Razão Social</th><th>CNPJ</th></tr><tr><td>${COMPANY}</td><td>${FIRST}</td></tr><tr><td>${SECOND}</td></tr></table>`,
  ]) {
    const found = namesFrom(htmlText(html));
    assert.equal(found.at(-1).supplierName, undefined);
  }
});

test('mergeCandidates groups case, accent and whitespace variants without inventing names for unknown suppliers', () => {
  const named = namesFrom(`Razão Social: ${COMPANY}\nCNPJ: ${FIRST}`)[0];
  const candidates = mergeCandidates([
    { ...named, documentId: '1' },
    { ...named, supplierName: 'AGUA & SOL   COMERCIO LTDA.', documentId: '2' },
    { ...extractCnpjs(SECOND)[0], documentId: '3' },
  ]);
  assert.equal(candidates[0].supplierName, COMPANY);
  assert.equal(candidates[0].supplierNameSource, 'document');
  assert.equal(candidates[0].nameConflict, false);
  assert.equal(candidates[0].occurrences.length, 2);
  assert.equal(candidates[1].supplierName, '');
  assert.equal(candidates[1].supplierNameSource, '');
  assert.equal(candidates[1].nameConflict, false);
  assert.equal(supplierNameKey('  ÁGUA\n& SOL '), 'AGUA & SOL');
});

test('different legal names for the same CNPJ produce a conflict rather than choosing one', () => {
  const original = extractCnpjs(FIRST)[0];
  const [candidate] = mergeCandidates([
    { ...original, documentId: '1', supplierName: COMPANY, supplierNameSource: 'document' },
    { ...original, documentId: '2', supplierName: 'Outra Empresa Ltda.', supplierNameSource: 'document' },
  ]);
  assert.equal(candidate.supplierName, '');
  assert.equal(candidate.supplierNameSource, '');
  assert.equal(candidate.nameConflict, true);
  assert.equal(candidate.occurrences.length, 2);
});

test('two conflicting legal-name fields surrounding one CNPJ are flagged as ambiguous', () => {
  const [candidate] = mergeCandidates(namesFrom(`Razão Social: Primeira Empresa Ltda.\nCNPJ: ${FIRST}\nNome Empresarial: Segunda Empresa Ltda.`));
  assert.equal(candidate.supplierName, '');
  assert.equal(candidate.nameConflict, true);
});

test('scanner document reading enriches source occurrences and retains document attribution', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const text = `CNPJ: ${FIRST}\nRazão Social: ${COMPANY}`;
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    tabs: { get: async () => ({ id: 7, url: URL_SEI }) },
    scripting: { executeScript: async request => {
      assert.equal(request.target.tabId, 7);
      assert.deepEqual(request.target.frameIds, [0]);
      return [{ frameId: 0, result: { ok: true, text, mime: 'text/plain', url: URL_SEI } }];
    } },
  } });
  try {
    const result = await readDocument({ tabId: 7, processId: '42', unitId: '', origin: new URL(URL_SEI).origin }, { id: '100', label: 'Ficha do fornecedor', url: URL_SEI, frameId: 0 });
    assert.equal(result.occurrences[0].supplierName, COMPANY);
    assert.equal(result.occurrences[0].documentId, '100');
    assert.equal(result.occurrences[0].documentLabel, 'Ficha do fornecedor');
    assert.equal(result.occurrences[0].documentUrl, URL_SEI);
    assert.deepEqual(result.warnings, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  }
});
