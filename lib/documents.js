import { supplierNameKey } from './suppliers.js';

/** HTML extraction never executes page scripts or loads remote resources. */
export function htmlDocumentContent(html, baseUrl, documentId = '', expectedProcessId = '') {
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  const resources = new Set();
  const base = new URL(baseUrl);
  const origin = base.origin;
  const expectedAttachmentId = base.searchParams.get('id_anexo');
  const add = (value) => {
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return;
      const embeddedFile = url.searchParams.get('file');
      if (embeddedFile) { add(embeddedFile); return; }
      const action = url.searchParams.get('acao');
      if (!['documento_visualizar', 'documento_download_anexo'].includes(action)) return;
      const nestedProcess = url.searchParams.get('id_procedimento');
      if (expectedProcessId && nestedProcess && nestedProcess !== String(expectedProcessId)) return;
      const nestedId = url.searchParams.get('id_documento');
      const sameDocument = nestedId === String(documentId);
      const sameAttachment = expectedAttachmentId && url.searchParams.get('id_anexo') === expectedAttachmentId;
      if (documentId && !sameDocument && !sameAttachment) return;
      resources.add(url.href);
    } catch { /* A malformed or unrelated resource is not a document. */ }
  };
  for (const el of parsed.querySelectorAll('iframe[src],frame[src],embed[src],object[data]')) {
    add(el.getAttribute('src') || el.getAttribute('data'));
  }
  // The native external-document viewer sometimes exposes only a download link.
  for (const el of parsed.querySelectorAll('a[href]')) {
    try {
      const u = new URL(el.getAttribute('href'), baseUrl);
      if (u.searchParams.get('acao') === 'documento_download_anexo') add(u.href);
    } catch { /* Non-URL links, such as javascript:void(0), are ignored. */ }
  }
  // An observed URL assigned to the PDF viewer can be quoted in an inline script.
  // Read string literals only. Never eval the script or interpret its instructions.
  for (const script of parsed.querySelectorAll('script:not([src])')) {
    for (const match of script.textContent.matchAll(/['"]([^'"<>\n]*(?:documento_download_anexo)[^'"<>\n]*)['"]/g)) {
      const value = match[1].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      try {
        const u = new URL(value, baseUrl);
        add(u.href);
      } catch { /* Ignore script fragments that are not literal URLs. */ }
    }
  }
  const isLogin = Boolean(parsed.querySelector('input[type="password"]')) ||
    /(?:sess[aã]o\s+(?:expirada|encerrada)|efetue\s+(?:o\s+)?login|usu[aá]rio\s+n[aã]o\s+autenticado)/i.test(parsed.body?.textContent || '');
  for (const el of parsed.querySelectorAll('script,style,noscript,nav,header,footer,button,input,select,textarea,svg,iframe,frame,embed,object')) el.remove();
  // Source-code indentation must not turn one table row into several rows.
  for (const el of parsed.querySelectorAll('table,thead,tbody,tfoot,tr')) {
    for (const child of [...el.childNodes]) if (child.nodeType === 3 && !child.textContent.trim()) child.remove();
  }
  for (const el of parsed.querySelectorAll('br,hr')) el.replaceWith(parsed.createTextNode('\n'));
  for (const el of parsed.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,section')) el.append(parsed.createTextNode('\n'));
  // Keep table cells distinct: a CNPJ column must never borrow a legal name
  // from a neighboring supplier. Block markup inside a cell is one cell value.
  for (const el of parsed.querySelectorAll('td,th')) el.textContent = `${el.textContent.replace(/\s+/g, ' ').trim()}\t`;
  const text = (parsed.body?.textContent || '').replace(/[\u00a0 ]+/g, ' ').replace(/\n[ ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, resources: [...resources], isLogin };
}

export function isSeiUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['www.sei.mg.gov.br', 'sei.mg.gov.br'].includes(u.hostname) && !u.username && !u.password; }
  catch { return false; }
}

export function assertSameProcess(current, expected) {
  if (!current?.processId || current.processId !== expected?.processId ||
      (expected.unitId && current.unitId !== expected.unitId) ||
      (expected.origin && current.origin !== expected.origin)) {
    throw new Error('O processo ou a unidade da aba do SEI mudou. Volte ao processo de destino e clique em Atualizar antes de continuar.');
  }
}

export function mergeCandidates(occurrences) {
  const result = new Map();
  const names = new Map();
  for (const occurrence of occurrences) {
    let item = result.get(occurrence.cnpj);
    if (!item) { item = { cnpj: occurrence.cnpj, formatted: occurrence.formatted, occurrences: [] }; result.set(item.cnpj, item); }
    if (occurrence.supplierNameSource === 'document' && supplierNameKey(occurrence.supplierName)) {
      if (!names.has(item.cnpj)) names.set(item.cnpj, new Map());
      const key = supplierNameKey(occurrence.supplierName);
      if (!names.get(item.cnpj).has(key)) names.get(item.cnpj).set(key, occurrence.supplierName.replace(/\s+/g, ' ').trim());
    }
    if (!item.occurrences.some((old) => old.documentId === occurrence.documentId && old.page === occurrence.page && old.start === occurrence.start && old.manual === occurrence.manual)) item.occurrences.push(occurrence);
  }
  return [...result.values()].map(item => {
    const found = names.get(item.cnpj);
    const supplierName = found?.size === 1 ? [...found.values()][0] : '';
    const nameConflict = (found?.size || 0) > 1 || item.occurrences.some(occurrence => occurrence.nameConflict === true);
    return { ...item, supplierName: nameConflict ? '' : supplierName, supplierNameSource: supplierName && !nameConflict ? 'document' : '', nameConflict };
  });
}
