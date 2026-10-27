import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { File } from 'node:buffer';
import * as core from '../lib/core.js';
import * as pdf from '../lib/pdf.js';
import * as scanner from '../lib/scanner.js';
import * as documents from '../lib/documents.js';
import * as sei from '../lib/sei.js';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { ({ JSDOM } = await import(new URL('../../crc-test-tools/node_modules/jsdom/lib/api.js', import.meta.url))); }

const [panelHtml, panelSource, backgroundSource] = await Promise.all([
  readFile(new URL('../panel.html', import.meta.url), 'utf8'),
  readFile(new URL('../panel.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);
const ORIGIN = 'https://www.sei.mg.gov.br';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const MAIN_CNPJ = '12345678000195';
const OTHER_CNPJ = '00000000000191';
const PROCESS_NUMBER = '1500.01.1234567/2026-01';
// This is a byte sentinel for upload/readback tests, not a generated or real
// PDF. Panel workflows mock PDF parsing and the external CAGEF boundary; the
// independent PDF and CAGEF tests cover those components with their fixtures.
const PDF_SENTINEL = '%PDF-1.7\nOffline integration upload sentinel.\n%%EOF';
const PDF_BASE64 = Buffer.from(PDF_SENTINEL).toString('base64');
const CERTIFICATE_TEXT = 'CERTIFICADO DE REGISTRO CADASTRAL DO FORNECEDOR - CRC\n' +
  'VALIDADE: 29/09/2027\nIDENTIFICAÇÃO\nCNPJ 12.345.678/0001-95\n' +
  'Nome Empresarial Fornecedor de Teste Ltda.\nNome Fantasia Exemplo\nContatos\n' +
  'Emitido em: 08/10/2026 às 14:21:09';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const escapeAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function addManualSupplier(panel, cnpj = MAIN_CNPJ) {
  const doc = panel.window.document;
  doc.querySelector('#manual-cnpj').value = cnpj;
  doc.querySelector('#manual-form').dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
}

function candidateRow(doc, cnpj) {
  return doc.querySelector(`#candidates input[value="${cnpj}"]`)?.closest('.candidate');
}

function candidateName(doc, cnpj) {
  return candidateRow(doc, cnpj)?.querySelector('.candidate-name')?.textContent || '';
}

async function scanPanel(panel) {
  const doc = panel.window.document;
  doc.querySelector('#scan').click();
  await until(() => doc.querySelector('#scan-status').textContent.includes('Busca concluída') && !doc.body.classList.contains('busy'), 'completed panel scan');
}

function seiUrl(action, id = '', { process = '42', unit = '1100', extra = '' } = {}) {
  return `${ORIGIN}/sei/controlador.php?acao=${action}&id_procedimento=${process}&infra_unidade_atual=${unit}&infra_hash=fixture${id ? `&id_documento=${id}` : ''}${extra}`;
}

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function surface(html, url, { fastTimers = false, clockRate = 1 } = {}) {
  // No resources option and outside-only scripts: neither HTML fixtures nor
  // scripts/links inside downloaded documents execute or access the network.
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const win = dom.window;
  Object.defineProperty(win, 'crypto', { value: webcrypto });
  Object.assign(win, { TextEncoder, TextDecoder, AbortController, File });
  if (clockRate !== 1) {
    // Advance deadline checks and timer delays at the same rate. A 1.8 s
    // navigation still takes four 450 ms polling intervals at any speed.
    const wallStart = Date.now();
    const logicalStart = wallStart;
    win.Date.now = () => logicalStart + (Date.now() - wallStart) * clockRate;
    const original = win.setTimeout.bind(win);
    win.setTimeout = (callback, delay, ...args) => original(callback, (delay || 0) / clockRate, ...args);
  } else if (fastTimers) {
    const original = win.setTimeout.bind(win);
    win.setTimeout = (callback, delay, ...args) => original(callback, Math.min(delay || 0, 15), ...args);
  }
  return dom;
}

function execute(dom, fn, args) {
  dom.window.__injectedArguments = clone(args);
  // Only this repository's own function source is evaluated. Remote page
  // scripts are parsed by production code and never evaluated by this harness.
  return vm.runInContext(`(${fn.toString()})(...__injectedArguments)`, dom.getInternalVMContext());
}

class OfflineChrome {
  constructor({ corruptReadback = false, wrapper = false, navigationDelays = {}, clockRate = 1, documentIds = true, typeReloadDelay = null } = {}) {
    this.tabs = new Map([[7, { id: 7, windowId: 70, title: 'SEI — processo de teste', url: seiUrl('procedimento_trabalhar') }]]);
    this.frames = new Map();
    this.clockRate = clockRate;
    this.navigationDelays = navigationDelays;
    this.navigationTargetFrameId = 1;
    this.navigationRequests = [];
    this.navigationCompletions = [];
    this.navigationTimer = null;
    this.provideDocumentIds = documentIds;
    this.typeReloadDelay = typeReloadDelay;
    this.typeChanges = [];
    this.typeReloads = [];
    this.typeReloadTimer = null;
    this.routes = new Map();
    this.session = {};
    this.local = {};
    this.reads = [];
    this.injections = [];
    this.messages = [];
    this.uploads = [];
    this.saves = [];
    this.lookups = [];
    this.generations = [];
    this.createdTabs = [];
    this.createdWindows = [];
    this.tabMessages = [];
    this.tabQueries = 0;
    this.currentWindowReads = 0;
    this.panels = [];
    this.listeners = [];
    this.corruptReadback = corruptReadback;
    this.documentRows = [
      { id: '100', label: 'Cotação principal (100)', url: seiUrl('documento_visualizar', '100') },
      { id: '101', label: 'Consulta complementar (101)', url: seiUrl('documento_visualizar', '101') },
    ];
    this.common = {
      tabs: {
        get: async id => { if (!this.tabs.has(id)) throw new Error('Tab not found'); return clone(this.tabs.get(id)); },
        query: async () => { this.tabQueries++; return [...this.tabs.values()].map(clone); },
        update: async (id, changes) => ({ ...clone(this.tabs.get(id)), ...changes }),
        create: async options => { this.createdTabs.push(clone(options)); return { id: 80 + this.createdTabs.length, ...options }; },
        sendMessage: async (tabId, message, options) => {
          this.tabMessages.push({ tabId, message: clone(message), options: clone(options) });
          return { ok: true };
        },
      },
      windows: {
        getCurrent: async () => { this.currentWindowReads++; return { id: 90 }; },
        update: async id => ({ id }),
        create: async options => { this.createdWindows.push(clone(options)); return { id: 90, ...options }; },
        onRemoved: { addListener() {} },
      },
      action: { onClicked: { addListener() {} }, setTitle: async () => {} },
      storage: {
        session: {
          get: async key => ({ [key]: clone(this.session[key]) }),
          set: async value => { Object.assign(this.session, clone(value)); },
          remove: async key => { delete this.session[key]; },
        },
        local: {
          get: async key => ({ [key]: clone(this.local[key]) }),
          set: async value => { Object.assign(this.local, clone(value)); },
          setAccessLevel: async () => {},
        },
      },
      scripting: {
        executeScript: async request => {
          assert.equal(request.world, 'ISOLATED');
          assert.equal(request.target.tabId, 7);
          this.injections.push({ name: request.func.name, frameIds: request.target.frameIds });
          const ids = request.target.frameIds || (request.target.documentIds
            ? [...this.frames].filter(([, frame]) => request.target.documentIds.includes(frame.fixtureDocumentId)).map(([frameId]) => frameId)
            : [...this.frames.keys()]);
          const results = [];
          for (const frameId of ids) {
            const frame = this.frames.get(frameId);
            if (!frame) throw new Error(`Missing frame ${frameId}`);
            const result = await execute(frame, request.func, request.args || []);
            results.push({ frameId, ...(this.provideDocumentIds ? { documentId: frame.fixtureDocumentId } : {}), result: clone(result) });
          }
          return results;
        },
      },
    };
    this.chrome = this.client(`chrome-extension://${EXTENSION_ID}/panel.html?embedded=1`);
    const backgroundChrome = this.client(`chrome-extension://${EXTENSION_ID}/background.js`);
    vm.runInNewContext(backgroundSource, { chrome: backgroundChrome, crypto: webcrypto, URL, console }, { filename: 'background.js' });
    const root = this.addFrame(0, `<input id="hdnIdProcedimento" type="hidden" value="42"><div id="divArvoreInformacao">${PROCESS_NUMBER}</div><div id="divArvore"></div><a id="include" href="${escapeAttribute(seiUrl('documento_escolher_tipo'))}">Incluir Documento</a>`, seiUrl('procedimento_trabalhar'));
    root.window.document.querySelector('#include').addEventListener('click', event => {
      event.preventDefault();
      this.requestNavigation('choose-type');
    });
    this.refreshTree();
    this.addFrame(1, '<p>Visualização do processo</p>', seiUrl('arvore_visualizar'));
    // A privileged panel shares the Chrome tab, but must not be treated as a
    // SEI frame even when its DOM contains document links and supplier text.
    this.addFrame(20, `<input id="hdnIdProcedimento" value="42"><div id="divArvore"><a href="${escapeAttribute(seiUrl('documento_visualizar', '666'))}">CRC do painel (666)</a></div><p>CNPJ 04.252.011/0001-10</p>`, `chrome-extension://${EXTENSION_ID}/panel.html?embedded=1`);
    this.routes.set(this.documentRows[0].url, {
      text: '<html><body><nav>CNPJ 04.252.011/0001-10</nav><p>Cotação recebida para fornecimento de material. CNPJ: 12.345.678/0001-95.</p><script>globalThis.remoteScriptExecuted = true;</script></body></html>',
    });
    const innerUrl = seiUrl('documento_visualizar', '101', { extra: '&conteudo=1' });
    const viewerUrl = wrapper ? `${ORIGIN}/sei/pdfjs/web/viewer.html?file=${encodeURIComponent(innerUrl)}` : innerUrl;
    this.routes.set(this.documentRows[1].url, { text: `<html><body><iframe src="${escapeAttribute(viewerUrl)}"></iframe><iframe src="https://example.org/documento.pdf"></iframe></body></html>` });
    this.routes.set(innerUrl, { text: '<html><body><p>Documento complementar com dados do fornecedor CNPJ 00.000.000/0001-91.</p><p>A cotação anterior menciona novamente o CNPJ 12.345.678/0001-95.</p></body></html>' });
  }

  client(senderUrl, senderOverrides = {}) {
    const sender = { id: EXTENSION_ID, url: senderUrl };
    const source = new URL(senderUrl);
    if (source.protocol === 'chrome-extension:' && source.pathname === '/panel.html') {
      Object.assign(sender, { tab: { id: 7 }, frameId: 20 });
    } else if (source.protocol === 'https:') {
      Object.assign(sender, { tab: { id: 7 }, frameId: 0 });
    }
    Object.assign(sender, senderOverrides);
    return {
      ...this.common,
      runtime: {
        id: EXTENSION_ID,
        getURL: path => `chrome-extension://${EXTENSION_ID}/${path}`,
        getManifest: () => ({ version: '0.2.0' }),
        onInstalled: { addListener() {} },
        onMessage: { addListener: listener => { this.listeners.push(listener); } },
        sendMessage: message => new Promise((resolve, reject) => {
          this.messages.push(clone(message));
          let handled = false;
          for (const listener of this.listeners) {
            const result = listener(clone(message), clone(sender), value => resolve(clone(value)));
            handled ||= result === true;
          }
          if (!handled) reject(new Error('No authorized message listener'));
        }),
      },
    };
  }

  addFrame(frameId, html, url) {
    this.frames.get(frameId)?.window.close();
    const dom = surface(html, url, { fastTimers: true, clockRate: this.clockRate });
    dom.fixtureDocumentId = webcrypto.randomUUID();
    dom.window.fetch = async (target, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'manual');
      this.reads.push(String(target));
      const route = this.routes.get(String(target));
      if (!route) throw new Error(`Unexpected offline resource: ${target}`);
      const value = typeof route === 'function' ? await route() : route;
      return new Response(value.bytes ?? value.text, { status: value.status || 200, headers: { 'Content-Type': value.mime || 'text/html; charset=utf-8' } });
    };
    this.frames.set(frameId, dom);
    return dom;
  }

  refreshTree() {
    const tree = this.frames.get(0).window.document.querySelector('#divArvore');
    tree.innerHTML = this.documentRows.map(row => `<a class="infraArvore" href="${escapeAttribute(row.url)}">${row.label}</a>`).join('');
  }

  requestNavigation(destination) {
    this.navigationRequests.push({ destination, at: Date.now() });
    clearTimeout(this.navigationTimer);
    this.navigationTimer = null;
    const complete = () => {
      this.navigationTimer = null;
      this.navigationCompletions.push(destination);
      if (destination === 'choose-type') this.showTypeChoice();
      else if (destination === 'external-form') this.showExternalForm();
      else throw new Error(`Unexpected offline destination: ${destination}`);
    };
    const milliseconds = this.navigationDelays[destination] || 0;
    // Infinity represents a response which never completes. Each new click
    // replaces the same frame navigation and restarts its loading deadline.
    if (milliseconds === Infinity) return;
    if (milliseconds) this.navigationTimer = setTimeout(complete, milliseconds / this.clockRate);
    else complete();
  }

  showTypeChoice() {
    const dom = this.addFrame(this.navigationTargetFrameId, `<form id="frmDocumentoEscolherTipo" action="${escapeAttribute(seiUrl('documento_escolher_tipo'))}"><a id="external" href="${escapeAttribute(seiUrl('documento_receber'))}">Externo</a></form>`, seiUrl('documento_escolher_tipo'));
    dom.window.document.querySelector('#external').addEventListener('click', event => { event.preventDefault(); this.requestNavigation('external-form'); });
  }

  showExternalForm({ selectedType = '1', previousDocumentId = '' } = {}) {
    const dom = this.addFrame(this.navigationTargetFrameId, `<form id="frmDocumentoCadastro" action="${escapeAttribute(seiUrl('documento_receber'))}">
      <input id="hdnIdProcedimento" type="hidden" value="42"><input id="hdnIdDocumento" type="hidden" value="">
      <input id="hdnIdSerie" type="hidden" value="${selectedType}"><input id="hdnStaNivelAcessoLocal" type="hidden" value="1">
      <input id="hdnFlagDocumentoCadastro" type="hidden" value="1"><input id="hdnSinArquivamento" type="hidden" value="N">
      <select id="selSerie"><option value="1" ${selectedType === '1' ? 'selected' : ''}>Anexo</option><option value="55" ${selectedType === '55' ? 'selected' : ''}>CRC</option></select>
      <input id="txtDataElaboracao"><input id="txtNomeArvore" maxlength="50"><textarea id="txaObservacoes"></textarea>
      <input id="optNato" type="radio" name="rdoFormato" value="N"><input type="radio" name="rdoFormato" value="D" checked>
      <input id="optPublico" type="radio" name="rdoNivelAcesso" value="0"><input type="radio" name="rdoNivelAcesso" value="1" checked>
      <input id="hdnAnexos" type="hidden" value=""><input id="filArquivo" type="file"><button id="btnSalvar" name="btnSalvar" type="button">Salvar</button>
    </form>`, seiUrl('documento_receber'));
    const doc = dom.window.document;
    if (previousDocumentId) this.typeReloads.push({ previousDocumentId, documentId: dom.fixtureDocumentId });
    // The real SEI submits and replaces this document after a type change.
    doc.querySelector('#selSerie').addEventListener('change', event => {
        const typeId = event.target.value;
        this.typeChanges.push({ typeId, documentId: dom.fixtureDocumentId });
        clearTimeout(this.typeReloadTimer);
        const delay = this.typeReloadDelay ?? 0;
        if (delay !== Infinity) this.typeReloadTimer = setTimeout(() => {
          this.typeReloadTimer = null;
          this.showExternalForm({ selectedType: typeId, previousDocumentId: dom.fixtureDocumentId });
        }, delay / this.clockRate);
    });
    const input = doc.querySelector('#filArquivo');
    Object.defineProperty(input, 'files', { configurable: true, writable: true, value: [] });
    dom.window.DataTransfer = class {
      constructor() { this.files = []; this.items = { add: file => { this.files.push(file); } }; }
    };
    let uploadedBytes;
    input.addEventListener('change', async () => {
      const file = input.files[0];
      doc.querySelector('#btnSalvar').disabled = true;
      uploadedBytes = new Uint8Array(await file.arrayBuffer());
      this.uploads.push({ fileName: file.name, bytes: uploadedBytes, documentId: dom.fixtureDocumentId });
      doc.querySelector('#hdnAnexos').value = `tmp-1±${file.name}±08/10/2026 14:21:10±${file.size}±1 KB±teste±1100`;
      doc.querySelector('#btnSalvar').disabled = false;
    });
    doc.querySelector('#btnSalvar').addEventListener('click', () => {
      assert.ok(uploadedBytes, 'Save must wait for the upload');
      this.saves.push({ date: doc.querySelector('#txtDataElaboracao').value, type: doc.querySelector('#selSerie').value, format: doc.querySelector('[name="rdoFormato"]:checked').value, access: doc.querySelector('[name="rdoNivelAcesso"]:checked').value, name: doc.querySelector('#txtNomeArvore').value, observations: doc.querySelector('#txaObservacoes').value });
      const wrapperUrl = seiUrl('documento_visualizar', '200');
      const downloadUrl = seiUrl('documento_download_anexo', '200');
      this.documentRows.push({ id: '200', label: `CRC ${doc.querySelector('#txtNomeArvore').value} (200)`, url: wrapperUrl });
      this.routes.set(wrapperUrl, { text: `<html><body><object data="${escapeAttribute(downloadUrl)}" type="application/pdf"></object></body></html>` });
      this.routes.set(downloadUrl, { bytes: this.corruptReadback ? Buffer.from('%PDF-1.7\nDifferent bytes\n%%EOF') : uploadedBytes, mime: 'application/pdf' });
      this.refreshTree();
      doc.querySelector('#hdnFlagDocumentoCadastro').value = '2';
    });
    return dom;
  }

  changeContext({ process = '42', unit = '1100' }) {
    for (const dom of this.frames.values()) {
      const url = new URL(dom.window.location.href);
      if (url.origin !== ORIGIN) continue;
      url.searchParams.set('id_procedimento', process);
      url.searchParams.set('infra_unidade_atual', unit);
      dom.reconfigure({ url: url.href });
      const hidden = dom.window.document.querySelector('#hdnIdProcedimento');
      if (hidden) hidden.value = process;
    }
    this.tabs.get(7).url = this.frames.get(0).window.location.href;
  }

  async openPanel({ certificateText = CERTIFICATE_TEXT, query = 'embedded=1', senderOverrides = {}, expectContext = true,
    lookupSupplier = async cnpj => ({ cnpj, supplierName: '' }), generateCrc } = {}) {
    const dom = surface(panelHtml, `chrome-extension://${EXTENSION_ID}/panel.html?${query}`, { fastTimers: true, clockRate: this.clockRate });
    const dependencies = { ...core, ...pdf, ...scanner, ...sei, ...documents, normalizeCnpj: core.normalizeTaxId, isValidCnpj: core.isValidTaxId, formatCnpj: core.formatTaxId };
    Object.assign(dom.window, dependencies, {
      chrome: this.client(dom.window.location.href, senderOverrides),
      lookupSupplier: async (cnpj, options = {}) => {
        this.lookups.push({ cnpj, signal: options.signal });
        return lookupSupplier(cnpj, options);
      },
      generateCrc: async (cnpj, options = {}) => {
        this.generations.push(cnpj);
        if (generateCrc) return generateCrc(cnpj, options);
        assert.equal(cnpj, MAIN_CNPJ);
        return { base64: PDF_BASE64 };
      },
      readPdf: async base64 => { assert.equal(base64, PDF_BASE64); return { pages: [{ page: 1, text: certificateText }], pageCount: 1, emptyPages: [], limited: false }; },
    });
    // Preserve the complete production panel body and substitute only its ES
    // module import bindings; no panel behavior is reimplemented in the test.
    const body = panelSource.replace(/^import\s+.*?;\s*$/gm, '');
    assert.ok(!/^import\s/m.test(body), 'Update the harness if imports become multiline');
    vm.runInContext(body, dom.getInternalVMContext(), { filename: 'panel.js' });
    this.panels.push(dom);
    await until(() => !dom.window.document.body.classList.contains('busy') &&
      (expectContext ? dom.window.document.querySelector('#process-number').textContent === PROCESS_NUMBER :
        dom.window.document.querySelector('#process-number').textContent === 'Abra um processo no SEI'), 'panel initialization');
    return dom;
  }

  async close() {
    clearTimeout(this.navigationTimer);
    clearTimeout(this.typeReloadTimer);
    // Match the browser lifecycle before destroying the fixtures. The panel's
    // unload handler invalidates an enrichment job, so a queued context check
    // cannot write into a closed document after the next test installs globals.
    for (const dom of this.panels) dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    await sleep(0);
    for (const dom of [...this.frames.values(), ...this.panels]) dom.window.close();
  }
}

async function withChrome(options, action) {
  const bus = new OfflineChrome(options);
  const globals = ['chrome', 'DOMParser', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: bus.chrome });
  Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: bus.frames.get(0).window.DOMParser });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { throw new Error('External network is disabled in integration tests'); } });
  try { return await action(bus); }
  finally {
    await bus.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function chooseAndGenerate(panel) {
  const doc = panel.window.document;
  doc.querySelector('#manual-cnpj').value = MAIN_CNPJ;
  doc.querySelector('#manual-form').dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector('#generate').disabled, false);
  doc.querySelector('#generate').click();
  await until(() => !doc.querySelector('#certificate').hidden && !doc.body.classList.contains('busy'), 'certificate metadata validation');
}

