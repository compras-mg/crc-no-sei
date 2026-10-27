import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { ({ JSDOM } = await import(new URL('../../crc-test-tools/node_modules/jsdom/lib/api.js', import.meta.url))); }

const [launcherSource, backgroundSource] = await Promise.all([
  readFile(new URL('../sei-button.js', import.meta.url), 'utf8'),
  readFile(new URL('../background.js', import.meta.url), 'utf8'),
]);
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/`;
const VIEW_ID = '6a326645-c631-4ad6-ae0f-084fbcc419cd';
const extensionUrl = path => EXTENSION_URL + path;
const PAGE_URL = 'https://www.sei.mg.gov.br/sei/controlador.php?acao=procedimento_trabalhar&id_procedimento=42&infra_unidade_atual=1100';
const TREE_URL = 'https://www.sei.mg.gov.br/sei/controlador.php?acao=procedimento_visualizar&id_procedimento=42&infra_unidade_atual=1100';
const SHELL_URL = 'https://www.sei.mg.gov.br/sei/controlador.php?acao=arvore_visualizar&id_procedimento=42&infra_unidade_atual=1100';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const escapeAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function until(predicate, description, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function nativeBarMarkup() {
  return '<div id="divArvoreAcoes"><button id="native-include" type="button">Incluir Documento</button><button id="rp-button" type="button">RP</button></div>';
}

function processMarkup({ treeSource = TREE_URL, tree = true, password = false, nativeBar = true, toolbarFrame = null, frameSource = SHELL_URL } = {}) {
  return `<div id="divInfraAreaGlobal"><div id="divInfraBarraSistema">SEI</div><div id="divInfraAreaTela">
    ${nativeBar && toolbarFrame === null ? nativeBarMarkup() : ''}
    ${tree ? `<iframe id="ifrArvore"${treeSource === null ? '' : ` src="${escapeAttribute(treeSource)}"`}></iframe>` : ''}
    ${toolbarFrame && toolbarFrame !== 'ifrArvore' ? `<iframe id="${toolbarFrame}" src="${escapeAttribute(frameSource)}"></iframe>` : ''}
    <div id="divInfraAreaDados">Conteúdo do processo</div>${password ? '<input type="password">' : ''}
  </div></div>`;
}

function writeFrame(frame, html) {
  const doc = frame.contentDocument;
  assert.ok(doc, 'The offline fixture must have a frame document');
  doc.open();
  doc.write(`<!doctype html><html><body>${html}</body></html>`);
  doc.close();
  frame.dispatchEvent(new frame.ownerDocument.defaultView.Event('load'));
  return doc;
}

function trustedBackground(overrides = {}) {
  return { id: EXTENSION_ID, url: extensionUrl('background.js'), ...overrides };
}

function messageActor(listeners, defaultSender) {
  function dispatch(message, sender = defaultSender()) {
    const returns = [];
    const responses = [];
    let resolveResponse;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    for (const listener of listeners) {
      returns.push(listener(clone(message), clone(sender), result => {
        const value = clone(result);
        responses.push(value);
        resolveResponse(value);
      }));
    }
    return { returns, responses, response };
  }
  async function request(message, sender = defaultSender()) {
    const sent = dispatch(message, sender);
    assert.equal(sent.returns.filter(value => value === true).length, 1,
      `Exactly one listener must handle ${message.type}`);
    await until(() => sent.responses.length > 0, `${message.type} response`);
    assert.equal(sent.responses.length, 1);
    return sent.responses[0];
  }
  return { dispatch, request };
}

function page({ url = PAGE_URL, treeSource = TREE_URL, tree = true, password = false, nativeBar = true, toolbarFrame = null, frameSource = SHELL_URL, sendMessage } = {}) {
  const dom = new JSDOM(processMarkup({ treeSource, tree, password, nativeBar, toolbarFrame, frameSource }), { url, runScripts: 'outside-only' });
  // document.write supplies local structural frame fixtures. No remote frame
  // resource, page script or document content is downloaded or executed.
  for (const frame of dom.window.document.querySelectorAll('iframe')) {
    writeFrame(frame, nativeBar && frame.id === toolbarFrame ? nativeBarMarkup() : '<p>Estrutura do SEI</p>');
  }
  const messages = [];
  const listeners = [];
  dom.window.chrome = { runtime: {
    id: EXTENSION_ID,
    getURL: extensionUrl,
    onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage: async message => {
      messages.push(clone(message));
      return sendMessage ? sendMessage(message) : { ok: true, tabId: 7 };
    },
  } };
  if (!dom.window.crypto.randomUUID) {
    Object.defineProperty(dom.window.crypto, 'randomUUID', { value: () => webcrypto.randomUUID() });
  }
  dom.window.fetch = async () => { throw new Error('No network is allowed in launcher tests'); };
  dom.window.open = () => { assert.fail('The launcher must use its embedded panel, never window.open'); };
  vm.runInContext(launcherSource, dom.getInternalVMContext(), { filename: 'sei-button.js' });
  return { dom, messages, ...messageActor(listeners, trustedBackground) };
}

function allDocuments(top) {
  const found = [];
  const collect = (doc, depth = 0) => {
    if (!doc || found.includes(doc) || depth > 4) return;
    found.push(doc);
    for (const frame of doc.querySelectorAll('iframe')) {
      try { collect(frame.contentDocument, depth + 1); } catch {}
    }
  };
  collect(top);
  return found;
}

function nodes(top, selector) {
  return allDocuments(top).flatMap(doc => [...doc.querySelectorAll(selector)]);
}

function assertPlacement(top, bar = nodes(top, '#divArvoreAcoes')[0]) {
  const hosts = nodes(top, '#crc-sei-toolbar');
  assert.equal(hosts.length, 1);
  assert.equal(nodes(top, '#crc-sei-launcher').length, 1);
  assert.equal(hosts[0].tagName, 'SPAN');
  assert.equal(hosts[0].parentElement, bar);
  assert.equal(top.querySelector('#divInfraAreaGlobal > #crc-sei-toolbar'), null);
  assert.equal(top.querySelector('body > #crc-sei-toolbar'), null);
  return hosts[0];
}

function validSender(overrides = {}) {
  return { id: EXTENSION_ID, frameId: 0, url: PAGE_URL, tab: { id: 7, url: PAGE_URL }, ...overrides };
}

function panelSender(overrides = {}) {
  return {
    id: EXTENSION_ID, frameId: 5,
    url: extensionUrl(`panel.html?embedded=1&view=${VIEW_ID}`),
    tab: { id: 7, url: PAGE_URL }, ...overrides,
  };
}

function createBrowserState() {
  return {
    session: {}, created: [], activations: [], tabMessages: [], titles: [], requestedTabs: [],
    tabs: { 7: { id: 7, url: PAGE_URL, windowId: 1 } },
    getGate: null, activationHandler: null, tabMessageHandler: null,
  };
}

function worker(browser = createBrowserState()) {
  const messages = [];
  const action = [];
  const storageGet = async query => {
    if (query == null) return clone(browser.session);
    const keys = Array.isArray(query) ? query : typeof query === 'string' ? [query] : Object.keys(query);
    return Object.fromEntries(keys.map(key => [key, clone(browser.session[key])]));
  };
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: extensionUrl,
      sendMessage: async message => {
        browser.activations.push(clone(message));
        return browser.activationHandler ? browser.activationHandler(message) : { ok: true };
      },
      onMessage: { addListener: listener => messages.push(listener) },
      onInstalled: { addListener() {} },
    },
    action: {
      onClicked: { addListener: listener => action.push(listener) },
      setTitle: async options => { browser.titles.push(clone(options)); },
    },
    tabs: {
      get: async id => {
        browser.requestedTabs.push(id);
        if (browser.getGate) await browser.getGate;
        if (!browser.tabs[id]) throw new Error('Tab no longer exists');
        return clone(browser.tabs[id]);
      },
      sendMessage: async (tabId, message, options) => {
        browser.tabMessages.push({ tabId, message: clone(message), options: clone(options) });
        return browser.tabMessageHandler ? browser.tabMessageHandler(tabId, message, options) : { ok: true };
      },
    },
    windows: {
      create: async options => {
        browser.created.push(clone(options));
        assert.fail('The embedded assistant must never call chrome.windows.create');
      },
    },
    storage: {
      session: {
        get: storageGet,
        set: async entries => { Object.assign(browser.session, clone(entries)); },
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete browser.session[key]; },
      },
      local: { setAccessLevel: async () => {} },
    },
  };
  vm.runInNewContext(backgroundSource, { chrome, crypto: webcrypto, URL, console }, { filename: 'background.js' });
  return {
    browser, ...messageActor(messages, validSender),
    actionClick: tab => Promise.all(action.map(listener => listener(clone(tab)))),
  };
}

function assertEmbedded(top) {
  const panels = nodes(top, '#crc-sei-panel');
  const frames = nodes(top, '#crc-sei-panel-frame');
  assert.equal(panels.length, 1);
  assert.equal(frames.length, 1);
  const panel = panels[0];
  const frame = frames[0];
  assert.equal(panel.parentElement, top.body, 'The panel must live outside replaceable SEI containers');
  assert.equal(frame.ownerDocument, top);
  assert.equal(frame.parentElement, panel);
  const url = new URL(frame.src);
  assert.equal(url.protocol, 'chrome-extension:');
  assert.equal(url.host, EXTENSION_ID);
  assert.equal(url.pathname, '/panel.html');
  assert.equal(url.searchParams.get('embedded'), '1');
  assert.match(url.searchParams.get('view'), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['embedded', 'view']);
  assert.equal(url.searchParams.has('tab'), false, 'The embedding page must not choose another tab via URL parameters');
  assert.equal(frame.hasAttribute('sandbox'), false, 'The panel requires its extension origin and APIs');
  assert.equal(frame.hasAttribute('srcdoc'), false);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  return { panel, frame, viewId: url.searchParams.get('view'), loading: panel.querySelector('#crc-sei-panel-loading') };
}

test('compact CRC launcher stays inside the native action bar and opens the inline extension panel', async () => {
  const { dom, messages } = page();
  try {
    const doc = dom.window.document;
    await until(() => nodes(doc, '#crc-sei-launcher').length === 1, 'native action-bar launcher');
    assertPlacement(doc);
    const button = doc.querySelector('#crc-sei-launcher');
    assert.equal(button.textContent.trim(), 'CRC');
    assert.equal(button.getAttribute('aria-label'), 'Adicionar CRC ao processo');
    assert.match(button.title, /Adicionar CRC/);
    assert.equal(button.type, 'button');
    button.click();
    await until(() => messages.length === 1 && !button.disabled, 'launcher click');
    assert.deepEqual(messages, [{ type: 'crc-open-assistant' }]);
    assert.equal(doc.querySelector('#crc-sei-launcher-status').hidden, true);
    const { panel, loading } = assertEmbedded(doc);
    assert.equal(panel.hidden, false);
    assert.equal(loading.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    vm.runInContext(launcherSource, dom.getInternalVMContext());
    await tick();
    assertPlacement(doc);
  } finally { dom.window.close(); }
});

test('top-only launcher finds native bars inside same-origin structural SEI frames', async () => {
  for (const toolbarFrame of ['ifrArvore', 'ifrConteudoVisualizacao', 'ifrVisualizacao']) {
    const { dom, messages } = page({ toolbarFrame });
    try {
      const top = dom.window.document;
      const frameDocument = top.getElementById(toolbarFrame).contentDocument;
      const bar = frameDocument.querySelector('#divArvoreAcoes');
      await until(() => frameDocument.querySelector('#crc-sei-launcher'), `${toolbarFrame} native launcher`);
      assertPlacement(top, bar);
      assert.equal(top.querySelector('#crc-sei-toolbar'), null);
      frameDocument.querySelector('#crc-sei-launcher').click();
      await until(() => messages.length === 1 && top.querySelector('#crc-sei-panel-frame'), 'frame button using the top-level extension runtime');
      assert.deepEqual(messages, [{ type: 'crc-open-assistant' }]);
      assertEmbedded(top);
      assert.equal(frameDocument.querySelector('#crc-sei-panel'), null);
    } finally { dom.window.close(); }
  }
});

test('launcher remains unique and the panel survives native-bar rebuilding and structural-frame replacement', async () => {
  const { dom, messages } = page({ toolbarFrame: 'ifrArvore' });
  try {
    const top = dom.window.document;
    const originalTree = top.querySelector('#ifrArvore');
    const bar = originalTree.contentDocument.querySelector('#divArvoreAcoes');
    await until(() => bar.querySelector('#crc-sei-launcher'), 'initial native launcher');
    bar.querySelector('#crc-sei-launcher').click();
    await until(() => messages.length === 1 && top.querySelector('#crc-sei-panel-frame'), 'panel before native bar changes');
    const original = assertEmbedded(top);
    const originalSrc = original.frame.src;
    bar.innerHTML = '<button id="native-refresh" type="button">Atualizar</button><button id="rp-button" type="button">RP</button>';
    await until(() => bar.querySelector('#crc-sei-launcher'), 'launcher after native bar.innerHTML');
    assertPlacement(top, bar);
    bar.querySelector('#crc-sei-toolbar').remove();
    await until(() => bar.querySelector('#crc-sei-launcher'), 'launcher restoration inside its bar');
    assertPlacement(top, bar);
    const replacement = top.createElement('iframe');
    replacement.id = 'ifrArvore';
    replacement.src = TREE_URL;
    originalTree.replaceWith(replacement);
    const replacementDocument = writeFrame(replacement, nativeBarMarkup());
    const replacementBar = replacementDocument.querySelector('#divArvoreAcoes');
    await until(() => replacementBar.querySelector('#crc-sei-launcher'), 'launcher in the replacement frame');
    assertPlacement(top, replacementBar);
    replacementBar.remove();
    await until(() => nodes(top, '#crc-sei-toolbar').length === 0, 'no fallback strip outside the native bar');
    replacementDocument.body.insertAdjacentHTML('afterbegin', nativeBarMarkup());
    await until(() => nodes(top, '#crc-sei-launcher').length === 1, 'restored native action bar');
    assertPlacement(top, replacementDocument.querySelector('#divArvoreAcoes'));
    assert.equal(assertEmbedded(top).frame, original.frame);
    assert.equal(top.querySelector('#crc-sei-panel'), original.panel);
    assert.equal(original.frame.src, originalSrc);
    assert.equal(original.panel.hidden, false);
    replacement.src = TREE_URL.replace('id_procedimento=42', 'id_procedimento=99');
    await until(() => nodes(top, '#crc-sei-toolbar').length === 0 && original.panel.hidden, 'launcher removal and panel hiding for another process');
    assert.equal(original.panel.hidden, true);
    assert.equal(original.panel.isConnected, true);
    assert.equal(assertEmbedded(top).frame, original.frame);
  } finally { dom.window.close(); }
});

test('native RP controls retain their nodes, behavior and position beside the CRC launcher', async () => {
  const { dom } = page({ toolbarFrame: 'ifrArvore' });
  try {
    const top = dom.window.document;
    const doc = top.querySelector('#ifrArvore').contentDocument;
    const bar = doc.querySelector('#divArvoreAcoes');
    const rp = bar.querySelector('#rp-button');
    let rpClicks = 0;
    rp.addEventListener('click', () => { rpClicks += 1; });
    await until(() => bar.querySelector('#crc-sei-launcher'), 'CRC beside RP');
    assert.equal(bar.querySelector('#rp-button'), rp);
    rp.click();
    assert.equal(rpClicks, 1);
    const neighboring = doc.createElement('button');
    neighboring.id = 'other-rp-action';
    neighboring.textContent = 'RP 2';
    bar.append(neighboring);
    const order = [...bar.children].map(node => node.id);
    await tick();
    await tick();
    assert.deepEqual([...bar.children].map(node => node.id), order);
    assertPlacement(top, bar);
    assert.equal(bar.querySelector('#rp-button'), rp);
    rp.click();
    assert.equal(rpClicks, 2);
  } finally { dom.window.close(); }
});

test('launcher is absent outside a positively identified SEI process', async () => {
  const cases = [
    { url: PAGE_URL.replace('https:', 'http:') },
    { url: PAGE_URL.replace('www.sei.mg.gov.br', 'example.org') },
    { url: PAGE_URL.replace('www.sei.mg.gov.br', 'www.sei.mg.gov.br.example.org') },
    { url: PAGE_URL.replace('procedimento_trabalhar', 'procedimento_controlar') },
    { url: PAGE_URL.replace('procedimento_trabalhar', 'login') },
    { url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=0') },
    { url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=abc') },
    { tree: false },
    { password: true },
    { treeSource: TREE_URL.replace('id_procedimento=42', 'id_procedimento=99') },
    { treeSource: TREE_URL.replace('www.sei.mg.gov.br', 'example.org') },
    { treeSource: 'about:blank' },
    { treeSource: null },
    { nativeBar: false },
  ];
  for (const options of cases) {
    const { dom, messages } = page(options);
    try {
      await tick();
      assert.equal(nodes(dom.window.document, '#crc-sei-toolbar').length, 0, JSON.stringify(options));
      assert.equal(messages.length, 0);
    } finally { dom.window.close(); }
  }
});

test('launcher never enters document-content or unrelated frames to find an imitation action bar', async () => {
  for (const options of [
    { toolbarFrame: 'ifrVisualizacao', frameSource: SHELL_URL.replace('arvore_visualizar', 'documento_render') },
    { toolbarFrame: 'ifrVisualizacao', frameSource: SHELL_URL.replace('arvore_visualizar', 'documento_visualizar') },
    { toolbarFrame: 'ifrConteudoVisualizacao', frameSource: SHELL_URL.replace('arvore_visualizar', 'documento_render') },
    { toolbarFrame: 'unrelated-frame' },
  ]) {
    const { dom, messages } = page(options);
    try {
      await tick();
      await tick();
      assert.equal(nodes(dom.window.document, '#crc-sei-toolbar').length, 0, JSON.stringify(options));
      assert.equal(messages.length, 0);
    } finally { dom.window.close(); }
  }
});

test('launcher failures show a reload instruction without exposing internal details', async () => {
  const detail = 'sensitive-internal-detail https://www.sei.mg.gov.br/?infra_hash=not-for-display';
  for (const sendMessage of [async () => { throw new Error(detail); }, async () => ({ ok: false, error: detail })]) {
    const { dom } = page({ sendMessage, toolbarFrame: 'ifrArvore' });
    try {
      const doc = dom.window.document.querySelector('#ifrArvore').contentDocument;
      await until(() => doc.querySelector('#crc-sei-launcher'), 'native launcher before message failure');
      doc.querySelector('#crc-sei-launcher').click();
      await until(() => !doc.querySelector('#crc-sei-launcher-status').hidden, 'generic launcher error');
      assert.match(doc.querySelector('#crc-sei-launcher-status').textContent, /atualiz|recarreg/i);
      assert.ok(!doc.body.textContent.includes(detail));
      assert.ok(!doc.body.textContent.includes('infra_hash'));
      assert.equal(doc.querySelector('#crc-sei-launcher').disabled, false);
      assert.equal(doc.querySelector('#crc-sei-launcher').textContent.trim(), 'CRC');
    } finally { dom.window.close(); }
  }
});

test('closing and reopening the embedded assistant preserves the same iframe and source', async () => {
  const actor = page({ toolbarFrame: 'ifrArvore' });
  const { dom, messages } = actor;
  try {
    const top = dom.window.document;
    const button = nodes(top, '#crc-sei-launcher')[0];
    button.click();
    await until(() => top.querySelector('#crc-sei-panel-frame') && !button.disabled, 'initial embedded panel');
    const initial = assertEmbedded(top);
    const src = initial.frame.src;
    initial.frame.dataset.testState = 'certificate-is-in-memory';
    initial.panel.querySelector('#crc-sei-loading-close').click();
    assert.equal(initial.panel.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(initial.frame.isConnected, true);
    button.click();
    await until(() => !initial.panel.hidden && !button.disabled, 'reopened embedded panel');
    assert.equal(assertEmbedded(top).frame, initial.frame);
    assert.equal(initial.frame.src, src);
    assert.equal(initial.frame.dataset.testState, 'certificate-is-in-memory');
    await actor.request({ type: 'crc-embedded-ready', viewId: initial.viewId });
    assert.equal(initial.loading.hidden, true);
    assert.deepEqual(await actor.request({ type: 'crc-hide-embedded-panel' }), { ok: true });
    assert.equal(initial.panel.hidden, true);
    assert.equal(initial.frame.isConnected, true);
    assert.deepEqual(await actor.request({ type: 'crc-show-embedded-panel' }), { ok: true });
    assert.equal(initial.panel.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(assertEmbedded(top).frame, initial.frame);
    assert.equal(initial.frame.src, src);
    assert.equal(initial.loading.hidden, true, 'Ready state must survive closing and reopening');
    assert.deepEqual(messages, Array.from({ length: 3 }, () => ({ type: 'crc-open-assistant' })));
  } finally { dom.window.close(); }
});

test('iframe load and unmatched view messages cannot mark the panel ready', async () => {
  const actor = page();
  const { dom } = actor;
  try {
    await actor.request({ type: 'crc-show-embedded-panel' });
    const { frame, loading, viewId } = assertEmbedded(dom.window.document);
    frame.dispatchEvent(new dom.window.Event('load'));
    await tick();
    assert.equal(loading.hidden, false, 'A blocked iframe navigation may still fire load');
    for (const wrongView of [undefined, '', VIEW_ID, viewId.toUpperCase(), `${viewId}x`]) {
      if (wrongView === viewId) continue;
      await actor.request({ type: 'crc-embedded-ready', viewId: wrongView });
      assert.equal(loading.hidden, false);
    }
    await actor.request({ type: 'crc-embedded-ready', viewId });
    assert.equal(loading.hidden, true);
  } finally { dom.window.close(); }
});

test('launcher ignores external show, hide and ready messages, including window.postMessage', async () => {
  const actor = page();
  const { dom } = actor;
  const untrusted = [
    trustedBackground({ id: 'other-extension' }),
    trustedBackground({ id: undefined }),
    trustedBackground({ tab: { id: 7, url: PAGE_URL } }),
    trustedBackground({ url: PAGE_URL }),
    trustedBackground({ url: extensionUrl('panel.html') }),
    trustedBackground({ url: extensionUrl('background.js/extra') }),
    trustedBackground({ url: `chrome-extension://other-extension/background.js` }),
  ];
  try {
    for (const sender of untrusted) {
      const sent = actor.dispatch({ type: 'crc-show-embedded-panel' }, sender);
      assert.ok(sent.returns.every(value => value === false));
      assert.equal(sent.responses.length, 0);
    }
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'crc-show-embedded-panel' }, origin: new URL(PAGE_URL).origin,
      source: dom.window,
    }));
    await tick();
    assert.equal(dom.window.document.querySelector('#crc-sei-panel'), null);
    assert.equal(actor.messages.length, 0);
    await actor.request({ type: 'crc-show-embedded-panel' });
    const { panel, loading, viewId } = assertEmbedded(dom.window.document);
    for (const sender of untrusted) {
      for (const message of [{ type: 'crc-hide-embedded-panel' }, { type: 'crc-embedded-ready', viewId }]) {
        const sent = actor.dispatch(message, sender);
        assert.ok(sent.returns.every(value => value === false));
        assert.equal(sent.responses.length, 0);
        assert.equal(panel.hidden, false);
        assert.equal(loading.hidden, false);
      }
    }
    const unrelated = actor.dispatch({ type: 'unrelated-feature' });
    assert.ok(unrelated.returns.every(value => value === false));
    assert.equal(unrelated.responses.length, 0);
  } finally { dom.window.close(); }
});

