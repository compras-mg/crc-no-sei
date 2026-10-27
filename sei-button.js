// SEI 5: id_protocolo identifica o processo apenas em procedimento_trabalhar.
// Em páginas de documento, id_protocolo não deve ser usado como ID de processo.
/* Botão da barra nativa. O controlador permanece no mundo isolado do frame superior. */
(() => {
  'use strict';
  if (window !== window.top || globalThis.__crcSeiLauncherInstalled) return;
  globalThis.__crcSeiLauncherInstalled = true;

  let toolbar;
  let refreshPending = false;
  let embeddedPanel;
  let embeddedFrame;
  let embeddedLoading;
  let embeddedView = '';
  let loadingTimer;
  let openingPanel;
  const documentObservers = new Map();
  const frameListeners = new Map();
  const shellFrames = 'iframe#ifrArvore, iframe#ifrConteudoVisualizacao, iframe#ifrVisualizacao';

  function isProcessPage() {
    try {
      const url = new URL(location.href);
      if (url.protocol !== 'https:' || url.port || url.username || url.password ||
          !['www.sei.mg.gov.br', 'sei.mg.gov.br'].includes(url.hostname) ||
          !/\/controlador\.php$/.test(url.pathname) ||
          url.searchParams.get('acao') !== 'procedimento_trabalhar') return false;
      const processId = (url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) || '';
      if (!/^[1-9]\d*$/.test(processId) || document.querySelector('input[type="password"]')) return false;
      const tree = document.querySelector('iframe#ifrArvore');
      if (!tree) return false;
      const source = tree.getAttribute('src');
      if (!source || source === 'about:blank') return false;
      const treeUrl = new URL(source, url);
      return treeUrl.origin === url.origin && /\/controlador\.php$/.test(treeUrl.pathname) &&
        ['procedimento_visualizar', 'arvore_visualizar'].includes(treeUrl.searchParams.get('acao')) &&
        (treeUrl.searchParams.get('id_procedimento') || (treeUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? treeUrl.searchParams.get('id_protocolo') : null)) === processId;
    } catch { return false; }
  }

  function hideEmbeddedPanel() {
    if (!embeddedPanel) return;
    // Recolher preserva o iframe: seleção, PDF e operação continuam na memória.
    embeddedPanel.hidden = true;
    const button = toolbar?.querySelector('#crc-sei-launcher');
    button?.setAttribute('aria-expanded', 'false');
    button?.focus({ preventScroll: true });
  }

  function createEmbeddedPanel() {
    clearTimeout(loadingTimer);
    embeddedView = crypto.randomUUID();
    embeddedPanel = document.createElement('section');
    embeddedPanel.id = 'crc-sei-panel';
    embeddedPanel.setAttribute('aria-label', 'Painel CRC no SEI');

    embeddedFrame = document.createElement('iframe');
    embeddedFrame.id = 'crc-sei-panel-frame';
    embeddedFrame.title = 'CRC no SEI — fornecedor e certificado';
    embeddedFrame.referrerPolicy = 'no-referrer';
    embeddedFrame.src = chrome.runtime.getURL('panel.html?embedded=1&view=' + embeddedView);

    // Estado de abertura e saída acessível mesmo se o navegador bloquear o iframe.
    embeddedLoading = document.createElement('div');
    embeddedLoading.id = 'crc-sei-panel-loading';
    const heading = document.createElement('div');
    heading.className = 'crc-sei-loading-header';
    const title = document.createElement('strong');
    title.textContent = 'CRC no SEI';
    const close = document.createElement('button');
    close.id = 'crc-sei-loading-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Fechar painel';
    close.setAttribute('aria-label', 'Fechar painel');
    close.addEventListener('click', hideEmbeddedPanel);
    heading.append(title, close);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Abrindo assistente…';
    embeddedLoading.append(heading, status);
    embeddedPanel.append(embeddedFrame, embeddedLoading);
    // Fora dos contêineres e iframes que o SEI recria ao selecionar documentos.
    document.body.append(embeddedPanel);
    loadingTimer = setTimeout(() => {
      if (!embeddedLoading?.hidden) status.textContent = 'Não foi possível carregar o painel. Recarregue a extensão e atualize a página do SEI.';
    }, 10000);
  }

  function openEmbeddedPanel() {
    if (openingPanel) return openingPanel;
    openingPanel = (async () => {
      if (!isProcessPage()) throw new Error('Abra um processo no SEI.');
      const result = await chrome.runtime.sendMessage({ type: 'crc-open-assistant' });
      if (!result?.ok) throw new Error('Assistente indisponível');
      if (!embeddedPanel?.isConnected) createEmbeddedPanel();
      embeddedPanel.hidden = false;
      toolbar?.querySelector('#crc-sei-launcher')?.setAttribute('aria-expanded', 'true');
      if (embeddedLoading.hidden) embeddedFrame.focus();
      return { ok: true };
    })().finally(() => { openingPanel = null; });
    return openingPanel;
  }

  function createToolbar(ownerDocument) {
    const host = ownerDocument.createElement('span');
    host.id = 'crc-sei-toolbar';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'CRC do fornecedor');

    const button = ownerDocument.createElement('button');
    button.id = 'crc-sei-launcher';
    button.type = 'button';
    button.title = 'Adicionar CRC ao processo';
    button.setAttribute('aria-label', 'Adicionar CRC ao processo');
    button.setAttribute('aria-expanded', String(Boolean(embeddedPanel && !embeddedPanel.hidden)));

    const label = ownerDocument.createElement('span');
    label.textContent = 'CRC';
    button.append(label);

    const status = ownerDocument.createElement('span');
    status.id = 'crc-sei-launcher-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    button.setAttribute('aria-describedby', status.id);

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      if (!isProcessPage()) { refresh(); return; }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      label.textContent = '…';
      status.hidden = true;
      status.textContent = '';
      try {
        await openEmbeddedPanel();
      } catch {
        status.textContent = 'Não foi possível abrir. Atualize esta página do SEI e tente novamente.';
        status.hidden = false;
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        label.textContent = 'CRC';
      }
    });
    host.append(button, status);
    return host;
  }

  function collectShellDocuments(active) {
    const documents = new Set([document]);
    const frames = new Set();
    if (active) {
      const processUrl = new URL(location.href);
      // Um iframe de visualização pode mostrar documentos. Apenas as telas
      // estruturais, na mesma origem e no mesmo processo, são percorridas.
      for (const current of documents) {
        for (const frame of current.querySelectorAll(shellFrames)) {
          frames.add(frame);
          try {
            const child = frame.contentDocument;
            if (!child?.documentElement) continue;
            const url = new URL(child.URL);
            if (url.origin !== processUrl.origin || !/\/controlador\.php$/.test(url.pathname) ||
                !['procedimento_visualizar', 'arvore_visualizar', 'procedimento_trabalhar'].includes(url.searchParams.get('acao')) ||
                (url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) !== (processUrl.searchParams.get('id_procedimento') || (processUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? processUrl.searchParams.get('id_protocolo') : null))) continue;
            documents.add(child);
          } catch { /* Frames de outra origem não são acessados. */ }
        }
      }
    }
    return { documents, frames };
  }

  function observeShell({ documents, frames }) {
    for (const [current, observer] of documentObservers) {
      if (documents.has(current)) continue;
      observer.disconnect();
      documentObservers.delete(current);
    }
    for (const current of documents) {
      if (documentObservers.has(current) || !current.documentElement) continue;
      const observer = new MutationObserver(scheduleRefresh);
      observer.observe(current.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
      });
      documentObservers.set(current, observer);
    }
    for (const [frame, listener] of frameListeners) {
      if (frames.has(frame)) continue;
      frame.removeEventListener('load', listener);
      frameListeners.delete(frame);
    }
    for (const frame of frames) {
      if (frameListeners.has(frame)) continue;
      frame.addEventListener('load', scheduleRefresh);
      frameListeners.set(frame, scheduleRefresh);
    }
  }

  function refresh() {
    refreshPending = false;
    const active = isProcessPage();
    if (!active && embeddedPanel && !embeddedPanel.hidden) hideEmbeddedPanel();
    const shell = collectShellDocuments(active);
    observeShell(shell);
    const actionBar = active && [...shell.documents]
      .map(current => current.getElementById('divArvoreAcoes')).find(Boolean);
    if (!actionBar) { toolbar?.remove(); return; }
    toolbar ||= createToolbar(actionBar.ownerDocument);
    // O SEI substitui innerHTML a cada seleção. Reinserimos apenas se removido;
    // a posição dos outros botões, inclusive de outras extensões, é preservada.
    if (toolbar.parentElement !== actionBar) actionBar.append(toolbar);
  }

  function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    queueMicrotask(refresh);
  }

  // Os callbacks pertencem a este frame superior, inclusive quando o botão
  // está na barra de um iframe. A mensagem mantém a validação original da aba.
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return false;
    if (message?.type === 'crc-show-embedded-panel') {
      openEmbeddedPanel().then(respond).catch(() => respond({ ok: false }));
      return true;
    }
    if (message?.type === 'crc-hide-embedded-panel') {
      hideEmbeddedPanel();
      respond({ ok: true });
      return true;
    }
    if (message?.type === 'crc-embedded-ready') {
      if (embeddedPanel && message.viewId === embeddedView) {
        clearTimeout(loadingTimer);
        embeddedLoading.hidden = true;
        if (!embeddedPanel.hidden) embeddedFrame.focus();
      }
      respond({ ok: true });
      return true;
    }
    return false;
  });
  window.addEventListener('pageshow', scheduleRefresh);
  window.addEventListener('popstate', scheduleRefresh);
  refresh();
})();