test('HTML process scan follows only the selected document wrapper and keeps source occurrences', async () => {
  await withChrome({}, async bus => {
    const context = await scanner.inspectProcess(7);
    assert.deepEqual(context.frames.map(frame => frame.frameId), [0, 1], 'The privileged embedded panel is not a SEI document frame');
    assert.deepEqual(context.documents.map(document => document.id), ['100', '101']);
    const result = await scanner.scanProcess(context);
    assert.equal(result.total, 2);
    assert.deepEqual(result.reports.map(row => row.status), ['read', 'read']);
    const candidates = documents.mergeCandidates(result.occurrences);
    assert.deepEqual(candidates.map(item => item.cnpj), [MAIN_CNPJ, OTHER_CNPJ]);
    assert.equal(candidates[0].occurrences.length, 2);
    assert.deepEqual(candidates[0].occurrences.map(item => item.documentId), ['100', '101']);
    assert.ok(result.occurrences.every(item => item.documentUrl.includes(`id_documento=${item.documentId}`)));
    assert.ok(bus.reads.every(url => url.startsWith(ORIGIN)));
    assert.ok([...bus.frames.values()].every(dom => dom.window.remoteScriptExecuted === undefined));
  });
});

test('an observed PDF viewer file parameter survives the observed-URL security boundary', async () => {
  await withChrome({ wrapper: true }, async () => {
    const result = await scanner.scanProcess(await scanner.inspectProcess(7));
    assert.equal(result.reports[1].status, 'read', result.reports[1].detail);
    assert.ok(result.occurrences.some(item => item.cnpj === OTHER_CNPJ));
  });
});

