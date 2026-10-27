// SEI 5: id_protocolo identifica o processo apenas em procedimento_trabalhar.
// Em páginas de documento, id_protocolo não deve ser usado como ID de processo.
/**
 * SEI browser adapter. Every exported function is self-contained so Chrome can
 * serialize it through chrome.scripting.executeScript({ func, args }).
 *
 * No code from another extension is included. The integration points were
 * checked against the official SEI user manual and public SEI 4.1 fixtures:
 *   https://manuais.processoeletronico.gov.br/pt-br/latest/SEI/Operacoes_basicas_com_documentos.html
 *   https://github.com/SEI-Pro/sei-pro
 *
 * Contract:
 * - inspectSeiFrame() reads the current frame. With {html, url}, it only parses
 *   that supplied document and does not read the browser tab.
 * - fetchSeiResource() is a bounded, same-origin, read-only fetch. A resource
 *   must have been observed in this tab, or in an earlier downloaded page.
 * - navigateToExternalForm() clicks existing SEI navigation controls.
 * - prepareExternalDocument() returns type-changing, uploading, or prepared.
 *   It never saves, even when a caller supplies submit:true. Call the separate
 *   submitPreparedExternalDocument() after the user's attachment action.
 * - submitPreparedExternalDocument() returns saving, never success. The caller
 *   must confirm the new document in the process tree; it must not retry an
 *   uncertain submission automatically.
 *
 * Use ISOLATED execution world. Keep orchestration in the extension. No eval,
 * generated action URLs, credential collection, or external services are used.
 */

