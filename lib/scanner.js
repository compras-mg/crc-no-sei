// SEI 5: id_protocolo identifica o processo apenas em procedimento_trabalhar.
// Em páginas de documento, id_protocolo não deve ser usado como ID de processo.
import { inspectSeiFrame, fetchSeiResource } from './sei.js';
import { extractTaxIds as extractCnpjs } from './core.js';
import { readPdf } from './pdf.js';
import { htmlDocumentContent, isSeiUrl, assertSameProcess } from './documents.js';
import { identifySupplierNames } from './suppliers.js';

export async function inject(tabId, func, args = [], frameIds) {
  return chrome.scripting.executeScript({ target: { tabId, ...(frameIds ? { frameIds } : { allFrames: true }) }, world: 'ISOLATED', func, args });
}

export async function listSeiTabs() {
  return (await chrome.tabs.query({ url: ['https://www.sei.mg.gov.br/*', 'https://sei.mg.gov.br/*'] })).filter((t) => isSeiUrl(t.url));
}

export async function inspectProcess(tabId, { expand = false, expected } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSeiUrl(tab.url)) throw new Error('Abra um processo no SEI de Minas Gerais e depois clique no ícone da extensão.');
  let raw;
  try { raw = await inject(tabId, inspectSeiFrame); }
  catch { raw = await inject(tabId, inspectSeiFrame, [], [0]); }
  const frames = raw.filter((r) => r.result && !r.result.error && isSeiUrl(r.result.url) &&
    new URL(r.result.url).origin === new URL(tab.url).origin).map((r) => ({ ...r.result, frameId: r.frameId, scriptingDocumentId: r.documentId || '' }));
  const root = frames.find((f) => f.frameId === 0);
  if (root?.processMismatch) throw new Error('A página do SEI contém identificações divergentes de processo. Reabra o processo e tente novamente.');
  const url = new URL(tab.url);
  const processId = (url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) || root?.processId || '';
  if (!processId) throw new Error('Não consegui identificar o processo. Abra sua árvore de documentos no SEI e tente Atualizar.');
  const unitId = url.searchParams.get('infra_unidade_atual') || root?.unitId || '';
  const relevant = frames.filter((f) => !f.processMismatch && (!f.processId || f.processId === processId));
  const context = {
    tabId, processId, unitId, origin: url.origin, url: tab.url,
    processNumber: relevant.find((f) => f.processNumber)?.processNumber || '',
    documents: [], frames: relevant, incompleteTree: relevant.some((f) => f.incompleteTree),
    treeWarning: '',
  };
  if (expected) assertSameProcess(context, expected);
  const documents = new Map();
  const add = (frame) => {
    for (const doc of frame.documents || []) {
      if (!doc.url || !isSeiUrl(doc.url)) continue;
      const u = new URL(doc.url);
      if (u.origin !== context.origin) continue;
      const pid = (u.searchParams.get('id_procedimento') || (u.searchParams.get('acao') === 'procedimento_trabalhar' ? u.searchParams.get('id_protocolo') : null));
      if (pid && pid !== processId) continue;
      const key = String(doc.id || doc.url);
      if (!documents.has(key)) documents.set(key, { ...doc, id: String(doc.id || key), frameId: frame.frameId });
    }
  };
  relevant.forEach(add);
  if (expand) {
    const treeSource = relevant.find((f) => f.expandedTreeUrl) || relevant.find((f) => f.treeUrl);
    const treeUrl = treeSource?.expandedTreeUrl || treeSource?.treeUrl;
    if (treeUrl) {
      try {
        const result = await fetchResource(context, { url: treeUrl, frameId: treeSource.frameId });
        if (result.text) {
          const expanded = inspectSeiFrame({ html: result.text, url: result.url || treeUrl });
          if (expanded.processId && expanded.processId !== processId) throw new Error('A árvore retornada pertence a outro processo.');
          add({ ...expanded, frameId: treeSource.frameId });
          context.incompleteTree = Boolean(expanded.incompleteTree);
          if (expanded.expandedTreeUrl && expanded.expandedTreeUrl !== treeUrl) {
            const result2 = await fetchResource(context, { url: expanded.expandedTreeUrl, frameId: treeSource.frameId });
            const fully = inspectSeiFrame({ html: result2.text || '', url: result2.url || expanded.expandedTreeUrl });
            if (fully.processId && fully.processId !== processId) throw new Error('A árvore expandida pertence a outro processo.');
            add({ ...fully, frameId: treeSource.frameId });
            context.incompleteTree = Boolean(fully.incompleteTree);
          }
        }
      } catch (error) { context.treeWarning = error.message; context.incompleteTree = true; }
    }
  }
  context.documents = [...documents.values()];
  return context;
}

export async function checkTabContext(context) {
  const current = await chrome.tabs.get(context.tabId);
  if (!isSeiUrl(current.url)) throw new Error('A aba de destino deixou de ser um processo do SEI.');
  const url = new URL(current.url);
  const pid = (url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null));
  const unit = url.searchParams.get('infra_unidade_atual');
  if (url.origin !== context.origin || (pid && pid !== context.processId) || (context.unitId && unit && context.unitId !== unit)) {
    throw new Error('O processo ou a unidade da aba do SEI mudou. Atualize o processo de destino.');
  }
  if (!pid || (context.unitId && !unit)) {
    await inspectProcess(context.tabId, { expected: context });
  }
}