test('process or unit changes block subsequent resource reads before any request is made', async () => {
  for (const changed of [{ process: '99' }, { unit: '2200' }]) {
    await withChrome({}, async bus => {
      const context = await scanner.inspectProcess(7);
      bus.changeContext(changed);
      await assert.rejects(scanner.fetchResource(context, context.documents[0]), /processo|unidade/i);
      assert.equal(bus.reads.length, 0);
    });
  }
});

test('the embedded panel binds to its browser-provided tab and ignores query parameters selecting another tab', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel({ query: 'embedded=1&tab=999&window=999&view=11111111-1111-1111-1111-111111111111' });
    const doc = panel.window.document;
    assert.equal(doc.querySelector('#process-number').textContent, PROCESS_NUMBER);
    assert.equal(doc.querySelector('#tab-picker'), null);
    assert.equal(doc.querySelector('#sei-tabs'), null);
    assert.equal(doc.querySelector('#close-panel').getAttribute('aria-label'), 'Fechar assistente de CRC');
    assert.deepEqual(bus.messages.find(message => message.type === 'crc-panel-context'), { type: 'crc-panel-context' });
    assert.equal(bus.tabMessages.find(call => call.message.type === 'crc-embedded-ready')?.tabId, 7);
    assert.equal(bus.tabQueries, 0);
    assert.equal(bus.currentWindowReads, 0);
    assert.equal(bus.createdWindows.length, 0);
    assert.equal(doc.querySelector('#scan').disabled, false);
  });
});

