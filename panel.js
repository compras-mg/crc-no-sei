import { normalizeTaxId as normalizeCnpj, isValidTaxId as isValidCnpj, formatTaxId as formatCnpj } from './lib/core.js';
import { generateCrc, lookupSupplier } from './lib/cagef.js';
import { readPdf, inspectCrcText, base64ToBytes, buildCrcFileName } from './lib/pdf.js';
import { inject, inspectProcess, scanProcess, fetchResource, checkTabContext } from './lib/scanner.js';
import { navigateToExternalForm, prepareExternalDocument, submitPreparedExternalDocument } from './lib/sei.js';
import { mergeCandidates, htmlDocumentContent } from './lib/documents.js';

const $ = (id) => document.getElementById(id);
const state = { context: null, occurrences: [], selected: '', certificate: null, busy: '', scan: null, receipt: null, receiptKey: '', coverage: null, supplierNames: new Map(), nameServiceError: '', objectUrls: new Set(), log: [] };
const candidateRows = new Map();
let supplierLookup = null;
let supplierLookupDrain = Promise.resolve();
let embeddedTabId = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(event, detail = {}) { state.log.push({ at: new Date().toISOString(), event, ...detail }); if (state.log.length > 100) state.log.shift(); }
function notice(message, error = false) { $('notice').textContent = message || ''; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
function updateControls() {
  const busy = Boolean(state.busy);
  const unbound = embeddedTabId === null;
  $('scan').disabled = busy || !state.context;
  $('refresh-process').disabled = busy;
  $('manual-cnpj').disabled = busy || unbound;
  $('manual-form').querySelector('button').disabled = busy || unbound;
  $('generate').disabled = busy || unbound || !state.selected || Boolean(state.receipt && state.receipt.stage !== 'complete');
  $('attach').disabled = busy || !state.context || !state.certificate || Boolean(state.receipt);
  $('review-first').disabled = busy;
  $('check-receipt').disabled = busy;
  $('confirm-not-saved').disabled = busy;
  $('release-receipt').disabled = busy || !$('confirm-not-saved').checked;
  $('attach').textContent = $('review-first').checked ? 'Preencher documento externo no SEI' : 'Anexar CRC ao processo';
  for (const input of $('candidates').querySelectorAll('input')) input.disabled = busy;
  document.body.classList.toggle('busy', busy);
}
function setBusy(value) {
  state.busy = value;
  if (value) stopSupplierLookup();
  updateControls();
  if (!value) startSupplierLookup();
}

function cleanSupplierName(value) {
  return typeof value === 'string' ? value.replace(/[\s\u200B]+/gu, ' ').trim().slice(0, 700) : '';
}

function supplierIdentity(candidate) {
  const cached = state.supplierNames.get(candidate.cnpj);
  if (cached?.name) return cached;
  const name = cleanSupplierName(candidate.supplierName);
  return name ? { name, source: 'document' } : { name: '', source: '', reason: cached?.reason || state.nameServiceError };
}

function updateSupplierLabels() {
  for (const row of candidateRows.values()) {
    const identity = supplierIdentity(row.candidate);
    const loading = !identity.name && supplierLookup?.cnpj === row.candidate.cnpj;
    row.name.textContent = identity.name || (row.candidate.cnpj.length === 11 ? (loading ? 'Consultando nome…' : 'Nome não identificado') : (loading ? 'Consultando razão social…' : 'Razão social não identificada'));
    row.name.classList.toggle('unknown', !identity.name);
    row.name.title = identity.name ? '' : identity.reason || (row.candidate.nameConflict ? 'Os documentos apresentam nomes diferentes para este CPF/CNPJ.' : 'O CPF/CNPJ continua disponível para consulta e emissão do CRC.');
    const sourceLabel = { document: 'Nome no documento', cagef: 'Nome no CAGEF', crc: 'Nome no CRC' }[identity.source] || '';
    row.nameSource.textContent = sourceLabel;
    row.nameSource.hidden = !sourceLabel;
  }
  if (state.selected) {
    const candidate = candidateRows.get(state.selected)?.candidate || { cnpj: state.selected };
    const identity = supplierIdentity(candidate);
    $('selected-cnpj').textContent = `CPF/CNPJ selecionado: ${formatCnpj(state.selected)}${identity.name ? ` — ${identity.name}` : ''}`;
  }
  $('names-status').textContent = supplierLookup ? 'Buscando razões sociais no CAGEF. Você já pode escolher um fornecedor.' : '';
}

function stopSupplierLookup() {
  const job = supplierLookup;
  if (job) {
    supplierLookup = null;
    job.controller.abort();
    supplierLookupDrain = job.promise.catch(() => {});
    updateSupplierLabels();
  }
  return supplierLookupDrain;
}

function resetUnavailableNames() {
  state.nameServiceError = '';
  for (const [cnpj, result] of state.supplierNames) if (!result.name) state.supplierNames.delete(cnpj);
}

function startSupplierLookup() {
  if (supplierLookup || state.busy || !state.context || state.nameServiceError) return;
  const nextCandidate = () => {
    const pending = mergeCandidates(state.occurrences).filter(candidate => !supplierIdentity(candidate).name && !state.supplierNames.has(candidate.cnpj));
    return pending.find(candidate => candidate.cnpj === state.selected) || pending[0];
  };
  if (!nextCandidate()) return;
  const context = state.context;
  const preceding = supplierLookupDrain;
  const job = { controller: new AbortController(), cnpj: '', promise: null };
  const active = () => supplierLookup === job && !job.controller.signal.aborted && !state.busy && state.context === context;
  supplierLookup = job;
  job.promise = (async () => {
    // Finish a cancelled public request before opening another ZK desktop.
    await preceding;
    while (active()) {
      const candidate = nextCandidate();
      if (!candidate) break;
      job.cnpj = candidate.cnpj;
      updateSupplierLabels();
      try {
        await checkTabContext(context);
        if (!active()) break;
        const result = await lookupSupplier(candidate.cnpj, { signal: job.controller.signal });
        if (!active()) break;
        await checkTabContext(context);
        if (!active()) break;
        if (normalizeCnpj(result?.cnpj) !== candidate.cnpj) throw new Error('O nome retornado não corresponde ao CPF/CNPJ consultado.');
        const name = cleanSupplierName(result.supplierName);
        state.supplierNames.set(candidate.cnpj, { name, source: name ? 'cagef' : '', reason: name ? '' : 'O CAGEF não informou o nome deste fornecedor.' });
      } catch (error) {
        if (!active() || error.name === 'AbortError') break;
        state.supplierNames.set(candidate.cnpj, { name: '', source: '', reason: error.message });
        // A missing supplier affects only that CNPJ. An unavailable portal
        // pauses the queue until the next process refresh or document scan.
        if (error.code !== 'CAGEF_NOT_FOUND') {
          state.nameServiceError = error.message;
          break;
        }
      }
      updateSupplierLabels();
    }
  })().catch(() => {
    if (active()) state.nameServiceError = 'Não foi possível completar a consulta dos nomes no CAGEF.';
  }).finally(() => {
    if (supplierLookup === job) {
      supplierLookup = null;
      updateSupplierLabels();
    }
  });
  updateSupplierLabels();
}
function invalidateCertificate() {
  state.certificate = null;
  if (state.receipt?.stage === 'complete') { state.receipt = null; state.receiptKey = ''; }
  $('certificate').hidden = true;
  $('document-date').textContent = 'Data de emissão do CRC';
  $('generation-status').textContent = ''; $('attachment-status').textContent = '';
  $('success').hidden = true;
}
function clearProcessData() {
  stopSupplierLookup(); state.supplierNames.clear(); state.nameServiceError = '';
  state.occurrences = []; state.selected = ''; state.receipt = null; state.receiptKey = ''; state.coverage = null;
  invalidateCertificate(); renderCandidates();
  $('coverage').hidden = true; $('verify-receipt').hidden = true; $('release-row').hidden = true;
  $('confirm-not-saved').checked = false; $('manual-cnpj').value = ''; $('scan-progress').hidden = true;
  $('selected-cnpj').textContent = 'Selecione um CPF ou CNPJ para consultar o CAGEF.';
}
function candidateButton(cnpj) {
  state.selected = cnpj; invalidateCertificate();
  state.receipt = null; state.receiptKey = ''; $('verify-receipt').hidden = true;
  $('release-row').hidden = true; $('confirm-not-saved').checked = false;
  renderCandidates(); updateControls();
  startSupplierLookup();
}
function renderCandidates() {
  const candidates = mergeCandidates(state.occurrences);
  const present = new Set(candidates.map(candidate => candidate.cnpj));
  for (const [cnpj, row] of candidateRows) if (!present.has(cnpj)) { row.outer.remove(); candidateRows.delete(cnpj); }
  $('empty-list').hidden = candidates.length > 0;
  for (const [index, candidate] of candidates.entries()) {
    let row = candidateRows.get(candidate.cnpj);
    if (!row) {
      const outer = document.createElement('div'); outer.className = 'candidate'; outer.dataset.cnpj = candidate.cnpj;
      const label = document.createElement('label'); label.className = 'candidate-label';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'cnpj'; radio.value = candidate.cnpj;
      radio.addEventListener('change', () => candidateButton(candidate.cnpj));
      const identity = document.createElement('span'); identity.className = 'candidate-identity';
      const number = document.createElement('span'); number.className = 'candidate-cnpj'; number.textContent = candidate.formatted;
      const name = document.createElement('span'); name.className = 'candidate-name';
      identity.append(number, document.createTextNode(' — '), name);
      label.append(radio, identity);
      const meta = document.createElement('small');
      const count = document.createElement('span');
      const nameSource = document.createElement('span'); nameSource.className = 'candidate-name-source'; nameSource.hidden = true;
      meta.append(count, nameSource);
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Ver onde aparece'; details.append(summary);
      const ul = document.createElement('ul'); ul.className = 'occurrences'; details.append(ul);
      outer.append(label, meta, details);
      row = { outer, radio, name, nameSource, count, details, ul, sourceKey: '', candidate };
      candidateRows.set(candidate.cnpj, row);
    }
    row.candidate = candidate;
    row.radio.checked = state.selected === candidate.cnpj;
    row.radio.disabled = Boolean(state.busy);
    const sources = new Set(candidate.occurrences.filter((x) => !x.manual).map((x) => x.documentId));
    row.count.textContent = sources.size ? `${sources.size} documento(s) · ${candidate.occurrences.filter((x) => !x.manual).length} ocorrência(s)` : 'CPF/CNPJ informado manualmente';
    row.details.hidden = !sources.size;
    const excerpts = candidate.occurrences.filter((x) => !x.manual).slice(0, 50);
    const sourceKey = JSON.stringify(excerpts.map(({ documentId, page, start, documentLabel, documentUrl, context }) => [documentId, page, start, documentLabel, documentUrl, context]));
    if (sourceKey !== row.sourceKey) {
      row.ul.replaceChildren(); row.sourceKey = sourceKey;
      for (const source of excerpts) {
        const li = document.createElement('li'); const title = document.createElement('button'); title.type = 'button'; title.className = 'text-button occurrence-link';
        title.textContent = `${source.documentLabel || 'Documento'}${source.page ? ` · página ${source.page}` : ''}`;
        title.addEventListener('click', () => chrome.tabs.create({ url: source.documentUrl }));
        const context = document.createElement('p'); context.className = 'context'; context.textContent = source.context;
        li.append(title, context); row.ul.append(li);
      }
    }
    if ($('candidates').children[index] !== row.outer) $('candidates').insertBefore(row.outer, $('candidates').children[index] || null);
  }
  updateSupplierLabels();
}
function showProcessError(error) {
  clearProcessData();
  state.context = null;
  $('process-number').textContent = 'Abra um processo no SEI';
  $('process-detail').textContent = error?.message || 'Não foi possível conferir o processo desta aba. Clique em Atualizar para tentar novamente.';
  record('process-error', { kind: error?.name || 'Error' });
}
async function loadProcess(tabId) {
  notice(''); setBusy('process');
  try {
    if (embeddedTabId === null || tabId !== embeddedTabId) throw new Error('O assistente não está vinculado a esta aba. Clique em Atualizar.');
    const context = await inspectProcess(tabId);
    const changed = state.context && (state.context.processId !== context.processId || state.context.unitId !== context.unitId || state.context.origin !== context.origin);
    if (changed) clearProcessData();
    state.context = context;
    resetUnavailableNames();
    $('process-number').textContent = context.processNumber || `Processo aberto no SEI`;
    $('process-detail').textContent = context.processNumber ? 'A inclusão será feita nesta aba e neste processo.' : `Confira a aba do SEI. Identificador interno: ${context.processId}.`;
    record('process-ready', { hasNumber: Boolean(context.processNumber), frames: context.frames.length, visibleDocuments: context.documents.length, incompleteTree: context.incompleteTree });
    return true;
  } catch (error) {
    showProcessError(error);
    return false;
  } finally { setBusy(''); }
}

async function refreshBoundProcess() {
  notice(''); setBusy('process');
  try {
    if (embeddedTabId === null) {
      // Only the extension background can identify the tab containing this
      // privileged iframe. URL parameters never select a destination tab.
      const response = await chrome.runtime.sendMessage({ type: 'crc-panel-context' });
      if (response?.ok !== true || !Number.isInteger(response.tabId) || response.tabId < 0) {
        throw new Error(response?.error || 'Não foi possível vincular o assistente a esta aba do SEI. Clique em Atualizar.');
      }
      embeddedTabId = response.tabId;
    }
    return await loadProcess(embeddedTabId);
  } catch (error) {
    showProcessError(error);
    return false;
  } finally { setBusy(''); }
}
function showCoverage(result) {
  state.coverage = result;
  const completed = result.reports.filter((x) => x.status === 'read').length;
  const partial = result.reports.filter((x) => x.status === 'partial').length;
  const failed = result.reports.filter((x) => x.status === 'error').length;
  $('coverage').hidden = false;
  $('coverage-summary').textContent = `${result.reports.length}/${result.total} documentos analisados · ${completed} lidos${partial ? ` · ${partial} parciais` : ''}${failed ? ` · ${failed} com falha` : ''}`;
  $('coverage-list').replaceChildren();
  const add = (text) => { const li = document.createElement('li'); li.textContent = text; $('coverage-list').append(li); };
  if (result.incompleteTree) add('A árvore pode conter pastas não carregadas. Expanda-as no SEI e refaça a busca para ampliar a cobertura.');
  if (result.treeWarning) add(`Árvore: ${result.treeWarning}`);
  if (result.stopped) add('A busca foi interrompida. Os resultados já encontrados foram preservados.');
  for (const report of result.reports) add(`${report.label || 'Documento'} — ${report.status === 'read' ? `lido, ${report.cnpjCount || 0} ocorrência(s)` : report.detail || report.status}`);
}
async function scan() {
  if (!state.context) return;
  notice(''); setBusy('scan'); state.scan = new AbortController(); $('scan-progress').hidden = false;
  resetUnavailableNames();
  // Manual entries survive a rescan, but prior document excerpts are refreshed.
  state.occurrences = state.occurrences.filter((x) => x.manual); renderCandidates();
  try {
    const result = await scanProcess(state.context, {
      signal: state.scan.signal,
      onProgress: ({ done, total, label }) => { $('scan-meter').max = total || 1; $('scan-meter').value = done; $('scan-status').textContent = `${done}/${total}: ${label || 'Lendo documentos…'}`; },
      onDocument: ({ occurrences }) => { state.occurrences.push(...occurrences); renderCandidates(); },
    });
    state.context = result.context; showCoverage(result);
    $('scan-status').textContent = result.stopped ? 'Busca interrompida.' : `Busca concluída. ${mergeCandidates(state.occurrences).length} CPF/CNPJ(s) encontrado(s).`;
    if (!state.occurrences.length) notice('Nenhum CPF ou CNPJ válido foi encontrado nos documentos que puderam ser lidos. Confira a cobertura da busca ou informe o CPF/CNPJ manualmente.');
    if (!state.selected && mergeCandidates(state.occurrences).length === 1) candidateButton(state.occurrences[0].cnpj);
    record('scan-complete', { total: result.total, read: result.reports.filter((x) => x.status === 'read').length, partial: result.reports.filter((x) => x.status === 'partial').length, errors: result.reports.filter((x) => x.status === 'error').length, stopped: result.stopped, incompleteTree: result.incompleteTree });
  } catch (error) { notice(error.message, true); record('scan-error', { kind: error.name }); }
  finally { state.scan = null; setBusy(''); }
}
async function sha256(base64) {
  const digest = await crypto.subtle.digest('SHA-256', base64ToBytes(base64));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function acceptCertificate(source) {
  $('generation-status').textContent = 'Conferindo o CPF/CNPJ e a emissão impressos no PDF…';
  const pdf = await readPdf(source.base64, { maxPages: 100 });
  if (pdf.limited) throw new Error('O arquivo tem mais páginas do que o limite de conferência de um CRC. Confira o arquivo original no CAGEF.');
  const metadata = inspectCrcText(pdf.pages.map((p) => p.text).join('\n\n'), state.selected);
  if (!metadata.isCrc) {
    throw new Error(metadata.issues?.join(' ') || 'Não foi possível confirmar que o PDF é o CRC do CPF/CNPJ escolhido.');
  }
  await finishCertificate(source, metadata, pdf.pageCount);
}
async function finishCertificate(source, metadata, pageCount) {
  const fileName = buildCrcFileName(state.selected, metadata.emittedAt);
  const hash = await sha256(source.base64);
  state.certificate = { ...source, ...metadata, pageCount, fileName, sha256: hash, base64: source.base64, cnpj: state.selected };
  const printedName = cleanSupplierName(metadata.supplierName);
  const queriedName = normalizeCnpj(source.cnpj) === state.selected ? cleanSupplierName(source.supplierName) : '';
  if (printedName || queriedName) {
    state.supplierNames.set(state.selected, { name: printedName || queriedName, source: printedName ? 'crc' : 'cagef' });
    updateSupplierLabels();
  }
  $('supplier-name').textContent = metadata.supplierName || source.supplierName || 'Fornecedor identificado no CRC';
  $('certificate-cnpj').textContent = formatCnpj(state.selected);
  $('certificate-date').textContent = `${metadata.emittedAtText} (Brasília)`;
  $('certificate-file').textContent = fileName;
  $('certificate-pages').textContent = `${pageCount} página(s)`;
  $('certificate').hidden = false;
  $('document-date').textContent = metadata.documentDate;
  $('generation-status').textContent = 'CRC conferido. O PDF está pronto para ser incluído no processo.';
  record('crc-ready', { pages: pageCount, size: Math.floor(source.base64.length * 3 / 4) });
  updateControls();
}
async function generate() {
  if (!isValidCnpj(state.selected)) return;
  notice(''); invalidateCertificate(); setBusy('generate');
  try {
    await stopSupplierLookup();
    const source = await generateCrc(state.selected, { onProgress: (text) => { $('generation-status').textContent = text; } });
    await acceptCertificate(source);
  } catch (error) { $('generation-status').textContent = ''; notice(error.message, true); record('crc-error', { kind: error.code || error.name }); }
  finally { setBusy(''); }
}
function makeBlobUrl(base64) { const url = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: 'application/pdf' })); state.objectUrls.add(url); return url; }
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
async function receiptMessage(type, additions = {}) {
  const response = await chrome.runtime.sendMessage({ type, key: state.receiptKey, token: state.receipt?.token, ...additions });
  if (response?.error) throw new Error(response.error);
  return response;
}
async function getForm(context, { afterDocumentId = '' } = {}) {
  const overallDeadline = Date.now() + 90_000;
  let stepDeadline = Date.now() + 45_000;
  let pending = afterDocumentId ? 'type-reload' : '';
  let lastFrameCount = 0;
  let sawChoice = false;
  const status = {
    'process-toolbar': 'Aguardando a barra de ações do processo…',
    'choose-type': 'Aguardando o SEI abrir a lista de tipos de documento…',
    'external-form': 'Aguardando o formulário de documento externo…',
    'type-reload': 'Aguardando o SEI atualizar o formulário para o tipo CRC…',
  };
  while (Date.now() < Math.min(stepDeadline, overallDeadline)) {
    const current = await inspectProcess(context.tabId, { expected: context });
    lastFrameCount = current.frames.length;
    const form = current.frames.find((f) => f.isExternalForm &&
      (!afterDocumentId || (f.scriptingDocumentId && f.scriptingDocumentId !== afterDocumentId)));
    if (form) return { context: current, frame: form };

    // Injection results after the main frame have no guaranteed order. Prefer
    // the actual visible control over a link embedded in the tree's Nos.acoes.
    const choice = current.frames.find((f) => f.hasVisibleExternalControl) || current.frames.find((f) => f.isTypeChoice);
    const include = current.frames.find((f) => f.hasVisibleIncludeControl);
    sawChoice ||= Boolean(choice);
    let target = null;
    if (!['external-form', 'type-reload'].includes(pending)) {
      if (choice) target = choice;
      else if (pending !== 'choose-type') {
        if (include) target = include;
        else if (!pending) target = current.frames.find((f) => f.includeUrl) || current.frames.find((f) => f.frameId === 0);
      }
    }
    if (target) {
      const results = await inject(context.tabId, navigateToExternalForm, [{ processId: context.processId, unitId: context.unitId }], [target.frameId]);
      const value = results[0]?.result;
      if (value?.error || value?.stage === 'manual' || value?.stage === 'blocked') throw new Error(value.error || value.message || value.reason || 'Abra Incluir Documento → Externo no SEI e clique em Anexar novamente.');
      if (value?.stage === 'navigated' && ['process-toolbar', 'choose-type', 'external-form'].includes(value.destination)) {
        pending = value.destination;
        stepDeadline = Date.now() + 45_000;
        record('sei-navigation', { destination: pending, frames: lastFrameCount });
      } else if (value?.stage === 'form') {
        pending = 'external-form';
      } else {
        throw new Error('O SEI não confirmou a abertura da inclusão de documento. Confira a tela do processo antes de tentar novamente.');
      }
    }
    // A navigation is issued once per step. Repeating a click or assigning an
    // iframe src while it loads can restart the request indefinitely.
    $('attachment-status').textContent = status[pending] || 'Localizando a inclusão de documento no SEI…';
    await delay(450);
  }
  record('sei-navigation-timeout', { destination: pending || 'unknown', frames: lastFrameCount, sawChoice });
  const message = pending === 'type-reload'
    ? 'O SEI não concluiu a atualização do tipo CRC. Confira o formulário e clique em Anexar novamente quando a tela terminar de carregar.'
    : pending === 'choose-type'
      ? 'O SEI não terminou de abrir a lista de tipos de documento. Confira a tela e, se necessário, abra Incluir Documento → Externo antes de tentar novamente.'
      : 'O SEI não terminou de abrir o formulário externo. Confira a tela e, se necessário, escolha Externo antes de clicar em Anexar novamente.';
  const error = new Error(message);
  error.code = 'SEI_NAVIGATION_TIMEOUT';
  throw error;
}
async function prepare(context, payload) {
  const deadline = Date.now() + 100_000;
  let afterDocumentId = '';
  while (Date.now() < deadline) {
    const { frame } = await getForm(context, { afterDocumentId });
    afterDocumentId = '';
    const results = await inject(context.tabId, prepareExternalDocument, [payload], [frame.frameId]);
    const result = results[0]?.result;
    if (result?.error || result?.stage === 'blocked' || result?.stage === 'manual') throw new Error(result.error || result.message || 'Não foi possível conferir os campos de inclusão no SEI.');
    if (result?.stage === 'prepared') return { frameId: frame.frameId, result };
    if (!['type-changing', 'uploading', 'waiting', 'loading'].includes(result?.stage)) throw new Error(result?.message || 'O SEI não confirmou a preparação do arquivo. Confira o formulário aberto.');
    if (result.stage === 'type-changing') {
      afterDocumentId = results[0]?.documentId || frame.scriptingDocumentId || '';
      record('sei-type-changing', { awaitingReload: Boolean(afterDocumentId) });
    }
    $('attachment-status').textContent = result.stage === 'type-changing' ? 'Selecionando o tipo CRC no SEI…' : 'Aguardando o SEI concluir o upload do PDF…';
    await delay(650);
  }
  throw new Error('O SEI não concluiu a preparação em tempo hábil. Confira o formulário aberto antes de tentar de novo.');
}
async function attach() {
  if (!state.context || !state.certificate || state.busy) return;
  notice(''); setBusy('attach'); $('success').hidden = true; $('attachment-status').textContent = 'Conferindo o processo de destino…';
  let saveStarted = false; let formPrepared = false; let receiptAcquired = false;
  try {
    const context = await inspectProcess(state.context.tabId, { expand: true, expected: state.context });
    state.context = context;
    const cert = state.certificate;
    $('release-row').hidden = true; $('confirm-not-saved').checked = false;
    state.receiptKey = `crc-receipt:${new URL(context.origin).hostname}:${context.unitId || '0'}:${context.processId}:${cert.cnpj}`;
    const acquired = await receiptMessage('receipt-acquire', { receipt: { stage: 'preparing', processId: context.processId, unitId: context.unitId, origin: context.origin, cnpj: cert.cnpj, sha256: cert.sha256, fileName: cert.fileName, oldDocumentIds: context.documents.map((d) => d.id), startedAt: Date.now() } });
    if (!acquired.ok) {
      state.receipt = acquired.receipt;
      if (state.receipt?.stage === 'complete') { $('success').textContent = 'Este mesmo CRC já foi incluído nesta sessão.'; $('success').hidden = false; $('attachment-status').textContent = ''; return; }
      $('verify-receipt').hidden = false;
      throw new Error('Há uma inclusão deste fornecedor em andamento ou com resultado ainda não confirmado. Use Verificar inclusão antes de tentar outro envio.');
    }
    state.receipt = acquired.receipt;
    receiptAcquired = true;
    const payload = {
      processId: context.processId, unitId: context.unitId, cnpj: cert.cnpj,
      fileName: cert.fileName, fileBase64: cert.base64, sha256: cert.sha256,
      documentDate: cert.documentDate, generatedAtText: cert.emittedAtText,
      specification: `${formatCnpj(cert.cnpj)} - ${cert.documentDate}`,
      observations: `CRC de ${formatCnpj(cert.cnpj)}, emitido pelo CAGEF em ${cert.emittedAtText} (horário de Brasília). PDF original obtido na consulta pública do CAGEF.`,
      submit: false,
    };
    $('attachment-status').textContent = 'Abrindo o documento externo e preenchendo os campos…';
    const ready = await prepare(context, payload); formPrepared = true;
    const updated = await receiptMessage('receipt-update', { changes: { stage: 'prepared' } }); state.receipt = updated.receipt;
    $('verify-receipt').hidden = false;
    if ($('review-first').checked) {
      $('attachment-status').textContent = 'Campos e arquivo preparados. Confira o formulário na aba do SEI e clique em Salvar. Depois use Verificar inclusão.';
      await chrome.tabs.update(context.tabId, { active: true });
      const tab = await chrome.tabs.get(context.tabId); await chrome.windows.update(tab.windowId, { focused: true });
      record('sei-prepared'); return;
    }
    await checkTabContext(context);
    const pending = await receiptMessage('receipt-update', { changes: { stage: 'submitting' } }); state.receipt = pending.receipt;
    saveStarted = true;
    $('attachment-status').textContent = 'Salvando o CRC no processo…';
    const sent = await inject(context.tabId, submitPreparedExternalDocument, [payload], [ready.frameId]);
    const value = sent[0]?.result;
    if (value?.error || value?.stage !== 'saving') throw new Error(value?.error || value?.message || 'O SEI ainda não confirmou o início do salvamento. Confira o formulário.');
    record('sei-save-started');
    await verifyInclusion({ attempts: 10 });
  } catch (error) {
    notice(error.message, true); record('sei-attach-error', { kind: error.name, saveStarted, formPrepared });
    if (receiptAcquired && state.receipt && !saveStarted && !formPrepared && state.receipt.stage === 'preparing') {
      try { await receiptMessage('receipt-release'); state.receipt = null; } catch { /* Retain an uncertain lock. */ }
    }
    if (state.receipt) { $('verify-receipt').hidden = false; $('attachment-status').textContent = 'A inclusão não foi confirmada. Confira o SEI e use Verificar inclusão.'; }
    else $('attachment-status').textContent = 'O salvamento não foi iniciado.';
  } finally { setBusy(''); }
}
async function pdfForDescriptor(context, doc, depth = 0, visited = new Set()) {
  if (depth > 4 || visited.has(doc.url)) return null;
  visited.add(doc.url);
  const response = await fetchResource(context, doc);
  if (response.base64 && (/pdf/i.test(response.mime || '') || response.base64.startsWith('JVBER'))) return response.base64;
  if (response.text) {
    const parsed = htmlDocumentContent(response.text, response.url || doc.url, doc.id, context.processId);
    for (const url of parsed.resources) { const pdf = await pdfForDescriptor(context, { ...doc, url }, depth + 1, visited); if (pdf) return pdf; }
  }
  return null;
}
async function verifyInclusion({ attempts = 1 } = {}) {
  if (!state.receipt || !state.context) return;
  const receipt = state.receipt;
  const oldIds = new Set(receipt.oldDocumentIds);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt || attempts > 1) await delay(1000);
    $('attachment-status').textContent = 'Conferindo a árvore e o PDF incluído no SEI…';
    const context = await inspectProcess(state.context.tabId, { expand: true, expected: state.context });
    const newDocs = context.documents.filter((d) => !oldIds.has(d.id));
    // Limit verification to new records whose label identifies this CRC/CNPJ.
    const likely = newDocs.filter((d) => /\bcrc\b|registro\s+cadastral/i.test(d.label || '') || String(d.label || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(receipt.cnpj));
    for (const doc of likely.slice(0, 8)) {
      try {
        const base64 = await pdfForDescriptor(context, doc);
        if (!base64 || await sha256(base64) !== receipt.sha256) continue;
        const updated = await receiptMessage('receipt-update', { changes: { stage: 'complete', documentId: doc.id, completedAt: Date.now() } });
        state.receipt = updated.receipt;
        $('success').textContent = `CRC incluído e arquivo conferido no processo${context.processNumber ? ` ${context.processNumber}` : ''}. Documento: ${doc.label || doc.id}.`;
        $('success').hidden = false; $('verify-receipt').hidden = true; $('release-row').hidden = true;
        $('attachment-status').textContent = ''; record('sei-inclusion-verified'); updateControls(); return true;
      } catch { /* A temporarily loading document is retried with the next tree refresh. */ }
    }
  }
  $('attachment-status').textContent = 'Ainda não consegui confirmar o CRC na árvore. A extensão não repetirá o salvamento automaticamente.';
  $('verify-receipt').hidden = false; $('release-row').hidden = false;
  record('sei-inclusion-unconfirmed'); return false;
}

