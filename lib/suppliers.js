import { normalizeCnpj } from './core.js';

const NAME_LABEL = String.raw`(?:raz[aã]o\s+social|nome\s+empresarial)`;
const CNPJ_LABEL = String.raw`\bC\s*\.?\s*N\s*\.?\s*P\s*\.?\s*J\b\.?`;
const NEXT_FIELD = new RegExp(String.raw`\b(?:${NAME_LABEL}|${CNPJ_LABEL}|nome\s+fantasia|endere[cç]o|inscri[cç][aã]o\s+(?:estadual|municipal)|CEP|CPF|bairro|munic[ií]pio|cidade|telefone|e-?mail|contato|UF)\b|\b(?:assunto|objeto|fornecedor|contratante|contratad[oa]|emitente|destinat[aá]rio|representante)\s*:`, 'iu');
const ONLY_SEPARATORS = /^[\s:;|,–—-]*$/u;

/** Comparison key only: spelling/case/spacing differences are not conflicts. */
export function supplierNameKey(value) {
  return typeof value === 'string' ? value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim().toUpperCase() : '';
}

function cleanName(value) {
  const name = String(value || '').replace(/\s+/gu, ' ').replace(/^[\s:;|=–—-]+|[\s;|]+$/gu, '').trim();
  if (name.length < 3 || name.length > 180 || (name.match(/\p{L}/gu) || []).length < 2) return '';
  if (/@|:\/\/|\b\d{5}-?\d{3}\b|\b\d{2}\/\d{2}\/\d{4}\b/u.test(name)) return '';
  if (/^(?:rua|avenida|av\.?|rodovia|estrada|travessa|alameda|pra[cç]a|endere[cç]o|bairro|CEP|CNPJ|CPF|nome\s+fantasia|raz[aã]o\s+social|nome\s+empresarial|assunto|objeto|telefone|e-?mail|munic[ií]pio|cidade)\b/iu.test(name)) return '';
  if (/^(?:n[aã]o\s+(?:informad[oa]|consta|identificad[oa]|se\s+aplica)|sem\s+(?:informa[cç][aã]o|identifica[cç][aã]o)|desconhecid[oa]|ignorado|ausente|n\/?a)$/iu.test(name)) return '';
  // Another labeled field in the same cell is not part of a company name.
  if (NEXT_FIELD.test(name)) return '';
  return name;
}

function ranges(text) {
  let start = 0;
  return text.split('\n').map(value => {
    const row = { start, end: start + value.length, text: value };
    start = row.end + 1;
    return row;
  });
}

function inRange(occurrences, start, end) {
  return occurrences.filter(item => item.start >= start && item.end <= end);
}

function distinctCnpjs(occurrences) { return new Set(occurrences.map(item => item.cnpj)); }

function cnpjLabelStart(text, occurrence) {
  const from = Math.max(0, occurrence.start - 64);
  const before = text.slice(from, occurrence.start);
  const match = before.match(new RegExp(`${CNPJ_LABEL}[\\s:=–—-]*(?:n[º°o]\\.?\\s*)?$`, 'iu'));
  if (!match || /\n[\t \r]*\n/u.test(match[0])) return -1;
  return from + match.index;
}

function nameFields(text, rows, occurrences) {
  const result = [];
  for (const label of text.matchAll(new RegExp(`\\b${NAME_LABEL}\\b`, 'giu'))) {
    const row = rows.find(item => label.index >= item.start && label.index <= item.end);
    const before = text.slice(row?.start || 0, label.index);
    const precedingCnpj = occurrences.find(item => item.end <= label.index && item.start >= (row?.start || 0) && ONLY_SEPARATORS.test(text.slice(item.end, label.index)));
    // A heading inside a prose sentence does not introduce a supplier field.
    if (before.trim() && !/[\t|;][ ]*$/u.test(before) && !precedingCnpj) continue;
    let start = label.index + label[0].length;
    const prefix = text.slice(start).match(/^[ \r:：=–—-]*/u)[0];
    start += prefix.length;
    // A standalone label may have its value in the next cell or next line.
    if (text[start] === '\t' || text[start] === '\n') {
      start++;
      start += text.slice(start).match(/^[ \r]*/u)[0].length;
    }
    const boundary = text.slice(start).search(/[\n\t|]/u);
    let end = boundary < 0 ? text.length : start + boundary;
    const followingField = text.slice(start, end).match(NEXT_FIELD);
    if (followingField) end = start + followingField.index;
    const raw = text.slice(start, end);
    const name = cleanName(raw);
    if (!name) continue;
    const trailing = raw.match(/[\s;|,–—-]*$/u)[0].length;
    result.push({ start: label.index, valueStart: start, end: end - trailing, name });
  }
  return result;
}