test('an unverified embedded context exposes Atualizar without falling back to another tab', async () => {
  for (const invalid of ['top-level-panel', 'non-sei-tab']) {
    await withChrome({}, async bus => {
      if (invalid === 'non-sei-tab') bus.tabs.get(7).url = 'https://example.org/';
      const panel = await bus.openPanel({
        query: 'embedded=1&tab=7', expectContext: false,
        senderOverrides: invalid === 'top-level-panel' ? { frameId: 0 } : {},
      });
      const doc = panel.window.document;
      assert.match(doc.querySelector('#process-detail').textContent, /painel|processo.*SEI/i);
      assert.equal(doc.querySelector('#refresh-process').disabled, false);
      assert.equal(doc.querySelector('#manual-cnpj').disabled, true);
      assert.equal(doc.querySelector('#scan').disabled, true);
      assert.equal(doc.querySelector('#generate').disabled, true);
      assert.equal(doc.querySelector('#attach').disabled, true);
      assert.equal(bus.injections.length, 0);
      assert.equal(bus.tabQueries, 0);
      assert.equal(bus.createdWindows.length, 0);
      if (invalid === 'non-sei-tab') {
        bus.tabs.get(7).url = seiUrl('procedimento_trabalhar');
        doc.querySelector('#refresh-process').click();
        await until(() => !doc.body.classList.contains('busy'), 'retry of the embedded context handshake');
        assert.equal(doc.querySelector('#process-number').textContent, PROCESS_NUMBER);
        assert.equal(doc.querySelector('#scan').disabled, false);
        assert.equal(bus.messages.filter(message => message.type === 'crc-panel-context').length, 2);
      }
    });
  }
});

test('closing the embedded panel preserves the certificate and an ongoing scan without opening a window', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    await chooseAndGenerate(panel);
    const fileName = doc.querySelector('#certificate-file').textContent;
    const documentUrl = bus.documentRows[0].url;
    const original = bus.routes.get(documentUrl);
    let continueScan;
    const pause = new Promise(resolve => { continueScan = resolve; });
    bus.routes.set(documentUrl, async () => { await pause; return original; });
    doc.querySelector('#scan').click();
    await until(() => bus.reads.includes(documentUrl), 'a scan waiting for document content');
    assert.equal(doc.querySelector('#close-panel').disabled, false);
    doc.querySelector('#close-panel').click();
    await until(() => bus.tabMessages.some(call => call.message.type === 'crc-hide-embedded-panel'), 'background forwarding the hide request');
    const remainsBusy = doc.body.classList.contains('busy');
    continueScan();
    assert.equal(remainsBusy, true, 'Hiding does not cancel or reset the ongoing operation');
    const hide = bus.tabMessages.find(call => call.message.type === 'crc-hide-embedded-panel');
    assert.deepEqual(hide, { tabId: 7, message: { type: 'crc-hide-embedded-panel' }, options: { frameId: 0 } });
    await until(() => !doc.body.classList.contains('busy'), 'the hidden panel finishing its scan');
    assert.match(doc.querySelector('#scan-status').textContent, /Busca concluída/);
    assert.equal(doc.querySelector('#certificate').hidden, false);
    assert.equal(doc.querySelector('#certificate-file').textContent, fileName);
    assert.equal(doc.querySelector('#close-panel').disabled, false);
    assert.equal(bus.createdWindows.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('the production panel scans, selects, verifies metadata, uploads, saves once and verifies the original bytes', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    assert.equal(doc.querySelector('#scan').disabled, false);
    assert.equal(doc.querySelector('#generate').disabled, true);
    assert.equal(doc.querySelector('#attach').disabled, true);
    doc.querySelector('#scan').click();
    await until(() => doc.querySelector('#scan-status').textContent.includes('Busca concluída') && !doc.body.classList.contains('busy'), 'HTML document scan');
    const candidates = [...doc.querySelectorAll('#candidates input')];
    assert.deepEqual(candidates.map(input => input.value), [MAIN_CNPJ, OTHER_CNPJ]);
    assert.match(doc.querySelector('#candidates small').textContent, /2 documento/);
    doc.querySelector('.occurrence-link').click();
    assert.equal(bus.createdTabs[0].url, seiUrl('documento_visualizar', '100'));
    candidates[0].click();
    doc.querySelector('#generate').click();
    await until(() => !doc.querySelector('#certificate').hidden && !doc.body.classList.contains('busy'), 'CRC generation and validation');
    assert.equal(doc.querySelector('#supplier-name').textContent, 'Fornecedor de Teste Ltda.');
    assert.equal(doc.querySelector('#document-date').textContent, '08/10/2026');
    assert.match(doc.querySelector('#certificate-date').textContent, /14:21:09/);
    assert.equal(doc.querySelector('#attach').disabled, false);
    doc.querySelector('#attach').click();
    await until(() => !doc.querySelector('#success').hidden && !doc.body.classList.contains('busy'), 'save and PDF readback', 8000);
    assert.equal(bus.uploads.length, 1);
    assert.equal(bus.saves.length, 1);
    assert.deepEqual(bus.saves.map(row => [row.type, row.date, row.format, row.access]), [['55', '08/10/2026', 'N', '0']]);
    assert.match(bus.saves[0].observations, /14:21:09/);
    assert.equal(Buffer.from(bus.uploads[0].bytes).toString(), PDF_SENTINEL);
    assert.equal(Object.values(bus.session)[0].stage, 'complete');
    assert.equal(Object.values(bus.session)[0].documentId, '200');
    assert.equal(doc.querySelector('#attach').disabled, true);
    assert.ok(bus.injections.some(item => item.name === 'navigateToExternalForm'));
    assert.ok(bus.reads.includes(seiUrl('documento_download_anexo', '200')));
    assert.ok(!JSON.stringify(bus.session).includes(PDF_BASE64));
    doc.querySelector('#attach').click();
    await sleep(30);
    assert.equal(bus.saves.length, 1);
  });
});

test('a changed destination blocks panel attachment and refreshing clears the old certificate', async () => {
  for (const changed of [{ process: '99' }, { unit: '2200' }]) {
    await withChrome({}, async bus => {
      const panel = await bus.openPanel();
      const doc = panel.window.document;
      await chooseAndGenerate(panel);
      bus.changeContext(changed);
      doc.querySelector('#attach').click();
      await until(() => !doc.body.classList.contains('busy'), 'blocked attachment');
      assert.equal(bus.uploads.length, 0);
      assert.equal(bus.saves.length, 0);
      assert.match(doc.querySelector('#notice').textContent, /processo|unidade/i);
      assert.equal(Object.keys(bus.session).length, 0);
      doc.querySelector('#refresh-process').click();
      await until(() => !doc.body.classList.contains('busy'), 'updated process');
      assert.equal(doc.querySelector('#certificate').hidden, true);
      assert.equal(doc.querySelector('#attach').disabled, true);
      assert.equal(doc.querySelectorAll('#candidates input').length, 0);
    });
  }
});