export async function fetchResource(context, resource) {
  await checkTabContext(context);
  const target = new URL(resource.url);
  if (!isSeiUrl(target.href) || target.origin !== context.origin ||
      (target.searchParams.has('id_procedimento') && (target.searchParams.get('id_procedimento') || (target.searchParams.get('acao') === 'procedimento_trabalhar' ? target.searchParams.get('id_protocolo') : null)) !== context.processId) ||
      (context.unitId && target.searchParams.has('infra_unidade_atual') && target.searchParams.get('infra_unidade_atual') !== context.unitId)) {
    throw new Error('O link de leitura não pertence ao processo e à unidade selecionados.');
  }
  const results = await inject(context.tabId, fetchSeiResource, [{ url: resource.url, processId: context.processId, unitId: context.unitId, maxBytes: 20 * 1024 * 1024 }], [resource.frameId ?? 0]);
  const value = results[0]?.result;
  if (!value) throw new Error('O SEI não devolveu o conteúdo do documento.');
  if (value.error || value.ok === false) throw new Error(value.error || value.message || 'Não foi possível ler o documento.');
  return value;
}

export async function readDocument(context, descriptor, { signal } = {}) {
  const visited = new Set();
  const chunks = [];
  const warnings = [];
  let pdfPageCount = 0;
  const visit = async (url, depth = 0) => {
    if (signal?.aborted) throw new DOMException('Busca interrompida.', 'AbortError');
    if (visited.has(url)) return;
    if (depth > 4) { warnings.push('O visualizador contém mais níveis de arquivos do que esta versão consegue seguir.'); return; }
    visited.add(url);
    const response = await fetchResource(context, { url, frameId: descriptor.frameId });
    if (signal?.aborted) throw new DOMException('Busca interrompida.', 'AbortError');
    if (response.base64 && (/pdf/i.test(response.mime || '') || response.base64.startsWith('JVBER'))) {
      const pdf = await readPdf(response.base64, { signal });
      pdfPageCount += pdf.pageCount;
      for (const page of pdf.pages) chunks.push({ page: page.page, text: page.text });
      if (pdf.emptyPages.length) warnings.push(`${pdf.emptyPages.length} página(s) sem texto legível; pode ser necessária leitura manual.`);
      if (pdf.limited) warnings.push('A leitura do PDF atingiu o limite de páginas.');
    } else if (typeof response.text === 'string') {
      if (/html/i.test(response.mime || '') || /<(?:!doctype|html|body|head|div|p|table)\b/i.test(response.text)) {
        const data = htmlDocumentContent(response.text, response.url || url, descriptor.id, context.processId);
        if (data.isLogin) throw new Error('A sessão do SEI expirou ou o documento exige novo acesso.');
        if (data.text) chunks.push({ page: null, text: data.text });
        for (const embedded of data.resources) await visit(embedded, depth + 1);
      } else if (/text\/plain/i.test(response.mime || '')) chunks.push({ page: null, text: response.text });
      else warnings.push('Formato de arquivo não suportado nesta versão.');
    } else warnings.push('Formato de arquivo não suportado: a leitura automática cobre HTML, texto e PDF.');
  };
  await visit(descriptor.url);
  const occurrences = chunks.flatMap(chunk => {
    const ids = extractCnpjs(chunk.text);
    // CPF names are verified at CAGEF/CRC; a nearby name may be a representative.
    const matches = [...identifySupplierNames(chunk.text, ids.filter(x => x.type !== 'CPF')), ...ids.filter(x => x.type === 'CPF')].sort((a,b) => a.start-b.start);
    return matches.map(match => ({ ...match, documentId: descriptor.id, documentLabel: descriptor.label, documentUrl: descriptor.url, page: chunk.page }));
  });
  const textLength = chunks.reduce((n, chunk) => n + chunk.text.replace(/\s/g, '').length, 0);
  if (textLength < 30 && !warnings.length) warnings.push('Documento sem camada de texto suficiente para uma busca confiável.');
  return { occurrences, warnings, pdfPageCount, hasText: textLength >= 30 };
}

export async function scanProcess(context, { signal, onProgress, onDocument } = {}) {
  const fresh = await inspectProcess(context.tabId, { expand: true, expected: context });
  const reports = [];
  const occurrences = [];
  let stopped = false;
  for (let index = 0; index < fresh.documents.length; index++) {
    if (signal?.aborted) { stopped = true; break; }
    const doc = fresh.documents[index];
    onProgress?.({ done: index, total: fresh.documents.length, label: doc.label });
    let report;
    if (doc.cancelled || doc.canceled) report = { documentId: doc.id, label: doc.label, status: 'skipped', detail: 'Documento cancelado.' };
    else {
      try {
        const data = await readDocument(fresh, doc, { signal });
        occurrences.push(...data.occurrences);
        report = { documentId: doc.id, label: doc.label, status: data.warnings.length ? 'partial' : 'read', detail: data.warnings.join(' '), cnpjCount: data.occurrences.length, pages: data.pdfPageCount };
        onDocument?.({ ...data, descriptor: doc, report });
      } catch (error) {
        if (error.name === 'AbortError') { stopped = true; break; }
        report = { documentId: doc.id, label: doc.label, status: 'error', detail: error.message };
      }
    }
    reports.push(report);
    onProgress?.({ done: index + 1, total: fresh.documents.length, label: doc.label });
  }
  return { context: fresh, occurrences, reports, stopped, total: fresh.documents.length, incompleteTree: fresh.incompleteTree, treeWarning: fresh.treeWarning };
}