$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault(); const cnpj = normalizeCnpj($('manual-cnpj').value);
  if (!isValidCnpj(cnpj)) { notice('Informe um CPF ou CNPJ completo com dígitos verificadores válidos.', true); return; }
  notice(''); state.occurrences.push({ cnpj, formatted: formatCnpj(cnpj), manual: true, context: '', documentId: 'manual', start: 0, page: null }); candidateButton(cnpj); $('manual-cnpj').value = formatCnpj(cnpj);
});
$('scan').addEventListener('click', scan);
$('cancel-scan').addEventListener('click', () => { state.scan?.abort(); $('scan-status').textContent = 'Interrompendo após a leitura em andamento…'; });
$('refresh-process').addEventListener('click', refreshBoundProcess);
$('close-panel').addEventListener('click', async () => {
  const button = $('close-panel');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'crc-panel-hide' });
    if (response?.ok !== true) throw new Error('Não foi possível recolher o assistente.');
  } catch {
    notice('Não foi possível recolher o assistente. Tente novamente pelo botão Fechar.', true);
  } finally { button.disabled = false; }
});
$('generate').addEventListener('click', generate);
$('attach').addEventListener('click', attach);
$('review-first').addEventListener('change', async () => { updateControls(); await chrome.storage.local.set({ reviewFirst: $('review-first').checked }); });
$('preview').addEventListener('click', () => { if (state.certificate) chrome.tabs.create({ url: makeBlobUrl(state.certificate.base64) }); });
$('download').addEventListener('click', () => { if (state.certificate) downloadBlob(new Blob([base64ToBytes(state.certificate.base64)], { type: 'application/pdf' }), state.certificate.fileName); });
$('check-receipt').addEventListener('click', async () => { notice(''); setBusy('verify'); try { await verifyInclusion({ attempts: 2 }); } catch (error) { notice(error.message, true); } finally { setBusy(''); } });
$('confirm-not-saved').addEventListener('change', () => { $('release-receipt').disabled = !$('confirm-not-saved').checked; });
$('release-receipt').addEventListener('click', async () => {
  if (!$('confirm-not-saved').checked || !state.receipt) return;
  try { await receiptMessage('receipt-release'); state.receipt = null; state.receiptKey = ''; $('verify-receipt').hidden = true; $('release-row').hidden = true; $('confirm-not-saved').checked = false; $('attachment-status').textContent = 'Nova tentativa liberada após sua conferência.'; notice(''); updateControls(); }
  catch (error) { notice(error.message, true); }
});
$('diagnostics').addEventListener('click', () => {
  // Intentionally omit URL parameters, identifiers, excerpts, file bytes, errors
  // from external pages, names and CPFs e CNPJs from exported diagnostics.
  const data = { extension: chrome.runtime.getManifest().version, generatedAt: new Date().toISOString(), hasProcess: Boolean(state.context), frameCount: state.context?.frames.length || 0, documentCount: state.context?.documents.length || 0, events: state.log };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'crc-sei-diagnostico.json');
  $('diagnostic-status').textContent = 'Diagnóstico gerado sem CPF/CNPJ, nomes, números de processo, conteúdo ou endereços de sessão.';
});
window.addEventListener('beforeunload', () => { stopSupplierLookup(); state.scan?.abort(); for (const url of state.objectUrls) URL.revokeObjectURL(url); });

// Ao clicar novamente no botão do SEI, retoma a aba que originou a abertura.
// A conferência também limpa fornecedor/PDF antigos se o processo tiver mudado.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'crc-assistant-activate' || sender?.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js')) ||
      embeddedTabId === null || message.tabId !== embeddedTabId) return false;
  if (state.busy) { respond({ ok: false, errorCode: 'busy' }); return true; }
  loadProcess(embeddedTabId)
    .then((ok) => respond({ ok }))
    .catch(() => respond({ ok: false }));
  return true;
});

async function initialize() {
  setBusy('process');
  const preferences = await chrome.storage.local.get('reviewFirst').catch(() => ({}));
  $('review-first').checked = preferences.reviewFirst === true;
  const version = document.querySelector('.version');
  if (version) version.textContent = chrome.runtime.getManifest().version;
  await refreshBoundProcess();
  updateControls();
}
initialize().catch((error) => { showProcessError(error); setBusy(''); });