test('reopening the assistant verifies the current process and clears a certificate from the previous process', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    await chooseAndGenerate(panel);
    const background = bus.client(`chrome-extension://${EXTENSION_ID}/background.js`);
    const activation = { type: 'crc-assistant-activate', tabId: 7 };
    assert.equal((await background.runtime.sendMessage(activation)).ok, true);
    assert.equal(doc.querySelector('#certificate').hidden, false, 'Same process keeps the prepared CRC');
    const foreign = bus.client(seiUrl('procedimento_trabalhar'));
    await assert.rejects(foreign.runtime.sendMessage(activation), /authorized/);
    await assert.rejects(panel.window.chrome.runtime.sendMessage(activation), /authorized/);
    await assert.rejects(background.runtime.sendMessage({ ...activation, tabId: 8 }), /authorized/);
    bus.changeContext({ process: '99' });
    assert.equal((await background.runtime.sendMessage(activation)).ok, true);
    assert.equal(doc.querySelector('#certificate').hidden, true);
    assert.equal(doc.querySelector('#attach').disabled, true);
    assert.equal(doc.querySelectorAll('#candidates input').length, 0);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('reopening a busy assistant does not replace the context of its current operation', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    const background = bus.client(`chrome-extension://${EXTENSION_ID}/background.js`);
    doc.querySelector('#scan').click();
    const result = await background.runtime.sendMessage({ type: 'crc-assistant-activate', tabId: 7 });
    assert.deepEqual(result, { ok: false, errorCode: 'busy' });
    await until(() => !doc.body.classList.contains('busy'), 'scan remains in its original process');
    assert.equal(doc.querySelectorAll('#candidates input').length, 2);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('an explicit supplier name from a process document appears during scanning without a CAGEF lookup for that CNPJ', async () => {
  await withChrome({}, async bus => {
    const localName = 'Documento Comercial Ltda.';
    bus.routes.set(bus.documentRows[0].url, {
      text: `<html><body><p>Razão Social: ${localName}</p><p>CNPJ: 12.345.678/0001-95</p></body></html>`,
    });
    const remainingDocument = deferred();
    const route = bus.routes.get(bus.documentRows[1].url);
    bus.routes.set(bus.documentRows[1].url, async () => { await remainingDocument.promise; return route; });
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    doc.querySelector('#scan').click();
    try {
      await until(() => candidateName(doc, MAIN_CNPJ) === localName, 'document-derived name before the scan finishes');
      assert.equal(doc.body.classList.contains('busy'), true);
      assert.equal(candidateRow(doc, MAIN_CNPJ).querySelector('input').disabled, true);
      assert.match(candidateRow(doc, MAIN_CNPJ).querySelector('.candidate-name-source').textContent, /documento/i);
      assert.equal(bus.lookups.length, 0, 'Names found locally are available before enrichment starts');
    } finally { remainingDocument.resolve(); }
    await until(() => !doc.body.classList.contains('busy'), 'the remaining document scan');
    await until(() => bus.lookups.some(item => item.cnpj === OTHER_CNPJ), 'lookup for the unnamed supplier');
    assert.equal(bus.lookups.some(item => item.cnpj === MAIN_CNPJ), false);
    assert.equal(candidateName(doc, MAIN_CNPJ), localName);
    assert.equal(bus.generations.length, 0);
  });
});

test('manual supplier enrichment displays the exact returned name without emitting a CRC or blocking selection', async () => {
  await withChrome({}, async bus => {
    const result = deferred();
    const panel = await bus.openPanel({ lookupSupplier: () => result.promise });
    const doc = panel.window.document;
    addManualSupplier(panel);
    await until(() => bus.lookups.length === 1, 'manual CNPJ lookup');
    const row = candidateRow(doc, MAIN_CNPJ);
    assert.equal(bus.lookups[0].cnpj, MAIN_CNPJ);
    assert.equal(doc.body.classList.contains('busy'), false);
    assert.equal(row.querySelector('input').disabled, false);
    assert.equal(doc.querySelector('#generate').disabled, false);
    const name = 'Comércio Exemplo <img src=x onerror=alert(1)> Ltda.';
    result.resolve({ cnpj: MAIN_CNPJ, supplierName: name });
    await until(() => candidateName(doc, MAIN_CNPJ) === name, 'manual supplier name');
    assert.equal(candidateRow(doc, MAIN_CNPJ), row);
    assert.equal(row.querySelector('img'), null, 'Remote supplier labels remain plain text');
    assert.equal(row.querySelector('.candidate-name-source').textContent, 'Nome no CAGEF');
    assert.match(doc.querySelector('#selected-cnpj').textContent, /Comércio Exemplo/);
    assert.equal(doc.querySelector('#certificate').hidden, true);
    assert.equal(bus.generations.length, 0);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('sequential supplier lookups preserve radio focus, open details, selection and existing source links', async () => {
  await withChrome({}, async bus => {
    const first = deferred();
    const second = deferred();
    const panel = await bus.openPanel({ lookupSupplier: cnpj => cnpj === MAIN_CNPJ ? first.promise : second.promise });
    const doc = panel.window.document;
    await scanPanel(panel);
    await until(() => bus.lookups.length === 1, 'first sequential lookup');
    assert.equal(bus.lookups[0].cnpj, MAIN_CNPJ);
    const row = candidateRow(doc, MAIN_CNPJ);
    const radio = row.querySelector('input');
    const details = row.querySelector('details');
    const sourceLink = row.querySelector('.occurrence-link');
    radio.click();
    details.open = true;
    radio.focus();
    assert.equal(doc.activeElement, radio);
    assert.equal(bus.lookups.length, 1, 'The second request waits for the first result');
    first.resolve({ cnpj: MAIN_CNPJ, supplierName: 'Primeiro Fornecedor Ltda.' });
    await until(() => candidateName(doc, MAIN_CNPJ) === 'Primeiro Fornecedor Ltda.' && bus.lookups.length === 2, 'first name and next sequential request');
    assert.equal(candidateRow(doc, MAIN_CNPJ), row);
    assert.equal(row.querySelector('input'), radio);
    assert.equal(row.querySelector('details'), details);
    assert.equal(row.querySelector('.occurrence-link'), sourceLink);
    assert.equal(details.open, true);
    assert.equal(radio.checked, true);
    assert.equal(doc.activeElement, radio);
    sourceLink.focus();
    second.resolve({ cnpj: OTHER_CNPJ, supplierName: 'Segundo Fornecedor S.A.' });
    await until(() => candidateName(doc, OTHER_CNPJ) === 'Segundo Fornecedor S.A.', 'second supplier name');
    assert.equal(doc.activeElement, sourceLink);
    assert.equal(details.open, true);
    assert.equal(radio.checked, true);
    assert.equal(bus.generations.length, 0);
  });
});

test('a missing CAGEF supplier affects only its own name and both CNPJs remain selectable', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel({ lookupSupplier: async cnpj => {
      if (cnpj === MAIN_CNPJ) throw Object.assign(new Error('Cadastro não localizado na consulta.'), { code: 'CAGEF_NOT_FOUND' });
      return { cnpj, supplierName: 'Fornecedor Encontrado Ltda.' };
    } });
    const doc = panel.window.document;
    await scanPanel(panel);
    await until(() => candidateName(doc, OTHER_CNPJ) === 'Fornecedor Encontrado Ltda.' && !doc.querySelector('#names-status').textContent, 'continuation after an absent supplier');
    assert.deepEqual(bus.lookups.map(item => item.cnpj), [MAIN_CNPJ, OTHER_CNPJ]);
    assert.equal(candidateName(doc, MAIN_CNPJ), 'Razão social não identificada');
    for (const cnpj of [MAIN_CNPJ, OTHER_CNPJ]) {
      const radio = candidateRow(doc, cnpj).querySelector('input');
      assert.equal(radio.disabled, false);
      radio.click();
      assert.equal(radio.checked, true);
      assert.equal(doc.querySelector('#generate').disabled, false);
    }
    assert.equal(bus.lookups.length, 2, 'Selecting a missing supplier does not repeat its lookup');
    assert.equal(bus.generations.length, 0);
    assert.equal(doc.querySelector('#notice').hidden, true);
  });
});

test('a general CAGEF failure pauses enrichment until refresh without blocking supplier choice', async () => {
  await withChrome({}, async bus => {
    let attempts = 0;
    const panel = await bus.openPanel({ lookupSupplier: async cnpj => {
      if (++attempts === 1) throw Object.assign(new Error('Portal temporariamente indisponível.'), { code: 'CAGEF_NETWORK' });
      return { cnpj, supplierName: `Fornecedor ${cnpj}` };
    } });
    const doc = panel.window.document;
    await scanPanel(panel);
    await until(() => bus.lookups.length === 1 && !doc.querySelector('#names-status').textContent, 'paused name queue');
    const secondRadio = candidateRow(doc, OTHER_CNPJ).querySelector('input');
    secondRadio.click();
    assert.equal(secondRadio.checked, true);
    assert.equal(doc.querySelector('#generate').disabled, false);
    await sleep(25);
    assert.equal(bus.lookups.length, 1);
    assert.equal(doc.querySelector('#notice').hidden, true);
    doc.querySelector('#refresh-process').click();
    await until(() => candidateName(doc, MAIN_CNPJ) === `Fornecedor ${MAIN_CNPJ}` && candidateName(doc, OTHER_CNPJ) === `Fornecedor ${OTHER_CNPJ}`, 'retried names after process refresh');
    assert.equal(bus.lookups.length, 3);
    assert.equal(bus.lookups[1].cnpj, OTHER_CNPJ, 'The selected unnamed supplier is enriched first');
    assert.equal(secondRadio.checked, true);
    assert.equal(bus.generations.length, 0);
  });
});

test('a supplier lookup for another CNPJ cannot label the selected candidate', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel({ lookupSupplier: async () => ({ cnpj: OTHER_CNPJ, supplierName: 'Fornecedor Incorreto Ltda.' }) });
    const doc = panel.window.document;
    addManualSupplier(panel);
    await until(() => bus.lookups.length === 1 && !doc.querySelector('#names-status').textContent, 'rejection of mismatched supplier identity');
    assert.equal(candidateName(doc, MAIN_CNPJ), 'Razão social não identificada');
    assert.equal(doc.body.textContent.includes('Fornecedor Incorreto Ltda.'), false);
    assert.equal(doc.querySelector('#generate').disabled, false);
    assert.equal(bus.generations.length, 0);
  });
});