export function inspectSeiFrame(input = {}) {
  const detached = Object.prototype.hasOwnProperty.call(input, 'html');
  const doc = detached
    ? new DOMParser().parseFromString(String(input.html || ''), 'text/html')
    : document;
  const base = new URL(detached ? String(input.url) : location.href);
  // Um painel da própria extensão pode existir como iframe nesta aba.
  // Ele não faz parte da estrutura ou dos documentos do processo.
  if (!detached && (base.protocol !== 'https:' || !['www.sei.mg.gov.br', 'sei.mg.gov.br'].includes(base.hostname))) {
    return { error: 'Este frame não pertence ao SEI de Minas Gerais.' };
  }
  const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const unescapeHtml = value => String(value || '').replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (whole, dec, hex) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ({'&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#x27;': "'"})[whole.toLowerCase()] || whole;
  });
  const plain = value => normalize(unescapeHtml(String(value || '').replace(/<[^>]*>/g, ' ')));
  const observed = new Set();
  function resolve(raw) {
    if (!raw || String(raw).length > 16000) return null;
    try {
      const url = new URL(unescapeHtml(raw), base);
      if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password) return null;
      url.hash = '';
      observed.add(url.href);
      return url;
    } catch { return null; }
  }
  function quoted(source, start) {
    const quote = source[start];
    if (quote !== "'" && quote !== '"') return null;
    let value = '';
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i];
      if (c === quote) return {value, end: i + 1};
      if (c !== '\\') { value += c; continue; }
      const next = source[++i];
      if (next === undefined) return null;
      if (next === '\r' || next === '\n') {
        if (next === '\r' && source[i + 1] === '\n') i++;
      } else if (next === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
        value += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16)); i += 2;
      } else if (next === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(i + 1, i + 5))) {
        value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4;
      } else {
        const escapes = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0'};
        value += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
      }
    }
    return null;
  }
  function argumentsAt(source, start) {
    const args = [];
    let i = start;
    for (let count = 0; count < 40; count++) {
      while (/\s/.test(source[i] || '') && i < source.length) i++;
      if (source[i] === ')') return args;
      if (source[i] === '"' || source[i] === "'") {
        const result = quoted(source, i);
        if (!result) return null;
        args.push(result.value); i = result.end;
      } else {
        // The explicit scalar parser also rejects arbitrary JS expressions.
        const scalar = /^(null|undefined|true|false|-?\d+(?:\.\d+)?)(?=\s*[,\)])/.exec(source.slice(i));
        if (!scalar) return null;
        const raw = scalar[0];
        args.push(raw === 'null' || raw === 'undefined' ? null : raw === 'true' ? true : raw === 'false' ? false : Number(raw));
        i += raw.length;
      }
      while (/\s/.test(source[i] || '') && i < source.length) i++;
      if (source[i] === ')') return args;
      if (source[i] !== ',') return null;
      i++;
    }
    return null;
  }
  function collectAttributes(html) {
    for (const match of String(html).matchAll(/\b(?:href|src|action)\s*=\s*(["'])(.*?)\1/gi)) resolve(match[2]);
  }
  const nodes = new Map();
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent || '';
    for (const match of text.matchAll(/\bNos\[(\d+)\]\s*=\s*new\s+infraArvoreNo\s*\(/g)) {
      const args = argumentsAt(text, match.index + match[0].length);
      if (args && typeof args[0] === 'string') nodes.set(match[1], {args, props: {}});
    }
    for (const match of text.matchAll(/\bNos\[(\d+)\]\s*\.\s*(src|acoes)\s*=\s*(["'])/g)) {
      const entry = nodes.get(match[1]);
      const result = quoted(text, match.index + match[0].length - 1);
      if (entry && result) entry.props[match[2]] = result.value;
    }
    for (const match of text.matchAll(/\bNos\[(\d+)\]\s*\.\s*carregado\s*=\s*(true|false)/g)) {
      const entry = nodes.get(match[1]);
      if (entry) entry.loaded = match[2] === 'true';
    }
    // Auxiliary signed links such as "expand all folders" also occur outside Nos.
    for (const match of text.matchAll(/(?:https?:\/\/[^\s"'<>\\]+|(?:\.\/)?controlador\.php\?[^\s"'<>\\]+)/g)) resolve(match[0]);
  }
  for (const el of doc.querySelectorAll('[href], [src], form[action]')) {
    resolve(el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('action'));
  }
  for (const node of nodes.values()) {
    resolve(node.args[3]);
    resolve(node.props.src);
    collectAttributes(node.props.acoes || '');
  }
  const roots = [...nodes.values()].filter(node => node.args[0] === 'PROCESSO');
  const hiddenId = doc.querySelector('#hdnIdProcedimento')?.value || '';
  const addressId = (base.searchParams.get('id_procedimento') || (base.searchParams.get('acao') === 'procedimento_trabalhar' ? base.searchParams.get('id_protocolo') : null)) || '';
  let fallbackId = '';
  let fallbackUnit = '';
  if (!detached) {
    try {
      const parentUrl = new URL(window.top.location.href);
      if (parentUrl.origin === base.origin) {
        fallbackId = (parentUrl.searchParams.get('id_procedimento') || (parentUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? parentUrl.searchParams.get('id_protocolo') : null)) || '';
        fallbackUnit = parentUrl.searchParams.get('infra_unidade_atual') || '';
      }
    } catch { /* A cross-origin parent is not inspected. */ }
  }
  const candidateId = hiddenId || addressId || fallbackId;
  const root = roots.find(node => String(node.args[1]) === candidateId) || (roots.length === 1 ? roots[0] : null);
  const processId = candidateId || (root ? String(root.args[1]) : '');
  const sources = [hiddenId, addressId, fallbackId, root && String(root.args[1])].filter(Boolean);
  const processMismatch = new Set(sources).size > 1;
  const unitId = base.searchParams.get('infra_unidade_atual') || fallbackUnit || '';
  const form = doc.querySelector('#frmDocumentoCadastro');
  const formUrl = form ? resolve(form.getAttribute('action') || base.href) : null;
  const navigationPage = ['procedimento_visualizar', 'procedimento_trabalhar', 'procedimento_paginar', 'arvore_visualizar', 'documento_escolher_tipo'].includes(base.searchParams.get('acao'));
  function visible(element) {
    if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.style?.display === 'none' || ['hidden', 'collapse'].includes(node.style?.visibility)) return false;
      const style = doc.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility)) return false;
    }
    return true;
  }
  function navigationUrl(raw, action, allowHiddenId = false) {
    const url = resolve(raw);
    const id = (url?.searchParams.get('id_procedimento') || (url?.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) || (allowHiddenId ? hiddenId || addressId : '');
    return !processMismatch && !!url && url.searchParams.get('acao') === action && !!url.searchParams.get('infra_hash') &&
      !!processId && id === processId && (!unitId || !url.searchParams.get('infra_unidade_atual') || url.searchParams.get('infra_unidade_atual') === unitId);
  }
  const navigationAnchors = navigationPage ? [...doc.querySelectorAll('a[href]')].filter(anchor =>
    navigationUrl(anchor.getAttribute('href'), 'documento_escolher_tipo') || navigationUrl(anchor.getAttribute('href'), 'documento_receber')).filter(visible) : [];
  const choiceForm = navigationPage ? doc.querySelector('#frmDocumentoEscolherTipo') : null;
  const validChoice = choiceForm && navigationUrl(choiceForm.getAttribute('action') || base.href, 'documento_escolher_tipo');
  const externalChoice = validChoice && [...choiceForm.querySelectorAll('#tblSeries a, #tblSeries input, #tblSeries button')].some(element =>
    visible(element) && /\bescolher\s*\(\s*-1\s*\)/.test(element.getAttribute('onclick') || ''));
  function inProcess(url) {
    const id = (url?.searchParams.get('id_procedimento') || (url?.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null));
    return !!url && (!id || !processId || id === processId);
  }
  function signedAction(name, predicate = () => true) {
    for (const raw of observed) {
      const url = new URL(raw);
      if (url.searchParams.get('acao') === name && url.searchParams.get('infra_hash') && inProcess(url) && predicate(url)) return url.href;
    }
    return undefined;
  }
  const byNodeId = new Map([...nodes.values()].map(node => [String(node.args[1]), node]));
  function belongs(node) {
    if (!processId) return false;
    let parent = node.args[2];
    const visited = new Set();
    while (parent && !visited.has(String(parent))) {
      if (String(parent) === processId) return true;
      visited.add(String(parent));
      parent = byNodeId.get(String(parent))?.args[2];
    }
    const url = resolve(node.args[3]);
    return (url?.searchParams.get('id_procedimento') || (url?.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) === processId;
  }
  const docs = new Map();
  function addDocument(id, label, raw, icon = '') {
    const url = resolve(raw);
    if (!url || !inProcess(url) || !label || processMismatch) return;
    const action = url.searchParams.get('acao');
    if (!['documento_visualizar', 'documento_download_anexo', 'arvore_visualizar'].includes(action)) return;
    const documentId = String(id || url.searchParams.get('id_documento') || '');
    if (!documentId || !/^\d+$/.test(documentId)) return;
    const isHtml = action === 'documento_visualizar';
    const kind = isHtml ? 'html' : /(?:documento_pdf|\.pdf(?:\?|$))/i.test(icon + ' ' + url.href) ? 'pdf' : action === 'arvore_visualizar' ? 'viewer' : 'file';
    const entry = {id: documentId, label: plain(label), url: url.href, kind};
    const previous = docs.get(documentId);
    if (!previous || previous.kind === 'viewer') docs.set(documentId, entry);
  }
  for (const node of nodes.values()) {
    if (node.args[0] !== 'DOCUMENTO' || !belongs(node) || /documento_cancelado/i.test(String(node.args[7]))) continue;
    // Empty src means SEI did not grant access to content. Do not invent a link.
    if (node.props.src) addDocument(node.args[1], node.args[5], node.props.src, String(node.args[7] || ''));
  }
  const treePage = ['procedimento_visualizar', 'procedimento_trabalhar', 'procedimento_paginar', 'arvore_visualizar'].includes(base.searchParams.get('acao')) || !!doc.querySelector('#divArvore, #ifrArvore, #ifrmArvore');
  if (nodes.size === 0 && treePage) {
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const url = resolve(anchor.getAttribute('href'));
      if (!url || !inProcess(url)) continue;
      const action = url.searchParams.get('acao');
      const isTreeLabel = /infraArvore|noVisitado/.test(anchor.className || '') || !!anchor.closest('#divArvore');
      if (action === 'documento_visualizar' || action === 'documento_download_anexo' || (action === 'arvore_visualizar' && isTreeLabel)) {
        addDocument(url.searchParams.get('id_documento'), anchor.textContent || anchor.title, url.href, anchor.innerHTML || '');
      }
    }
  }
  const treeEl = doc.querySelector('#ifrArvore, #ifrmArvore');
  const treeUrl = resolve(treeEl?.getAttribute('src'))?.href;
  const expandedTreeUrl = signedAction('procedimento_visualizar', url => url.searchParams.get('abrir_pastas') === '1');
  const folders = [...nodes.values()].filter(node => node.args[0] === 'PASTA');
  const incompleteTree = folders.some(node => node.loaded === false) || (!!treeUrl && nodes.size === 0);
  const selectedType = doc.querySelector('#selSerie option:checked');
  const save = [...doc.querySelectorAll('[name="btnSalvar"], #btnSalvar')].find(el => !el.disabled);
  const processText = root ? plain(root.args[5] || root.args[15]) : plain(doc.querySelector('#divArvoreInformacao')?.textContent || '');
  const processNumber = processText.match(/\b\d{4,6}[.\d-]*\/\d{4}[-.]?\d*\b/)?.[0] || (root ? processText : '');
  const result = {
    url: base.href,
    title: doc.title || '',
    processId,
    processNumber,
    unitId,
    processMismatch,
    documents: [...docs.values()],
    treeUrl,
    expandedTreeUrl,
    incompleteTree,
    includeUrl: navigationPage ? signedAction('documento_escolher_tipo', url => navigationUrl(url.href, 'documento_escolher_tipo')) : undefined,
    externalTypeUrl: navigationPage ? signedAction('documento_receber', url => navigationUrl(url.href, 'documento_receber')) : undefined,
    hasVisibleIncludeControl: navigationAnchors.some(anchor => navigationUrl(anchor.getAttribute('href'), 'documento_escolher_tipo')),
    hasVisibleExternalControl: navigationAnchors.some(anchor => navigationUrl(anchor.getAttribute('href'), 'documento_receber') && /^externo$/i.test((anchor.textContent || anchor.title || '').trim())) || !!externalChoice,
    currentDocumentId: base.searchParams.get('id_documento') || doc.querySelector('#hdnIdDocumento')?.value || '',
    isExternalForm: !!formUrl && !/^documento_alterar/.test(base.searchParams.get('acao') || '') && navigationUrl(formUrl.href, 'documento_receber', true),
    isTypeChoice: !!validChoice,
    observedUrls: [...observed],
    controls: form ? {
      formAction: formUrl?.href,
      types: [...doc.querySelectorAll('#selSerie option')].filter(option => option.value && option.value !== 'null').map(option => ({value: option.value, label: option.textContent.trim()})),
      selectedType: selectedType ? {value: selectedType.value, label: selectedType.textContent.trim()} : null,
      documentDate: doc.querySelector('#txtDataElaboracao')?.value || '',
      format: doc.querySelector('input[name="rdoFormato"]:checked')?.value || '',
      access: doc.querySelector('input[name="rdoNivelAcesso"]:checked')?.value || '',
      hasFileInput: !!doc.querySelector('#filArquivo'),
      hasUploadedFile: !!doc.querySelector('#hdnAnexos')?.value,
      saveEnabled: !!save,
    } : undefined,
  };
  if (!detached && base.protocol === 'https:') {
    let host = window;
    try { if (window.top.location.origin === base.origin) host = window.top; } catch { /* keep current frame */ }
    let state = host.__CRC_SEI_OBSERVED_V1__;
    if (!state || state.origin !== base.origin || state.processId !== processId) {
      state = {origin: base.origin, processId, urls: new Set()};
      host.__CRC_SEI_OBSERVED_V1__ = state;
    }
    for (const url of observed) state.urls.add(url);
    state.urls.add(base.href.split('#')[0]);
  }
  return result;
}

export async function fetchSeiResource({url, maxBytes = 20 * 1024 * 1024, processId, expectedProcessId, unitId} = {}) {
  const here = new URL(location.href);
  if (here.protocol !== 'https:') throw new Error('A leitura exige uma página HTTPS do SEI.');
  const allowed = new Set(['procedimento_trabalhar', 'procedimento_visualizar', 'procedimento_paginar', 'arvore_visualizar', 'documento_visualizar', 'documento_download_anexo']);
  const limit = Math.min(20 * 1024 * 1024, Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : 20 * 1024 * 1024);
  let host = window;
  try { if (window.top.location.origin === here.origin) host = window.top; } catch { /* keep current frame */ }
  const liveIds = [(here.searchParams.get('id_procedimento') || (here.searchParams.get('acao') === 'procedimento_trabalhar' ? here.searchParams.get('id_protocolo') : null)), document.querySelector('#hdnIdProcedimento')?.value].filter(Boolean);
  const liveUnits = [here.searchParams.get('infra_unidade_atual')].filter(Boolean);
  try {
    const topUrl = new URL(host.location.href);
    if ((topUrl.searchParams.get('id_procedimento') || (topUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? topUrl.searchParams.get('id_protocolo') : null))) liveIds.push((topUrl.searchParams.get('id_procedimento') || (topUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? topUrl.searchParams.get('id_protocolo') : null)));
    if (host.document.querySelector('#hdnIdProcedimento')?.value) liveIds.push(host.document.querySelector('#hdnIdProcedimento').value);
    if (topUrl.searchParams.get('infra_unidade_atual')) liveUnits.push(topUrl.searchParams.get('infra_unidade_atual'));
  } catch { /* no parent access */ }
  const activeId = liveIds[0] || '';
  const expected = String(expectedProcessId || processId || activeId);
  if (!activeId || new Set(liveIds).size > 1 || activeId !== expected) throw new Error('O processo atual não pôde ser confirmado. Abra novamente o processo selecionado.');
  if (new Set(liveUnits).size > 1 || unitId && liveUnits.some(value => value !== String(unitId))) throw new Error('A unidade do SEI mudou. Abra novamente o processo selecionado.');
  const activeUnit = liveUnits[0] || String(unitId || '');
  let state = host.__CRC_SEI_OBSERVED_V1__;
  if (!state || state.origin !== here.origin || (activeId && state.processId !== activeId)) {
    state = {origin: here.origin, processId: activeId, urls: new Set()};
    host.__CRC_SEI_OBSERVED_V1__ = state;
  }
  function resolve(raw, base = here.href) {
    try {
      const parsed = new URL(String(raw).replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&'), base);
      if (parsed.protocol !== 'https:' || parsed.origin !== here.origin || parsed.username || parsed.password) return null;
      if (!/\/controlador\.php$/.test(parsed.pathname) || !allowed.has(parsed.searchParams.get('acao'))) return null;
      if (parsed.searchParams.has('acao_ajax')) return null;
      const id = (parsed.searchParams.get('id_procedimento') || (parsed.searchParams.get('acao') === 'procedimento_trabalhar' ? parsed.searchParams.get('id_protocolo') : null));
      if (id && state.processId && id !== state.processId) return null;
      const targetUnit = parsed.searchParams.get('infra_unidade_atual');
      if (targetUnit && activeUnit && targetUnit !== activeUnit) return null;
      parsed.hash = '';
      return parsed;
    } catch { return null; }
  }
  function observe(raw, base) {
    const value = resolve(raw, base);
    if (value) { state.urls.add(value.href); return; }
    // PDF.js exposes the document through viewer.html?file=<encoded URL>.
    // The viewer itself is not a permitted fetch endpoint; record only the
    // nested, independently validated SEI read URL from an observed viewer.
    try {
      const viewer = new URL(String(raw).replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&'), base || here.href);
      if (viewer.protocol !== 'https:' || viewer.origin !== here.origin || viewer.username || viewer.password || !/\/viewer\.html$/i.test(viewer.pathname)) return;
      const viewerProcess = (viewer.searchParams.get('id_procedimento') || (viewer.searchParams.get('acao') === 'procedimento_trabalhar' ? viewer.searchParams.get('id_protocolo') : null));
      const viewerUnit = viewer.searchParams.get('infra_unidade_atual');
      if (viewerProcess && viewerProcess !== state.processId || viewerUnit && activeUnit && viewerUnit !== activeUnit) return;
      const nestedFile = viewer.searchParams.get('file');
      if (!nestedFile || nestedFile.length > 16000) return;
      const nested = resolve(nestedFile, base || here.href);
      if (nested) state.urls.add(nested.href);
    } catch { /* Invalid or external viewers confer no read permission. */ }
  }
  function observeText(text, base) {
    for (const match of String(text).matchAll(/(?:https?:\/\/[^\s"'<>\\]+|(?:\.\/)?controlador\.php\?[^\s"'<>\\]+)/g)) observe(match[0], base);
    for (const match of String(text).matchAll(/["']([^"'<>\\\r\n]*\bviewer\.html\?[^"'<>\\\r\n]*)["']/gi)) observe(match[1], base);
  }
  const seenWindows = new Set();
  function collect(win, depth = 0) {
    if (depth > 5 || seenWindows.has(win)) return;
    seenWindows.add(win);
    try {
      if (win.location.origin !== here.origin) return;
      observe(win.location.href, win.location.href);
      for (const element of win.document.querySelectorAll('[href], iframe[src], frame[src], embed[src], object[data]')) observe(element.getAttribute('href') || element.getAttribute('src') || element.getAttribute('data'), win.location.href);
      for (const script of win.document.querySelectorAll('script')) observeText(script.textContent, win.location.href);
      for (let i = 0; i < Math.min(win.frames.length, 20); i++) collect(win.frames[i], depth + 1);
    } catch { /* Do not inspect inaccessible frames. */ }
  }
  collect(host);
  const target = resolve(url);
  if (!target) throw new Error('Recurso recusado: somente ações de leitura HTTPS na mesma origem e no processo atual são permitidas.');
  if (!state.urls.has(target.href)) throw new Error('O link de leitura não foi encontrado na página do processo ou nas páginas já consultadas.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch(target.href, {method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: controller.signal});
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new Error('O SEI redirecionou a leitura. Confira a sessão e abra novamente o processo.');
    if (!response.ok) throw new Error(`O SEI não permitiu ler o documento (HTTP ${response.status}).`);
    const finalUrl = new URL(response.url || target.href);
    if (finalUrl.origin !== here.origin || finalUrl.protocol !== 'https:') throw new Error('A leitura foi interrompida porque saiu da origem do SEI.');
    const announced = Number(response.headers.get('content-length') || 0);
    if (announced > limit) { controller.abort(); throw new Error('Documento maior que o limite de leitura de 20 MB.'); }
    const chunks = [];
    let size = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > limit) { controller.abort(); await reader.cancel().catch(() => {}); throw new Error('Documento maior que o limite permitido para leitura.'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      size = bytes.byteLength;
      if (size > limit) throw new Error('Documento maior que o limite permitido para leitura.');
      chunks.push(bytes);
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    const contentType = response.headers.get('content-type') || '';
    let mime = contentType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const prefix = new TextDecoder('windows-1252').decode(bytes.slice(0, 2048));
    if (prefix.startsWith('%PDF-')) mime = 'application/pdf';
    const textual = mime.startsWith('text/') || /(?:html|xml|json)/.test(mime) || /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(prefix);
    if (textual) {
      let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] || /charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] || 'windows-1252';
      let text;
      try { text = new TextDecoder(charset).decode(bytes); } catch { charset = 'windows-1252'; text = new TextDecoder(charset).decode(bytes); }
      if (/<form\b[^>]*(?:id|name)\s*=\s*["'](?:frmLogin|frmAcesso)["']/i.test(text)) throw new Error('A sessão do SEI expirou. Entre novamente antes de continuar.');
      observeText(text, finalUrl.href);
      for (const match of text.matchAll(/\b(?:href|src|data)\s*=\s*(["'])(.*?)\1/gi)) observe(match[2], finalUrl.href);
      return {url: finalUrl.href, mime: textual && mime === 'application/octet-stream' ? 'text/html' : mime, text, size, charset};
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {url: finalUrl.href, mime, base64: btoa(binary), size};
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('A leitura do documento excedeu o tempo permitido. Tente novamente após verificar a sessão.');
    throw error;
  } finally { clearTimeout(timer); }
}

export function navigateToExternalForm({processId, unitId} = {}) {
  const current = new URL(location.href);
  if (current.protocol !== 'https:' || !['www.sei.mg.gov.br', 'sei.mg.gov.br'].includes(current.hostname)) return {stage: 'manual', reason: 'Abra o processo no SEI de Minas Gerais por HTTPS.'};
  const hiddenId = document.querySelector('#hdnIdProcedimento')?.value || '';
  let topWindow = window;
  try { if (window.top.location.origin === current.origin) topWindow = window.top; } catch { /* keep current frame */ }
  let topId = '';
  let topUnit = '';
  try {
    const topUrl = new URL(topWindow.location.href);
    topId = (topUrl.searchParams.get('id_procedimento') || (topUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? topUrl.searchParams.get('id_protocolo') : null)) || topWindow.document.querySelector('#hdnIdProcedimento')?.value || '';
    topUnit = topUrl.searchParams.get('infra_unidade_atual') || '';
  } catch { /* no parent access */ }
  const actualId = (current.searchParams.get('id_procedimento') || (current.searchParams.get('acao') === 'procedimento_trabalhar' ? current.searchParams.get('id_protocolo') : null)) || hiddenId || topId;
  const expectedId = String(processId || actualId || '');
  if (!actualId || !expectedId || actualId !== expectedId || hiddenId && hiddenId !== expectedId || topId && topId !== expectedId) return {stage: 'manual', reason: 'O processo aberto mudou. Abra novamente o processo selecionado.'};
  const actualUnit = current.searchParams.get('infra_unidade_atual') || topUnit || '';
  if (unitId && actualUnit && String(unitId) !== actualUnit || topUnit && actualUnit && topUnit !== actualUnit) return {stage: 'manual', reason: 'A unidade do SEI mudou. Abra novamente o processo.'};
  const expectedUnit = String(unitId || actualUnit || '');
  function validUrl(raw, action, allowHiddenId = false) {
    try {
      const url = new URL(raw, current.href);
      const id = (url.searchParams.get('id_procedimento') || (url.searchParams.get('acao') === 'procedimento_trabalhar' ? url.searchParams.get('id_protocolo') : null)) || (allowHiddenId ? hiddenId || (current.searchParams.get('id_procedimento') || (current.searchParams.get('acao') === 'procedimento_trabalhar' ? current.searchParams.get('id_protocolo') : null)) : '');
      return url.protocol === 'https:' && url.origin === current.origin && !url.username && !url.password &&
        url.searchParams.get('acao') === action && !!url.searchParams.get('infra_hash') && id === expectedId &&
        (!expectedUnit || !url.searchParams.get('infra_unidade_atual') || url.searchParams.get('infra_unidade_atual') === expectedUnit);
    } catch { return false; }
  }
  const form = document.querySelector('#frmDocumentoCadastro');
  if (form) {
    if (!/^documento_alterar/.test(current.searchParams.get('acao') || '') && validUrl(form.getAttribute('action') || current.href, 'documento_receber', true)) return {stage: 'form', processId: expectedId};
    return {stage: 'manual', reason: 'O formulário aberto não corresponde à inclusão de documento externo neste processo e unidade.'};
  }
  if (!['procedimento_visualizar', 'procedimento_trabalhar', 'procedimento_paginar', 'arvore_visualizar', 'documento_escolher_tipo'].includes(current.searchParams.get('acao'))) return {stage: 'manual', reason: 'Abra Incluir Documento pela barra do processo no SEI.'};
  const visible = element => {
    if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) return false;
    let node = element;
    while (node && node.nodeType === 1) {
      if (node.style?.display === 'none' || ['hidden', 'collapse'].includes(node.style?.visibility)) return false;
      const style = document.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility)) return false;
      node = node.parentElement;
    }
    return true;
  };
  function validLink(anchor, action) {
    return validUrl(anchor.getAttribute('href'), action);
  }
  const anchors = [...document.querySelectorAll('a[href]')].filter(anchor =>
    validLink(anchor, 'documento_escolher_tipo') || validLink(anchor, 'documento_receber') ||
    validLink(anchor, 'arvore_visualizar') && !new URL(anchor.getAttribute('href'), current.href).searchParams.get('id_documento')).filter(visible);
  const external = anchors.find(anchor => validLink(anchor, 'documento_receber') && /^externo$/i.test((anchor.textContent || anchor.title || '').trim()));
  if (external) {
    setTimeout(() => { if (external.isConnected) external.click(); }, 0);
    return {stage: 'navigated', destination: 'external-form', processId: expectedId};
  }
  const choice = document.querySelector('#frmDocumentoEscolherTipo');
  if (choice) {
    if (!validUrl(choice.getAttribute('action') || current.href, 'documento_escolher_tipo')) return {stage: 'manual', reason: 'Não foi possível verificar o formulário de escolha de documento.'};
    const newExternal = [...choice.querySelectorAll('#tblSeries a, #tblSeries input, #tblSeries button')].find(element => visible(element) &&
      /\bescolher\s*\(\s*-1\s*\)/.test(element.getAttribute('onclick') || ''));
    if (newExternal) {
      setTimeout(() => { if (newExternal.isConnected) newExternal.click(); }, 0);
      return {stage: 'navigated', destination: 'external-form', processId: expectedId};
    }
    return {stage: 'manual', reason: 'A opção Externo não está disponível para este processo e usuário.'};
  }
  const include = anchors.find(anchor => validLink(anchor, 'documento_escolher_tipo'));
  if (include) {
    setTimeout(() => { if (include.isConnected) include.click(); }, 0);
    return {stage: 'navigated', destination: 'choose-type', processId: expectedId};
  }
  // inspectSeiFrame records signed links from Nos.acoes without running page
  // JS. Prefer that exact action to reselecting the process root: the tree can
  // remain the first inspected frame even after its toolbar has fully loaded.
  const cache = topWindow.__CRC_SEI_OBSERVED_V1__;
  if (cache?.origin === current.origin && cache.processId === expectedId && cache.urls?.values) {
    let observedInclude = null;
    for (const raw of cache.urls.values()) {
      try {
        const url = new URL(raw);
        if (validUrl(url.href, 'documento_escolher_tipo')) {
          observedInclude = url.href; break;
        }
      } catch { /* Ignore invalid cached values. */ }
    }
    let destination = null;
    const outer = topWindow.document.querySelector('#ifrConteudoVisualizacao');
    if (outer?.tagName === 'IFRAME') {
      try {
        const shellUrl = new URL(outer.contentWindow.location.href);
        const shellId = (shellUrl.searchParams.get('id_procedimento') || (shellUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? shellUrl.searchParams.get('id_protocolo') : null));
        const shellUnit = shellUrl.searchParams.get('infra_unidade_atual');
        const isShell = shellUrl.origin === current.origin && /\/controlador\.php$/.test(shellUrl.pathname) &&
          ['arvore_visualizar', 'procedimento_visualizar', 'procedimento_trabalhar'].includes(shellUrl.searchParams.get('acao')) &&
          (!shellId || shellId === expectedId) && (!expectedUnit || !shellUnit || shellUnit === expectedUnit);
        if (isShell) {
          const inner = outer.contentDocument?.querySelector('#ifrVisualizacao');
          if (inner?.tagName === 'IFRAME') destination = inner;
          else destination = outer;
        } else if (shellUrl.href === 'about:blank' && (!outer.getAttribute('src') || outer.getAttribute('src') === 'about:blank')) destination = outer;
      } catch { /* A foreign or stale frame is not a navigation destination. */ }
    }
    // Older SEI layouts place the visualization iframe directly in the top.
    if (!destination) {
      const direct = topWindow.document.querySelector('#ifrVisualizacao');
      if (direct?.tagName === 'IFRAME') destination = direct;
    }
    if (observedInclude && destination?.tagName === 'IFRAME') {
      setTimeout(() => {
        const liveTop = new URL(topWindow.location.href);
        const liveId = (liveTop.searchParams.get('id_procedimento') || (liveTop.searchParams.get('acao') === 'procedimento_trabalhar' ? liveTop.searchParams.get('id_protocolo') : null)) || topWindow.document.querySelector('#hdnIdProcedimento')?.value;
        const liveUnit = liveTop.searchParams.get('infra_unidade_atual') || '';
        if (destination.isConnected && liveId === expectedId && (!expectedUnit || !liveUnit || liveUnit === expectedUnit)) destination.setAttribute('src', observedInclude);
      }, 0);
      return {stage: 'navigated', destination: 'choose-type', processId: expectedId};
    }
  }
  // If neither a native control nor an observed inclusion action is usable,
  // selecting the root may expose its native toolbar for the next inspection.
  const processRoot = anchors.find(anchor => validLink(anchor, 'arvore_visualizar') && !new URL(anchor.getAttribute('href'), current.href).searchParams.get('id_documento'));
  if (processRoot) {
    setTimeout(() => { if (processRoot.isConnected) processRoot.click(); }, 0);
    return {stage: 'navigated', destination: 'process-toolbar', processId: expectedId};
  }
  return {stage: 'manual', reason: 'Selecione o processo na árvore e abra Incluir Documento → Externo.'};
}

export async function prepareExternalDocument(payload = {}) {
  const expectedId = String(payload.processId || '');
  const current = new URL(location.href);
  const form = document.querySelector('#frmDocumentoCadastro');
  if (!expectedId || !/^\d+$/.test(expectedId) || current.protocol !== 'https:' || !form) throw new Error('Abra o formulário Externo do processo selecionado.');
  const action = new URL(form.getAttribute('action') || current.href, current.href);
  const hiddenId = document.querySelector('#hdnIdProcedimento')?.value || '';
  const ids = [(current.searchParams.get('id_procedimento') || (current.searchParams.get('acao') === 'procedimento_trabalhar' ? current.searchParams.get('id_protocolo') : null)), (action.searchParams.get('id_procedimento') || (action.searchParams.get('acao') === 'procedimento_trabalhar' ? action.searchParams.get('id_protocolo') : null)), hiddenId].filter(Boolean);
  if (!ids.length || ids.some(id => id !== expectedId) || action.origin !== current.origin || action.searchParams.get('acao') !== 'documento_receber' || !action.searchParams.get('infra_hash')) throw new Error('O formulário não corresponde à inclusão de documento no processo selecionado.');
  if (/^[1-9]\d*$/.test(document.querySelector('#hdnIdDocumento')?.value || '')) throw new Error('O formulário aberto altera um documento existente. Abra um novo documento Externo.');
  const actualUnit = current.searchParams.get('infra_unidade_atual') || action.searchParams.get('infra_unidade_atual') || '';
  if (payload.unitId && actualUnit !== String(payload.unitId)) throw new Error('A unidade do SEI mudou durante a preparação.');
  const cnpj = String(payload.cnpj || '').toUpperCase().replace(/[.\s/-]/g, '');
  const cpfValid = /^\d{11}$/.test(cnpj) && !/^(\d)\1{10}$/.test(cnpj) && [9,10].every(n => { let sum = 0; for (let i=0;i<n;i++) sum += Number(cnpj[i])*(n+1-i); return (sum*10%11)%10 === Number(cnpj[n]); });
  if ((!/^[A-Z0-9]{12}\d{2}$/.test(cnpj) && !cpfValid) || /^0+$/.test(cnpj)) throw new Error('O CPF/CNPJ do CRC não foi informado corretamente.');
  const date = String(payload.documentDate || '');
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!parts) throw new Error('A data do documento deve estar em DD/MM/AAAA.');
  const checkDate = new Date(Date.UTC(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1])));
  if (checkDate.getUTCFullYear() !== Number(parts[3]) || checkDate.getUTCMonth() !== Number(parts[2]) - 1 || checkDate.getUTCDate() !== Number(parts[1])) throw new Error('A data de emissão do CRC é inválida.');
  const fileName = String(payload.fileName || '').normalize('NFC');
  if (!fileName || fileName.length > 180 || !/\.pdf$/i.test(fileName) || /[\\/:*?"<>|\x00-\x1f]/.test(fileName)) throw new Error('O CRC precisa ter um nome de arquivo PDF válido.');
  const base64 = String(payload.fileBase64 || '').replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '');
  if (!base64 || base64.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('O arquivo do CRC está ausente, inválido ou excede 20 MB.');
  let binary;
  try { binary = atob(base64); } catch { throw new Error('O arquivo do CRC não pôde ser decodificado.'); }
  if (!binary.startsWith('%PDF-') || binary.length > 20 * 1024 * 1024) throw new Error('O arquivo recebido não é um PDF válido do CRC.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (payload.sha256 && String(payload.sha256) !== sha256) throw new Error('O conteúdo do CRC não corresponde ao arquivo selecionado na extensão.');
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const type = document.querySelector('#selSerie');
  if (!type || type.disabled) throw new Error('O SEI não disponibilizou a seleção do tipo de documento.');
  const accepted = new Set(['crc', 'certificado de registro cadastral', 'certificado de registro cadastral crc', 'crc certificado de registro cadastral']);
  const candidates = [...type.options].filter(option => !option.disabled && option.value && option.value !== 'null' && accepted.has(normalize(option.textContent)));
  const exact = candidates.filter(option => normalize(option.textContent) === 'crc');
  const selectedCandidate = candidates.find(option => option.value === type.value);
  const chosen = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : selectedCandidate || null;
  if (!chosen) throw new Error(candidates.length ? 'Existe mais de um tipo CRC. Selecione o tipo correto no SEI antes de continuar.' : 'O tipo CRC / Certificado de Registro Cadastral não está disponível no SEI. Nenhum tipo alternativo foi escolhido.');
  const pendingType = globalThis.__CRC_SEI_TYPE_CHANGE_V1__;
  if (pendingType?.document === document) {
    // trocarSerie() submits the current form. Its selected value changes
    // before the replacement document arrives, so that value is not proof
    // that the new form is ready for metadata or upload.
    return {stage: 'type-changing', processId: expectedId, typeId: pendingType.typeId, typeLabel: pendingType.typeLabel};
  }
  if (type.value !== chosen.value) {
    if (document.querySelector('#hdnAnexos')?.value) throw new Error('Já há um anexo neste formulário. Abra um novo Externo para o CRC.');
    type.value = chosen.value;
    const hiddenType = document.querySelector('#hdnIdSerie');
    if (hiddenType) hiddenType.value = chosen.value;
    globalThis.__CRC_SEI_TYPE_CHANGE_V1__ = {document, typeId: chosen.value, typeLabel: chosen.textContent.trim()};
    setTimeout(() => { if (type.isConnected) type.dispatchEvent(new Event('change', {bubbles: true})); }, 0);
    return {stage: 'type-changing', processId: expectedId, typeId: chosen.value, typeLabel: chosen.textContent.trim()};
  }
  const dateInput = document.querySelector('#txtDataElaboracao');
  const nato = document.querySelector('#optNato[name="rdoFormato"][value="N"], input[name="rdoFormato"][value="N"]');
  const publicAccess = document.querySelector('#optPublico[name="rdoNivelAcesso"][value="0"], input[name="rdoNivelAcesso"][value="0"]');
  const fileInput = document.querySelector('#filArquivo[type="file"]');
  const annex = document.querySelector('#hdnAnexos');
  const treeName = document.querySelector('#txtNomeArvore') || document.querySelector('#txtNumero');
  const observationsInput = document.querySelector('#txaObservacoes');
  if (!dateInput || !nato || !publicAccess || !fileInput || !annex || !treeName) throw new Error('O formulário de documento externo não contém os campos esperados. Preencha-o manualmente.');
  if ([dateInput, nato, publicAccess, fileInput, treeName].some(element => element.disabled)) throw new Error('Um dos campos obrigatórios está bloqueado pelo SEI.');
  const desiredName = String(payload.specification || `${cnpj.length === 11 ? 'CPF' : 'CNPJ'} ${cnpj}`);
  const specification = desiredName.slice(0, treeName.maxLength > 0 ? treeName.maxLength : 250);
  let observations = String(payload.observations || '').trim();
  const generatedAt = String(payload.generatedAtText || '').trim();
  if (generatedAt && !observations.includes(generatedAt)) observations += `${observations ? '\n' : ''}CRC gerado em ${generatedAt}.`;
  if (observations.length > 1000) throw new Error('As observações ultrapassam o limite de 1.000 caracteres do SEI.');
  if (observations && !observationsInput) throw new Error('Não foi encontrado o campo de observações para registrar a geração do CRC.');
  let state = globalThis.__CRC_SEI_PREPARED_V1__;
  if (state && state.document !== document) state = null;
  if (state && state.stage === 'saving') throw new Error('Um salvamento já foi iniciado. Confira a árvore antes de tentar novamente.');
  if (state && (state.processId !== expectedId || state.cnpj !== cnpj || state.sha256 !== sha256 || state.fileName !== fileName || state.date !== date || state.specification !== specification || state.observations !== observations)) throw new Error('Outro CRC já está sendo preparado neste formulário. Abra um novo documento Externo.');
  function setValue(element, value) {
    if (!element) return;
    element.value = value;
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function blankSelect(selector) {
    const select = document.querySelector(selector);
    if (!select) return;
    const blank = [...select.options].find(option => !option.value || option.value === 'null');
    if (blank) select.value = blank.value;
  }
  function verifyFields() {
    const liveUrl = new URL(location.href);
    if (!form.isConnected || liveUrl.origin !== current.origin || (liveUrl.searchParams.get('id_procedimento') || (liveUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? liveUrl.searchParams.get('id_protocolo') : null)) && (liveUrl.searchParams.get('id_procedimento') || (liveUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? liveUrl.searchParams.get('id_protocolo') : null)) !== expectedId || document.querySelector('#hdnIdProcedimento')?.value && document.querySelector('#hdnIdProcedimento').value !== expectedId) throw new Error('O processo mudou durante a preparação do CRC.');
    if (liveUrl.searchParams.get('infra_unidade_atual') && liveUrl.searchParams.get('infra_unidade_atual') !== actualUnit) throw new Error('A unidade mudou durante a preparação do CRC.');
    if (type.value !== chosen.value || document.querySelector('#hdnIdSerie') && document.querySelector('#hdnIdSerie').value !== chosen.value) throw new Error('O tipo CRC não foi confirmado pelo formulário.');
    if (dateInput.value !== date || !nato.checked || !publicAccess.checked || treeName.value !== specification) throw new Error('Os campos do documento mudaram durante a preparação. Revise o formulário.');
    if (document.querySelector('#hdnStaNivelAcessoLocal') && document.querySelector('#hdnStaNivelAcessoLocal').value !== '0') throw new Error('O SEI não confirmou o nível Público.');
    if (observationsInput && observationsInput.value !== observations) throw new Error('As observações do CRC mudaram durante a preparação.');
  }
  if (!state) {
    if (annex.value.trim()) throw new Error('Já existe um arquivo anexado neste formulário. Abra um novo Externo para o CRC.');
    if (!nato.checked) nato.click();
    if (!publicAccess.checked) publicAccess.click();
    setValue(dateInput, date);
    setValue(treeName, specification);
    if (observationsInput) setValue(observationsInput, observations);
    const hiddenType = document.querySelector('#hdnIdSerie');
    if (hiddenType) hiddenType.value = chosen.value;
    const accessHidden = document.querySelector('#hdnStaNivelAcessoLocal');
    if (accessHidden) accessHidden.value = '0';
    for (const selector of ['#hdnIdHipoteseLegal', '#hdnIdTipoConferencia', '#hdnStaGrauSigilo']) {
      const element = document.querySelector(selector);
      if (element) element.value = '';
    }
    blankSelect('#selHipoteseLegal');
    blankSelect('#selTipoConferencia');
    blankSelect('#selGrauSigilo');
    const archive = document.querySelector('#chkSinArquivamento');
    if (archive?.checked) archive.click();
    const hiddenArchive = document.querySelector('#hdnSinArquivamento');
    if (hiddenArchive) hiddenArchive.value = 'N';
    verifyFields();
    const file = new File([bytes], fileName, {type: 'application/pdf', lastModified: Date.now()});
    let transfer;
    try { transfer = new DataTransfer(); transfer.items.add(file); fileInput.files = transfer.files; } catch { throw new Error('Este navegador não permitiu anexar o arquivo automaticamente. Use Anexar Arquivo no SEI.'); }
    if (fileInput.files.length !== 1 || fileInput.files[0].name !== fileName || fileInput.files[0].size !== bytes.length) throw new Error('O navegador não confirmou o arquivo selecionado para upload.');
    state = {
      document, processId: expectedId, unitId: actualUnit, cnpj, fileName, size: bytes.length, sha256,
      date, specification, observations, labelFieldId: treeName.id, typeId: chosen.value,
      typeLabel: chosen.textContent.trim(), action: action.href, stage: 'uploading', startedAt: Date.now(),
    };
    globalThis.__CRC_SEI_PREPARED_V1__ = state;
    fileInput.dispatchEvent(new Event('change', {bubbles: true}));
  }
  verifyFields();
  function completedUpload() {
    const value = annex.value;
    const records = value.split('¥').filter(Boolean);
    if (records.length !== 1) return null;
    const columns = records[0].split('±');
    if (columns.length < 4 || columns[1].normalize('NFC') !== fileName || Number(columns[3]) !== bytes.length) return null;
    const save = [...document.querySelectorAll('[name="btnSalvar"], #btnSalvar')].find(button => !button.disabled && form.contains(button));
    return save ? value : null;
  }
  const until = Date.now() + 6000;
  let completed = completedUpload();
  while (!completed && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 150));
    verifyFields();
    completed = completedUpload();
  }
  if (!completed) {
    if (Date.now() - state.startedAt > 90000) throw new Error('O SEI não confirmou o upload. Confira o formulário antes de tentar anexar novamente.');
    return {stage: 'uploading', processId: expectedId, fileName, size: bytes.length, sha256};
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  verifyFields();
  if (completedUpload() !== completed) return {stage: 'uploading', processId: expectedId, fileName, size: bytes.length, sha256};
  state.stage = 'prepared';
  state.annexValue = completed;
  state.preparedAt = Date.now();
  return {stage: 'prepared', processId: expectedId, unitId: actualUnit, cnpj, fileName, size: bytes.length, sha256, documentDate: date, typeId: state.typeId, typeLabel: state.typeLabel, specification, observations, format: 'N', access: '0', canSubmit: true};
}

export async function submitPreparedExternalDocument(payload = {}) {
  const state = globalThis.__CRC_SEI_PREPARED_V1__;
  if (!state || state.document !== document || state.stage !== 'prepared') throw new Error('O CRC ainda não está preparado ou um salvamento já foi iniciado. Confira a árvore antes de tentar novamente.');
  const expectedId = String(payload.processId || '');
  const cnpj = String(payload.cnpj || '').toUpperCase().replace(/[.\s/-]/g, '');
  const fileName = String(payload.fileName || '').normalize('NFC');
  if (expectedId !== state.processId || cnpj !== state.cnpj || fileName !== state.fileName) throw new Error('O CRC selecionado não corresponde ao arquivo preparado no SEI.');
  if (payload.documentDate && payload.documentDate !== state.date || payload.sha256 && payload.sha256 !== state.sha256) throw new Error('Os dados de geração do CRC não correspondem ao arquivo preparado.');
  if (Date.now() - state.preparedAt > 10 * 60 * 1000) throw new Error('A preparação do CRC expirou. Revise o formulário antes de continuar.');
  const current = new URL(location.href);
  const form = document.querySelector('#frmDocumentoCadastro');
  if (!form || current.protocol !== 'https:') throw new Error('O formulário de inclusão do CRC não está mais aberto.');
  const action = new URL(form.getAttribute('action') || current.href, current.href);
  const hiddenId = document.querySelector('#hdnIdProcedimento')?.value || '';
  const ids = [(current.searchParams.get('id_procedimento') || (current.searchParams.get('acao') === 'procedimento_trabalhar' ? current.searchParams.get('id_protocolo') : null)), (action.searchParams.get('id_procedimento') || (action.searchParams.get('acao') === 'procedimento_trabalhar' ? action.searchParams.get('id_protocolo') : null)), hiddenId].filter(Boolean);
  const unitId = current.searchParams.get('infra_unidade_atual') || action.searchParams.get('infra_unidade_atual') || '';
  if (!ids.length || ids.some(id => id !== expectedId) || action.origin !== current.origin || action.href !== state.action || action.searchParams.get('acao') !== 'documento_receber' || !action.searchParams.get('infra_hash')) throw new Error('O destino do documento mudou. Nenhum salvamento foi realizado.');
  if (unitId !== state.unitId || payload.unitId && String(payload.unitId) !== unitId) throw new Error('A unidade do SEI mudou. Nenhum salvamento foi realizado.');
  if (/^[1-9]\d*$/.test(document.querySelector('#hdnIdDocumento')?.value || '')) throw new Error('O formulário deixou de ser uma inclusão de documento.');
  const type = document.querySelector('#selSerie');
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const accepted = ['crc', 'certificado de registro cadastral', 'certificado de registro cadastral crc', 'crc certificado de registro cadastral'];
  if (!type || type.value !== state.typeId || !accepted.includes(normalize(type.selectedOptions[0]?.textContent))) throw new Error('O tipo do documento deixou de ser CRC.');
  if (document.querySelector('#hdnIdSerie') && document.querySelector('#hdnIdSerie').value !== state.typeId) throw new Error('O identificador do tipo CRC não está confirmado.');
  if (document.querySelector('#txtDataElaboracao')?.value !== state.date || !document.querySelector('input[name="rdoFormato"][value="N"]')?.checked || !document.querySelector('input[name="rdoNivelAcesso"][value="0"]')?.checked) throw new Error('A data, o formato Nato-digital ou o acesso Público mudou. Revise o formulário.');
  if (document.querySelector('#hdnStaNivelAcessoLocal') && document.querySelector('#hdnStaNivelAcessoLocal').value !== '0') throw new Error('O acesso Público não está confirmado.');
  if (document.getElementById(state.labelFieldId)?.value !== state.specification || document.querySelector('#txaObservacoes') && document.querySelector('#txaObservacoes').value !== state.observations) throw new Error('O nome ou as observações do documento mudaram após a preparação.');
  if (document.querySelector('#hdnAnexos')?.value !== state.annexValue) throw new Error('O anexo mudou após a preparação. Nenhum salvamento foi realizado.');
  const attached = document.querySelector('#filArquivo')?.files?.[0];
  if (attached && (attached.name.normalize('NFC') !== state.fileName || attached.size !== state.size)) throw new Error('O arquivo selecionado mudou após a preparação.');
  if (attached?.arrayBuffer) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await attached.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== state.sha256) throw new Error('O conteúdo do arquivo selecionado mudou após a preparação.');
  }
  const button = [...document.querySelectorAll('[name="btnSalvar"], #btnSalvar')].find(element => !element.disabled && form.contains(element));
  if (!button) throw new Error('O botão Salvar ainda não está disponível. Aguarde o término do upload.');
  if (typeof form.checkValidity === 'function' && !form.checkValidity()) throw new Error('O SEI indica campos obrigatórios pendentes. Revise o formulário.');
  state.stage = 'saving';
  state.savingAt = Date.now();
  // Let executeScript return its acknowledgement before SEI navigates away.
  setTimeout(() => {
    const liveUrl = new URL(location.href);
    const liveId = (liveUrl.searchParams.get('id_procedimento') || (liveUrl.searchParams.get('acao') === 'procedimento_trabalhar' ? liveUrl.searchParams.get('id_protocolo') : null)) || document.querySelector('#hdnIdProcedimento')?.value;
    const liveUnit = liveUrl.searchParams.get('infra_unidade_atual') || action.searchParams.get('infra_unidade_atual') || '';
    if (form.isConnected && button.isConnected && !button.disabled && liveId === expectedId && liveUnit === state.unitId && type.value === state.typeId && document.querySelector('#txtDataElaboracao')?.value === state.date && document.querySelector('input[name="rdoFormato"][value="N"]')?.checked && document.querySelector('input[name="rdoNivelAcesso"][value="0"]')?.checked && document.querySelector('#hdnAnexos')?.value === state.annexValue) button.click();
    else state.stage = 'blocked';
  }, 0);
  return {stage: 'saving', processId: expectedId, cnpj, fileName, sha256: state.sha256};
}