test('trusted requests cannot open an embedded panel after the process changes', async () => {
  const actor = page();
  try {
    actor.dom.window.history.replaceState({}, '', PAGE_URL.replace('id_procedimento=42', 'id_procedimento=99'));
    assert.deepEqual(await actor.request({ type: 'crc-show-embedded-panel' }), { ok: false });
    assert.equal(actor.dom.window.document.querySelector('#crc-sei-panel'), null);
    assert.equal(actor.messages.length, 0);
  } finally { actor.dom.window.close(); }
});

test('background opens only the verified sender tab and tolerates an absent new-panel listener', async () => {
  const running = worker();
  running.browser.tabs[999] = { id: 999, url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=99') };
  assert.deepEqual(await running.request({ type: 'crc-open-assistant', tabId: 999 }), { ok: true, tabId: 7 });
  assert.deepEqual(running.browser.requestedTabs, [7]);
  assert.deepEqual(running.browser.activations, [{ type: 'crc-assistant-activate', tabId: 7 }]);
  assert.equal(running.browser.tabMessages.length, 0);
  running.browser.activationHandler = async () => { throw new Error('Receiving end does not exist'); };
  assert.deepEqual(await running.request({ type: 'crc-open-assistant' }), { ok: true, tabId: 7 });
  assert.equal(running.browser.activations.length, 2);
  assert.equal(running.browser.created.length, 0);
  assert.deepEqual(running.browser.session, {}, 'Opening must not retain obsolete popup-window IDs');
});

test('background panel context and close use the real embedding tab, never the query or message tabId', async () => {
  const running = worker();
  const sender = panelSender({
    url: extensionUrl(`panel.html?embedded=1&tab=999&view=${VIEW_ID}`),
    tab: { id: 7, url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=99') },
  });
  assert.deepEqual(await running.request({ type: 'crc-panel-context', tabId: 999 }, sender), { ok: true, tabId: 7 });
  assert.deepEqual(running.browser.requestedTabs, [7]);
  assert.deepEqual(running.browser.tabMessages, [{
    tabId: 7, message: { type: 'crc-embedded-ready', viewId: VIEW_ID }, options: { frameId: 0 },
  }]);
  assert.deepEqual(await running.request({ type: 'crc-panel-hide', tabId: 999 }, sender), { ok: true });
  assert.deepEqual(running.browser.requestedTabs, [7, 7]);
  assert.deepEqual(running.browser.tabMessages[1], {
    tabId: 7, message: { type: 'crc-hide-embedded-panel' }, options: { frameId: 0 },
  });
  assert.equal(running.browser.created.length, 0);
});

test('background emits ready only for an authenticated panel with a valid view identifier', async () => {
  const running = worker();
  for (const suffix of ['', '?embedded=1', '?view=invalid', '?view=' + VIEW_ID + 'x']) {
    assert.deepEqual(await running.request({ type: 'crc-panel-context' }, panelSender({ url: extensionUrl('panel.html' + suffix) })), { ok: true, tabId: 7 });
  }
  assert.equal(running.browser.tabMessages.length, 0);
  running.browser.tabMessageHandler = async () => { throw new Error('Page refreshed'); };
  assert.deepEqual(await running.request({ type: 'crc-panel-context' }, panelSender()), { ok: true, tabId: 7 });
  assert.deepEqual(running.browser.tabMessages, [{
    tabId: 7, message: { type: 'crc-embedded-ready', viewId: VIEW_ID }, options: { frameId: 0 },
  }]);
  assert.equal(running.browser.created.length, 0);
});

test('native clicks and browser actions share one embedded panel across concurrent opens and worker restarts', async () => {
  const browser = createBrowserState();
  let running = worker(browser);
  const actor = page({
    toolbarFrame: 'ifrArvore',
    sendMessage: message => running.request(message, validSender()),
  });
  browser.tabMessageHandler = async (tabId, message, options) => {
    assert.equal(tabId, 7);
    assert.deepEqual(clone(options), { frameId: 0 });
    return actor.request(message);
  };
  let release;
  browser.getGate = new Promise(resolve => { release = resolve; });
  try {
    const top = actor.dom.window.document;
    const button = nodes(top, '#crc-sei-launcher')[0];
    const first = running.actionClick({ id: 7, url: PAGE_URL });
    const second = running.actionClick({ id: 7, url: PAGE_URL });
    button.click();
    await until(() => browser.requestedTabs.length === 1, 'one in-flight request for concurrent opens');
    assert.equal(actor.messages.length, 1);
    assert.equal(browser.created.length, 0);
    assert.equal(top.querySelector('#crc-sei-panel'), null);
    release();
    await Promise.all([first, second]);
    await until(() => !button.disabled, 'native click finishing');
    const initial = assertEmbedded(top);
    assert.equal(browser.activations.length, 1);
    assert.equal(initial.panel.hidden, false);
    assert.deepEqual(browser.titles, Array.from({ length: 2 }, () => ({ tabId: 7, title: 'CRC no SEI — abrir painel' })));
    await actor.request({ type: 'crc-hide-embedded-panel' });
    running = worker(browser);
    await running.actionClick({ id: 7, url: PAGE_URL });
    assert.equal(initial.panel.hidden, false);
    assert.equal(assertEmbedded(top).frame, initial.frame);
    assert.equal(browser.created.length, 0);
    assert.deepEqual(browser.session, {});
  } finally { release(); actor.dom.window.close(); }
});

test('browser action outside a process gives guidance without opening a panel or window', async () => {
  const running = worker();
  for (const tab of [undefined, {}, { id: '7', url: PAGE_URL }, { id: 7, url: PAGE_URL.replace('procedimento_trabalhar', 'login') }, { id: 7, url: 'https://example.org/' }]) {
    await running.actionClick(tab);
  }
  assert.equal(running.browser.tabMessages.length, 0);
  assert.equal(running.browser.activations.length, 0);
  assert.equal(running.browser.created.length, 0);
  assert.equal(running.browser.titles.length, 2);
  for (const entry of running.browser.titles) assert.match(entry.title, /Abra um processo no SEI/);
  running.browser.tabMessageHandler = async () => { throw new Error('Content script unavailable'); };
  await running.actionClick({ id: 7, url: PAGE_URL });
  assert.match(running.browser.titles.at(-1).title, /atualize a página/);
  assert.equal(running.browser.created.length, 0);
});

test('background rejects untrusted launcher senders and leaves other message types to their own listener', async () => {
  const running = worker();
  const senders = [
    validSender({ id: 'other-extension' }),
    validSender({ frameId: 1 }),
    validSender({ frameId: undefined }),
    validSender({ tab: undefined }),
    validSender({ tab: { id: -1 } }),
    validSender({ tab: { id: '7' } }),
    validSender({ tab: { id: 7.5 } }),
    validSender({ url: PAGE_URL.replace('https:', 'http:') }),
    validSender({ url: PAGE_URL.replace('www.sei.mg.gov.br', 'example.org') }),
    validSender({ url: PAGE_URL.replace('www.sei.mg.gov.br', 'www.sei.mg.gov.br.example.org') }),
    validSender({ url: PAGE_URL.replace('www.sei.mg.gov.br', 'www.sei.mg.gov.br:444') }),
    validSender({ url: PAGE_URL.replace('https://', 'https://someone@') }),
    validSender({ url: PAGE_URL.replace('procedimento_trabalhar', 'procedimento_controlar') }),
    validSender({ url: PAGE_URL.replace('procedimento_trabalhar', 'login') }),
    validSender({ url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=0') }),
    validSender({ url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=-1') }),
    validSender({ url: PAGE_URL.replace('id_procedimento=42', 'id_procedimento=abc') }),
    validSender({ url: PAGE_URL.replace('controlador.php', 'other.php') }),
    validSender({ url: 'not-a-url' }),
  ];
  for (const sender of senders) {
    const result = await running.request({ type: 'crc-open-assistant', tabId: 7 }, sender);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error);
  }
  assert.equal(running.browser.created.length, 0);
  assert.equal(running.browser.activations.length, 0);
  assert.equal(running.browser.tabMessages.length, 0);
  assert.equal(running.browser.requestedTabs.length, 0);
  const unrelated = running.dispatch({ type: 'unrelated-feature' });
  assert.ok(unrelated.returns.every(value => value === false));
  assert.equal(unrelated.responses.length, 0);
});

test('background refuses a stale process sender or an embedding tab that has navigated away', async () => {
  const running = worker();
  for (const currentUrl of [
    PAGE_URL.replace('id_procedimento=42', 'id_procedimento=99'),
    PAGE_URL.replace('www.sei.mg.gov.br', 'sei.mg.gov.br'),
    PAGE_URL.replace('procedimento_trabalhar', 'login'),
    'https://example.org/',
  ]) {
    running.browser.tabs[7].url = currentUrl;
    const result = await running.request({ type: 'crc-open-assistant' });
    assert.equal(result.ok, false);
  }
  running.browser.tabs[7].url = PAGE_URL.replace('procedimento_trabalhar', 'login');
  for (const type of ['crc-panel-context', 'crc-panel-hide']) {
    const result = await running.request({ type }, panelSender());
    assert.equal(result.ok, false);
  }
  delete running.browser.tabs[7];
  for (const [type, sender] of [
    ['crc-open-assistant', validSender()],
    ['crc-panel-context', panelSender()],
    ['crc-panel-hide', panelSender()],
  ]) {
    const result = await running.request({ type }, sender);
    assert.equal(result.ok, false);
  }
  assert.equal(running.browser.activations.length, 0);
  assert.deepEqual(running.browser.tabMessages, Array.from({ length: 2 }, () => ({
    tabId: 7, message: { type: 'crc-embedded-ready', viewId: VIEW_ID }, options: { frameId: 0 },
  })), 'The loaded panel may display a context error, but must not activate or hide anything');
  assert.equal(running.browser.created.length, 0);
});

test('context and hide require the exact extension panel path in a real subframe', async () => {
  const running = worker();
  const senders = [
    panelSender({ id: 'other-extension' }),
    panelSender({ url: `chrome-extension://other-extension/panel.html` }),
    panelSender({ url: PAGE_URL }),
    panelSender({ url: extensionUrl('panel.html.extra') }),
    panelSender({ url: extensionUrl('panel.html/extra') }),
    panelSender({ url: extensionUrl('nested/panel.html') }),
    panelSender({ url: extensionUrl('background.js') }),
    panelSender({ url: 'not-a-url' }),
    panelSender({ tab: undefined }),
    panelSender({ tab: { id: -1 } }),
    panelSender({ tab: { id: '7' } }),
    panelSender({ tab: { id: 7.5 } }),
    panelSender({ frameId: 0 }),
    panelSender({ frameId: -1 }),
    panelSender({ frameId: '5' }),
    panelSender({ frameId: undefined }),
  ];
  for (const sender of senders) {
    for (const type of ['crc-panel-context', 'crc-panel-hide']) {
      const result = await running.request({ type, tabId: 7 }, sender);
      assert.equal(result.ok, false, `${type}: ${JSON.stringify(sender)}`);
      assert.ok(result.error);
    }
  }
  assert.equal(running.browser.requestedTabs.length, 0);
  assert.equal(running.browser.tabMessages.length, 0);
  assert.equal(running.browser.created.length, 0);
});

test('receipt messages remain available only to the embedded extension panel', async () => {
  const running = worker();
  const key = 'crc-receipt:42:1100:90347840000703';
  const acquired = await running.request({ type: 'receipt-acquire', key, receipt: {
    stage: 'preparing', processId: '42', unitId: '1100', cnpj: '90347840000703', sha256: 'test-digest',
  } }, panelSender());
  assert.equal(acquired.ok, true);
  assert.match(acquired.receipt.token, /^[a-f0-9-]{36}$/);
  const snapshot = clone(running.browser.session);
  const untrusted = [
    validSender(),
    panelSender({ frameId: 0 }),
    panelSender({ tab: undefined }),
    panelSender({ id: 'other-extension' }),
    panelSender({ url: extensionUrl('panel.html.extra') }),
    panelSender({ url: PAGE_URL }),
  ];
  for (const sender of untrusted) {
    for (const type of ['receipt-acquire', 'receipt-get', 'receipt-update', 'receipt-release']) {
      const sent = running.dispatch({ type, key, token: acquired.receipt.token, changes: { stage: 'complete' } }, sender);
      assert.ok(sent.returns.every(value => value === false));
      assert.equal(sent.responses.length, 0);
    }
  }
  await tick();
  assert.deepEqual(running.browser.session, snapshot);
  assert.deepEqual(await running.request({ type: 'receipt-get', key }, panelSender()), { ok: true, receipt: acquired.receipt });
  const denied = await running.request({ type: 'receipt-release', key, token: 'wrong-owner' }, panelSender());
  assert.equal(denied.ok, false);
  assert.deepEqual(running.browser.session, snapshot);
  assert.deepEqual(await running.request({ type: 'receipt-release', key, token: acquired.receipt.token }, panelSender()), { ok: true });
  assert.deepEqual(running.browser.session, {});
  assert.equal(running.browser.created.length, 0);
});

test('SEI 5 top id_protocolo with id_procedimento structural frames opens CRC', async () => {
  const url = PAGE_URL.replace('www.sei', 'sei').replace('id_procedimento=42', 'id_protocolo=42');
  const browser = createBrowserState();
  browser.tabs[7].url = url;
  const running = worker(browser);
  const actor = page({url, treeSource: TREE_URL.replace('www.sei', 'sei'), frameSource: SHELL_URL.replace('www.sei', 'sei'), toolbarFrame:'ifrConteudoVisualizacao', sendMessage: m => running.request(m, validSender({url,tab:{id:7,url}}))});
  try {
    const button = nodes(actor.dom.window.document, '#crc-sei-launcher')[0];
    assert.ok(button, 'SEI 5 must show CRC for the live page parameter layout');
    button.click();
    await until(() => actor.dom.window.document.querySelector('#crc-sei-panel'), 'panel opened');
    assert.equal(assertEmbedded(actor.dom.window.document).panel.hidden, false);
    assert.deepEqual(await running.request({type:'crc-panel-context'}, panelSender()), {ok:true,tabId:7});
    browser.tabs[7].url = url.replace('id_protocolo=42','id_protocolo=99');
    assert.equal((await running.request({type:'crc-open-assistant'}, validSender({url,tab:{id:7,url}}))).ok,false);
  } finally {actor.dom.window.close();}
});

test('SEI 5 id_protocolo still rejects a tree from another process', () => {
  const actor = page({url:PAGE_URL.replace('id_procedimento=42','id_protocolo=42'),treeSource:TREE_URL.replace('id_procedimento=42','id_procedimento=99')});
  try {assert.equal(nodes(actor.dom.window.document,'#crc-sei-launcher').length,0);}
  finally {actor.dom.window.close();}
});