test('CRC issuance aborts and drains an outstanding lookup before starting and ignores its late supplier name', async () => {
  await withChrome({}, async bus => {
    const pending = deferred();
    const events = [];
    const panel = await bus.openPanel({
      lookupSupplier: async (cnpj, { signal }) => {
        events.push('lookup-start');
        signal.addEventListener('abort', () => events.push('lookup-abort'), { once: true });
        const result = await pending.promise;
        events.push('lookup-settled');
        return result;
      },
      generateCrc: async () => { events.push('generate-start'); return { base64: PDF_BASE64 }; },
    });
    const doc = panel.window.document;
    addManualSupplier(panel);
    await until(() => bus.lookups.length === 1, 'an outstanding name lookup');
    doc.querySelector('#generate').click();
    assert.equal(bus.lookups[0].signal.aborted, true);
    assert.equal(doc.body.classList.contains('busy'), true);
    assert.equal(candidateRow(doc, MAIN_CNPJ).querySelector('input').disabled, true);
    await sleep(25);
    assert.equal(bus.generations.length, 0, 'Issuance must await the aborted request settling');
    pending.resolve({ cnpj: MAIN_CNPJ, supplierName: 'Nome Atrasado que Não Deve Aparecer' });
    await until(() => !doc.querySelector('#certificate').hidden && !doc.body.classList.contains('busy'), 'CRC generation after lookup drain');
    assert.deepEqual(events, ['lookup-start', 'lookup-abort', 'lookup-settled', 'generate-start']);
    assert.equal(candidateName(doc, MAIN_CNPJ), 'Fornecedor de Teste Ltda.');
    assert.equal(candidateRow(doc, MAIN_CNPJ).querySelector('.candidate-name-source').textContent, 'Nome no CRC');
    assert.equal(doc.body.textContent.includes('Nome Atrasado que Não Deve Aparecer'), false);
    assert.equal(bus.lookups.length, 1, 'The validated CRC name prevents another background lookup');
    assert.equal(bus.generations.length, 1);
  });
});

test('a process change clears cached names and a late lookup cannot populate the new process', async () => {
  await withChrome({}, async bus => {
    const pendingOld = deferred();
    const pendingNew = deferred();
    const panel = await bus.openPanel({ lookupSupplier: () => bus.lookups.length === 1 ? pendingOld.promise : pendingNew.promise });
    const doc = panel.window.document;
    addManualSupplier(panel);
    await until(() => bus.lookups.length === 1, 'lookup in the original process');
    bus.changeContext({ process: '99' });
    doc.querySelector('#refresh-process').click();
    await until(() => !doc.body.classList.contains('busy'), 'switching the bound process');
    assert.equal(bus.lookups[0].signal.aborted, true);
    assert.equal(doc.querySelectorAll('#candidates input').length, 0);
    addManualSupplier(panel);
    await sleep(25);
    assert.equal(bus.lookups.length, 1, 'The new lookup waits for the old request to settle');
    pendingOld.resolve({ cnpj: MAIN_CNPJ, supplierName: 'Nome do Processo Anterior Ltda.' });
    await until(() => bus.lookups.length === 2, 'lookup in the new process');
    assert.equal(doc.body.textContent.includes('Nome do Processo Anterior Ltda.'), false);
    assert.equal(bus.lookups[1].signal.aborted, false, 'The obsolete finally does not clear or cancel the new job');
    pendingNew.resolve({ cnpj: MAIN_CNPJ, supplierName: 'Nome do Processo Atual Ltda.' });
    await until(() => candidateName(doc, MAIN_CNPJ) === 'Nome do Processo Atual Ltda.', 'the current process name');
    bus.changeContext({ process: '100' });
    doc.querySelector('#refresh-process').click();
    await until(() => !doc.body.classList.contains('busy'), 'clearing the populated name cache');
    assert.equal(doc.body.textContent.includes('Nome do Processo Atual Ltda.'), false);
    addManualSupplier(panel);
    await until(() => bus.lookups.length === 3, 'a fresh lookup after cached names are cleared');
    assert.equal(bus.generations.length, 0);
  });
});

test('supplier names stay in panel memory and are absent from diagnostic exports and browser storage', async () => {
  await withChrome({}, async bus => {
    const lookupName = 'Razão Social Exclusiva do Enriquecimento Ltda.';
    const panel = await bus.openPanel({ lookupSupplier: async cnpj => ({ cnpj, supplierName: lookupName }) });
    const doc = panel.window.document;
    addManualSupplier(panel);
    await until(() => candidateName(doc, MAIN_CNPJ) === lookupName, 'the queried company name');
    const blobs = [];
    const downloads = [];
    panel.window.Blob = Blob;
    panel.window.URL.createObjectURL = blob => { blobs.push(blob); return `blob:offline-diagnostic-${blobs.length}`; };
    panel.window.URL.revokeObjectURL = () => {};
    panel.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    doc.querySelector('#diagnostics').click();
    assert.equal(downloads[0], 'crc-sei-diagnostico.json');
    const beforeCertificate = await blobs[0].text();
    assert.equal(beforeCertificate.includes(lookupName), false);
    assert.equal(beforeCertificate.includes(MAIN_CNPJ), false);
    doc.querySelector('#generate').click();
    await until(() => !doc.querySelector('#certificate').hidden && !doc.body.classList.contains('busy'), 'a verified certificate replacing the display name');
    assert.equal(candidateName(doc, MAIN_CNPJ), 'Fornecedor de Teste Ltda.');
    doc.querySelector('#diagnostics').click();
    const afterCertificate = await blobs[1].text();
    for (const value of [beforeCertificate, afterCertificate, JSON.stringify(bus.local), JSON.stringify(bus.session), JSON.stringify(bus.messages)]) {
      assert.equal(value.includes(lookupName), false);
      assert.equal(value.includes('Fornecedor de Teste Ltda.'), false);
    }
    assert.deepEqual(bus.local, {});
    assert.deepEqual(bus.session, {});
    const reopened = await bus.openPanel();
    assert.equal(reopened.window.document.querySelectorAll('#candidates input').length, 0, 'A fresh panel has no persisted supplier list');
  });
});