function addTableNames(text, rows, occurrences, add) {
  let header = null;
  for (const row of rows) {
    if (!row.text.trim() || !row.text.includes('\t')) { header = null; continue; }
    let offset = row.start;
    const cells = row.text.split('\t').map(value => {
      const cell = { text: value.trim(), start: offset, end: offset + value.length };
      offset = cell.end + 1;
      return cell;
    });
    while (cells.at(-1)?.text === '') cells.pop();
    const rowOccurrences = inRange(occurrences, row.start, row.end);
    const nameColumns = cells.flatMap((cell, index) => /^(?:RAZAO SOCIAL|NOME EMPRESARIAL)$/.test(supplierNameKey(cell.text)) ? [index] : []);
    const cnpjColumns = cells.flatMap((cell, index) => /^CNPJ$/.test(supplierNameKey(cell.text).replace(/[. ]/g, '')) ? [index] : []);
    if (!rowOccurrences.length && nameColumns.length === 1 && cnpjColumns.length === 1) {
      header = { name: nameColumns[0], cnpj: cnpjColumns[0], width: cells.length };
      continue;
    }
    if (!header || cells.length !== header.width) { header = null; continue; }
    const cnpjCell = cells[header.cnpj];
    const cnpj = normalizeCnpj(cnpjCell.text);
    const matching = rowOccurrences.filter(item => item.start >= cnpjCell.start && item.end <= cnpjCell.end && item.cnpj === cnpj);
    const name = cleanName(cells[header.name].text);
    if (name && matching.length === 1 && distinctCnpjs(rowOccurrences).size === 1) add(matching[0], name);
  }
}

/**
 * Enrich copies of CNPJ occurrences using explicit legal-name fields only.
 * Offsets and excerpts refer to the original text and remain unchanged.
 *
 * Accepted evidence: labeled adjacent fields on one line; adjacent fields in
 * a paragraph containing one distinct CNPJ; or tab-separated table columns
 * explicitly headed CNPJ and Razão Social/Nome Empresarial. Tables extracted
 * from HTML retain their cell boundaries. Ambiguous prose, trade names and
 * paragraphs mixing entities deliberately receive no inferred name.
 */
export function identifySupplierNames(text, occurrences) {
  const output = occurrences.map(item => ({ ...item }));
  if (typeof text !== 'string' || !text || !output.length) return output;
  const rows = ranges(text);
  const fields = nameFields(text, rows, output);
  const names = new Map();
  const add = (occurrence, name) => {
    if (!names.has(occurrence)) names.set(occurrence, new Map());
    names.get(occurrence).set(supplierNameKey(name), name);
  };
  addTableNames(text, rows, output, add);
  const paragraphs = [];
  let start = 0;
  for (const boundary of text.matchAll(/\n[\t \r]*\n/gu)) {
    paragraphs.push({ start, end: boundary.index });
    start = boundary.index + boundary[0].length;
  }
  paragraphs.push({ start, end: text.length });
  for (const occurrence of output) {
    const labelStart = cnpjLabelStart(text, occurrence);
    if (labelStart < 0) continue;
    const row = rows.find(item => occurrence.start >= item.start && occurrence.end <= item.end);
    const paragraph = paragraphs.find(item => occurrence.start >= item.start && occurrence.end <= item.end);
    for (const field of fields) {
      const sameRow = row && field.start >= row.start && field.end <= row.end && distinctCnpjs(inRange(output, row.start, row.end)).size === 1;
      const sameParagraph = paragraph && field.start >= paragraph.start && field.end <= paragraph.end && distinctCnpjs(inRange(output, paragraph.start, paragraph.end)).size === 1;
      if (!sameRow && !sameParagraph) continue;
      const gap = field.end <= labelStart ? text.slice(field.end, labelStart) : occurrence.end <= field.start ? text.slice(occurrence.end, field.start) : null;
      if (gap === null || gap.length > 80 || (gap.match(/\n/g) || []).length > 2 || !ONLY_SEPARATORS.test(gap)) continue;
      add(occurrence, field.name);
    }
  }
  for (const occurrence of output) {
    const matches = names.get(occurrence);
    if (matches?.size === 1) {
      occurrence.supplierName = [...matches.values()][0];
      occurrence.supplierNameSource = 'document';
    } else if (matches?.size > 1) {
      occurrence.nameConflict = true;
    }
  }
  return output;
}