test('invalid CRC identity cannot enable attachment or reuse an earlier selected certificate', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel({ certificateText: CERTIFICATE_TEXT.replace('12.345.678/0001-95', '00.000.000/0001-91') });
    const doc = panel.window.document;
    doc.querySelector('#manual-cnpj').value = MAIN_CNPJ;
    doc.querySelector('#manual-form').dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
    doc.querySelector('#generate').click();
    await until(() => !doc.body.classList.contains('busy'), 'rejected metadata');
    assert.equal(doc.querySelector('#certificate').hidden, true);
    assert.equal(doc.querySelector('#attach').disabled, true);
    assert.match(doc.querySelector('#notice').textContent, /diferente do fornecedor/);
    assert.equal(bus.uploads.length, 0);
  });
});

test('a failed process refresh clears the selected supplier and previously validated PDF', async () => {
  await withChrome({}, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    await chooseAndGenerate(panel);
    bus.tabs.get(7).url = 'https://example.org/';
    doc.querySelector('#refresh-process').click();
    await until(() => !doc.body.classList.contains('busy'), 'failed process refresh');
    assert.equal(doc.querySelector('#process-number').textContent, 'Abra um processo no SEI');
    assert.equal(doc.querySelector('#certificate').hidden, true);
    assert.equal(doc.querySelector('#attach').disabled, true);
    assert.equal(doc.querySelector('#generate').disabled, true);
    assert.equal(doc.querySelectorAll('#candidates input').length, 0);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('an unsuccessful acquisition does not release another panel preparing receipt', async () => {
  await withChrome({}, async bus => {
    const key = `crc-receipt:www.sei.mg.gov.br:1100:42:${MAIN_CNPJ}`;
    const owner = await bus.chrome.runtime.sendMessage({ type: 'receipt-acquire', key, receipt: {
      stage: 'preparing', cnpj: MAIN_CNPJ, sha256: 'a'.repeat(64), oldDocumentIds: ['100', '101'],
    } });
    const panel = await bus.openPanel();
    await chooseAndGenerate(panel);
    const doc = panel.window.document;
    doc.querySelector('#attach').click();
    await until(() => !doc.body.classList.contains('busy'), 'rejected receipt acquisition');
    assert.equal(bus.session[key]?.token, owner.receipt.token);
    assert.equal(bus.session[key]?.stage, 'preparing');
    assert.equal(bus.messages.filter(message => message.type === 'receipt-release').length, 0);
    assert.equal(doc.querySelector('#verify-receipt').hidden, false);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
  });
});

test('readback with different bytes remains unconfirmed and a second panel cannot duplicate the save', async () => {
  await withChrome({ corruptReadback: true }, async bus => {
    const first = await bus.openPanel();
    await chooseAndGenerate(first);
    first.window.document.querySelector('#attach').click();
    await until(() => bus.saves.length === 1 && !first.window.document.body.classList.contains('busy'), 'unconfirmed readback', 8000);
    assert.equal(first.window.document.querySelector('#success').hidden, true);
    assert.equal(first.window.document.querySelector('#verify-receipt').hidden, false);
    assert.equal(first.window.document.querySelector('#attach').disabled, true);
    assert.equal(Object.values(bus.session)[0].stage, 'submitting');
    const second = await bus.openPanel();
    await chooseAndGenerate(second);
    second.window.document.querySelector('#attach').click();
    await until(() => !second.window.document.body.classList.contains('busy'), 'shared receipt check');
    assert.match(second.window.document.querySelector('#notice').textContent, /inclusão.*andamento|confirmado/i);
    assert.equal(bus.saves.length, 1);
    assert.equal(bus.uploads.length, 1);
    assert.equal(second.window.document.querySelector('#verify-receipt').hidden, false);
  });
});

test('review-first mode prepares the required metadata and leaves saving to the user', async () => {
  await withChrome({}, async bus => {
    bus.local.reviewFirst = true;
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    assert.equal(doc.querySelector('#review-first').checked, true);
    assert.match(doc.querySelector('#attach').textContent, /Preencher documento externo/);
    await chooseAndGenerate(panel);
    doc.querySelector('#attach').click();
    await until(() => Object.values(bus.session)[0]?.stage === 'prepared' && !doc.body.classList.contains('busy'), 'review-first preparation');
    assert.equal(bus.uploads.length, 1);
    assert.equal(bus.saves.length, 0);
    assert.equal(doc.querySelector('#verify-receipt').hidden, false);
    assert.match(doc.querySelector('#attachment-status').textContent, /clique em Salvar/);
    bus.frames.get(1).window.document.querySelector('#btnSalvar').click();
    doc.querySelector('#check-receipt').click();
    await until(() => !doc.querySelector('#success').hidden && !doc.body.classList.contains('busy'), 'manual-save readback');
    assert.equal(bus.saves.length, 1);
    assert.equal(Object.values(bus.session)[0].stage, 'complete');
  });
});

test('the service worker serializes receipt acquisition and rejects token and sender mismatches', async () => {
  await withChrome({}, async bus => {
    const clientA = bus.client(`chrome-extension://${EXTENSION_ID}/panel.html?window=A`);
    const clientB = bus.client(`chrome-extension://${EXTENSION_ID}/panel.html?window=B`);
    const key = `crc-receipt:www.sei.mg.gov.br:1100:42:${MAIN_CNPJ}`;
    const message = { type: 'receipt-acquire', key, receipt: { stage: 'preparing', sha256: 'a'.repeat(64), cnpj: MAIN_CNPJ } };
    const acquired = await Promise.all([clientA.runtime.sendMessage(message), clientB.runtime.sendMessage(message)]);
    assert.equal(acquired.filter(result => result.ok).length, 1);
    assert.equal(acquired.filter(result => !result.ok).length, 1);
    const badToken = await clientA.runtime.sendMessage({ type: 'receipt-release', key, token: 'not-the-owner' });
    assert.match(badToken.error, /não possui/);
    assert.equal(Object.keys(bus.session).length, 1);
    const foreign = bus.client(`${ORIGIN}/sei/controlador.php`);
    await assert.rejects(foreign.runtime.sendMessage(message), /authorized/);
    const complete = await clientA.runtime.sendMessage({ type: 'receipt-update', key, token: acquired[0].receipt.token, changes: { stage: 'complete' } });
    assert.equal(complete.receipt.stage, 'complete');
    assert.equal((await clientB.runtime.sendMessage(message)).ok, false);
    assert.equal((await clientB.runtime.sendMessage({ ...message, receipt: { ...message.receipt, sha256: 'b'.repeat(64) } })).ok, true);
  });
});


function navigationCounts(bus) {
  return bus.navigationRequests.reduce((counts, { destination }) => {
    counts[destination] = (counts[destination] || 0) + 1;
    return counts;
  }, {});
}

async function attachAndSettle(panel, description = 'attachment after pending navigation') {
  const doc = panel.window.document;
  doc.querySelector('#attach').click();
  await until(() => !doc.body.classList.contains('busy'), description, 8000);
}

for (const [description, navigationDelays] of [
  ['both document screens load slowly', { 'choose-type': 1800, 'external-form': 1800 }],
  ['only the external form loads slowly', { 'choose-type': 0, 'external-form': 1800 }],
]) {
  test(`navigation regression: ${description} without repeated clicks restarting the request`, async () => {
    await withChrome({ navigationDelays, clockRate: 30 }, async bus => {
      const panel = await bus.openPanel();
      const doc = panel.window.document;
      await chooseAndGenerate(panel);
      await attachAndSettle(panel);
      assert.equal(doc.querySelector('#success').hidden, false,
        `${doc.querySelector('#notice').textContent}; navigation requests: ${JSON.stringify(navigationCounts(bus))}`);
      assert.deepEqual(navigationCounts(bus), { 'choose-type': 1, 'external-form': 1 });
      assert.deepEqual(bus.navigationCompletions, ['choose-type', 'external-form']);
      assert.equal(bus.uploads.length, 1);
      assert.equal(bus.saves.length, 1);
      assert.equal(Object.values(bus.session)[0].stage, 'complete');
    });
  });
}

test('navigation regression: a process change while the external form is loading prevents upload', async () => {
  await withChrome({ navigationDelays: { 'external-form': 1800 }, clockRate: 30 }, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    await chooseAndGenerate(panel);
    doc.querySelector('#attach').click();
    await until(() => bus.navigationRequests.some(request => request.destination === 'external-form'), 'external form request in flight');
    bus.changeContext({ process: '99' });
    await until(() => !doc.body.classList.contains('busy'), 'rejection of a changed process during navigation');
    assert.match(doc.querySelector('#notice').textContent, /processo.*mud|processo.*selecionad|destino.*mud/i);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
    assert.equal(bus.injections.some(request => request.name === 'prepareExternalDocument'), false);
    assert.equal(doc.querySelector('#success').hidden, true);
    assert.deepEqual(navigationCounts(bus), { 'choose-type': 1, 'external-form': 1 });
  });
});

test('navigation regression: a stalled navigation times out without upload or repeated requests', async () => {
  await withChrome({ navigationDelays: { 'choose-type': Infinity }, clockRate: 30 }, async bus => {
    const panel = await bus.openPanel();
    const doc = panel.window.document;
    await chooseAndGenerate(panel);
    await attachAndSettle(panel, 'navigation timeout');
    assert.match(doc.querySelector('#notice').textContent, /não terminou|formulário|carreg|tempo/i);
    assert.equal(doc.querySelector('#success').hidden, true);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
    assert.equal(bus.injections.some(request => request.name === 'prepareExternalDocument'), false);
    assert.deepEqual(navigationCounts(bus), { 'choose-type': 1 });
    assert.deepEqual(bus.navigationCompletions, []);
    assert.equal(Object.keys(bus.session).length, 0, 'No upload or save began, so this attempt must release its receipt');
  });
});

test('navigation regression: a visible nested toolbar wins over an earlier tree script containing the same action URL', async () => {
  await withChrome({ navigationDelays: { 'choose-type': 1800, 'external-form': 1800 }, clockRate: 30 }, async bus => {
    bus.frames.get(0).window.document.querySelector('#include').remove();
    const tree = bus.addFrame(1, `<script>
      Nos[0] = new infraArvoreNo("PROCESSO","42",null,"${seiUrl('arvore_visualizar')}","ifrVisualizacao","${PROCESS_NUMBER}","Compras",null,null,null,true,true,null,null,null,"${PROCESS_NUMBER}");
      Nos[0].acoes = '<a href="${seiUrl('documento_escolher_tipo')}">Incluir Documento</a>';
    </script><a id="process-root" href="${escapeAttribute(seiUrl('arvore_visualizar'))}">${PROCESS_NUMBER}</a>`, seiUrl('procedimento_visualizar'));
    let rootClicks = 0;
    tree.window.document.querySelector('#process-root').addEventListener('click', event => { event.preventDefault(); rootClicks++; });
    // executeScript exposes a flat collection of frames, including nested
    // visualization frames; the tree appears first and contains only a script
    // reference to Incluir, while a later structural frame has the real control.
    const toolbar = bus.addFrame(2, `<div id="divArvoreAcoes"><a id="visible-include" href="${escapeAttribute(seiUrl('documento_escolher_tipo'))}">Incluir Documento</a></div><iframe id="ifrVisualizacao" src="${escapeAttribute(seiUrl('arvore_visualizar'))}"></iframe>`, seiUrl('arvore_visualizar'));
    bus.navigationTargetFrameId = 3;
    bus.addFrame(3, '<p>Documento atualmente selecionado</p>', seiUrl('arvore_visualizar', '100'));
    let includeClicks = 0;
    toolbar.window.document.querySelector('#visible-include').addEventListener('click', event => {
      event.preventDefault(); includeClicks++; bus.requestNavigation('choose-type');
    });
    const initial = await scanner.inspectProcess(7);
    const treeIndex = initial.frames.findIndex(frame => frame.frameId === 1);
    const toolbarIndex = initial.frames.findIndex(frame => frame.frameId === 2);
    assert.ok(treeIndex >= 0 && toolbarIndex > treeIndex);
    assert.equal(initial.frames.find(frame => frame.includeUrl)?.frameId, 1, 'The first observed URL alone is not a visible navigation control');
    const panel = await bus.openPanel();
    await chooseAndGenerate(panel);
    await attachAndSettle(panel, 'nested toolbar navigation');
    const doc = panel.window.document;
    assert.equal(doc.querySelector('#success').hidden, false, doc.querySelector('#notice').textContent);
    assert.equal(includeClicks, 1);
    assert.equal(rootClicks, 0, 'The existing action bar must be used before clicking the tree root again');
    assert.deepEqual(navigationCounts(bus), { 'choose-type': 1, 'external-form': 1 });
    assert.equal(bus.injections.find(request => request.name === 'navigateToExternalForm')?.frameIds[0], 2);
    assert.equal(bus.uploads.length, 1);
    assert.equal(bus.saves.length, 1);
  });
});

test('navigation regression: selecting CRC waits for a new document before uploading when the reload is slow', async () => {
  await withChrome({ typeReloadDelay: 1800, clockRate: 30 }, async bus => {
    const panel = await bus.openPanel();
    await chooseAndGenerate(panel);
    await attachAndSettle(panel, 'type-selection reload and subsequent attachment');
    const doc = panel.window.document;
    assert.equal(doc.querySelector('#success').hidden, false, doc.querySelector('#notice').textContent);
    assert.equal(bus.typeChanges.length, 1, 'CRC selection must not be submitted repeatedly while its form reloads');
    assert.equal(bus.typeReloads.length, 1);
    assert.notEqual(bus.typeReloads[0].documentId, bus.typeChanges[0].documentId);
    assert.equal(bus.uploads.length, 1);
    assert.equal(bus.uploads[0].documentId, bus.typeReloads[0].documentId, 'The PDF must only be uploaded to the replacement document');
    assert.notEqual(bus.uploads[0].documentId, bus.typeChanges[0].documentId, 'The old form already shows CRC locally but has not completed its server reload');
    assert.equal(bus.saves.length, 1);
  });
});

test('navigation regression: a type-selection reload that never completes must not receive the PDF', async () => {
  await withChrome({ typeReloadDelay: Infinity, clockRate: 30 }, async bus => {
    const panel = await bus.openPanel();
    await chooseAndGenerate(panel);
    await attachAndSettle(panel, 'type-selection reload timeout');
    const doc = panel.window.document;
    assert.match(doc.querySelector('#notice').textContent, /SEI|tipo|formulário|tempo/i);
    assert.equal(doc.querySelector('#success').hidden, true);
    assert.equal(bus.typeChanges.length, 1);
    assert.equal(bus.typeReloads.length, 0);
    assert.equal(bus.uploads.length, 0);
    assert.equal(bus.saves.length, 0);
    assert.equal(Object.keys(bus.session).length, 0);
  });
});
