import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  inspectSeiFrame,
  fetchSeiResource,
  navigateToExternalForm,
  prepareExternalDocument,
  submitPreparedExternalDocument,
} from '../lib/sei.js';

// jsdom is a test-only dependency; no DOM emulator is shipped in the extension.
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { ({ JSDOM } = await import(new URL('../../crc-test-tools/node_modules/jsdom/lib/api.js', import.meta.url))); }

const ORIGIN = 'https://www.sei.mg.gov.br';
const pageUrl = (action, extra = '') => `${ORIGIN}/sei/controlador.php?acao=${action}&id_procedimento=42&infra_unidade_atual=1100&infra_hash=fixture${extra}`;
const PDF = '%PDF-1.7\nSynthetic CRC for adapter tests.\n%%EOF';
const PAYLOAD = {
  processId: '42', unitId: '1100', cnpj: '12.345.678/0001-95',
  fileName: 'CRC_12345678000195.pdf', fileBase64: Buffer.from(PDF).toString('base64'),
  documentDate: '08/10/2026', generatedAtText: '08/10/2026 14:30:00 (Brasília)',
  specification: 'CNPJ 12.345.678/0001-95', observations: 'Emitido no CAGEF.',
};

const json = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

function dom(html = '', url = pageUrl('procedimento_trabalhar')) {
  const result = new JSDOM(html, { url, runScripts: 'outside-only' });
  Object.defineProperty(result.window, 'crypto', { value: webcrypto });
  result.window.TextDecoder = TextDecoder;
  result.window.TextEncoder = TextEncoder;
  result.window.AbortController = AbortController;
  return result;
}

// Execute the serialized function in a fresh page realm, just as executeScript
// does. A reference to any module helper would fail in these tests.
function execute(surface, fn, ...args) {
  surface.window.__fixtureArgs = args;
  return vm.runInContext(`(${fn.toString()})(...__fixtureArgs)`, surface.getInternalVMContext());
}

function treeHtml() {
  return `<title>Árvore</title><script>
  globalThis.thisScriptMustNeverRun = true;
  Nos[0] = new infraArvoreNo("PROCESSO","42",null,"${pageUrl('arvore_visualizar')}","ifrVisualizacao","1500.01.1234567/2026-01","Compras",null,null,null,true,true,null,null,null,"1500.01.1234567/2026-01");
  Nos[0].acoes = '<a href="${pageUrl('documento_escolher_tipo')}">Incluir Documento</a>';
  Nos[1] = new infraArvoreNo("PASTA","PASTA1","42","javascript:abrirFecharPasta(\\'PASTA1\\')",null,"I","Pasta I",null,null,null,false,true,null,null,null);
  Nos[1].carregado = false;
  Nos[2] = new infraArvoreNo("DOCUMENTO","100","PASTA1","${pageUrl('arvore_visualizar', '&id_documento=100')}","ifrConteudoVisualizacao","Cotação \\\"A, B\\\" (100)","Cotação", "svg/documento_interno.svg",null,null,true,true,null,null,null,"100");
  Nos[2].src = '${pageUrl('documento_visualizar', '&id_documento=100')}';
  Nos[3] = new infraArvoreNo("DOCUMENTO","101","42","${pageUrl('arvore_visualizar', '&id_documento=101')}","ifrConteudoVisualizacao","CRC (101)","CRC","svg/documento_pdf.svg",null,null,true,true,null,null,null,"101");
  Nos[3].src = '${pageUrl('documento_download_anexo', '&id_documento=101')}';
  Nos[4] = new infraArvoreNo("DOCUMENTO","102","42","${pageUrl('arvore_visualizar', '&id_documento=102')}",null,"Cancelado (102)","Cancelado","svg/documento_cancelado.svg",null,null,true,true,null,null,null,"102");
  Nos[4].src = '${pageUrl('documento_visualizar', '&id_documento=102')}';
  Nos[5] = new infraArvoreNo("DOCUMENTO","103","42","${pageUrl('arvore_visualizar', '&id_documento=103')}",null,"Sem acesso (103)","Sem acesso","svg/documento_pdf.svg",null,null,true,true,null,null,null,"103");
  Nos[5].src = '';
  Nos[6] = new infraArvoreNo("DOCUMENTO","104","77","${pageUrl('arvore_visualizar', '&id_documento=104').replace('id_procedimento=42', 'id_procedimento=77')}",null,"Outro processo (104)","Outro processo","svg/documento_pdf.svg",null,null,true,true,null,null,null,"104");
  Nos[6].src = '${pageUrl('documento_download_anexo', '&id_documento=104').replace('id_procedimento=42', 'id_procedimento=77')}';
  </script>
  <a href="${pageUrl('procedimento_visualizar', '&abrir_pastas=1').replaceAll('&', '&amp;')}">Abrir todas as pastas</a>`;
}

function externalForm({ selected = '55', existing = '', crcLabel = 'CRC' } = {}) {
  const html = `<form id="frmDocumentoCadastro" action="${pageUrl('documento_receber')}">
    <input id="hdnIdProcedimento" value="42" type="hidden">
    <input id="hdnIdDocumento" value="" type="hidden">
    <input id="hdnIdSerie" value="${selected}" type="hidden">
    <input id="hdnStaNivelAcessoLocal" value="1" type="hidden">
    <input id="hdnFlagDocumentoCadastro" value="1" type="hidden">
    <input id="hdnIdHipoteseLegal" value="4" type="hidden">
    <input id="hdnIdTipoConferencia" value="2" type="hidden">
    <input id="hdnSinArquivamento" value="N" type="hidden">
    <select id="selSerie"><option value="1" ${selected === '1' ? 'selected' : ''}>Anexo</option><option value="55" ${selected === '55' ? 'selected' : ''}>${crcLabel}</option></select>
    <input id="txtDataElaboracao" value="01/01/2020">
    <input id="txtNomeArvore" maxlength="50">
    <input id="optNato" name="rdoFormato" type="radio" value="N">
    <input id="optDigitalizado" name="rdoFormato" type="radio" value="D" checked>
    <input id="optPublico" name="rdoNivelAcesso" type="radio" value="0">
    <input id="optRestrito" name="rdoNivelAcesso" type="radio" value="1" checked>
    <select id="selHipoteseLegal"><option value="null"></option><option value="4" selected>Dados pessoais</option></select>
    <select id="selTipoConferencia"><option value="null"></option><option value="2" selected>Cópia simples</option></select>
    <textarea id="txaObservacoes"></textarea>
    <input id="hdnAnexos" type="hidden" value="${existing}">
    <input id="filArquivo" type="file">
    <button type="button" name="btnSalvar" id="btnSalvar">Salvar</button>
  </form>`;
  const surface = dom(html, pageUrl('documento_receber'));
  const { window } = surface;
  const file = window.document.querySelector('#filArquivo');
  Object.defineProperty(file, 'files', { configurable: true, writable: true, value: [] });
  window.DataTransfer = class {
    constructor() {
      this.files = [];
      this.items = { add: item => { this.files.push(item); } };
    }
  };
  const counts = { uploads: 0, saves: 0, typeChanges: 0 };
  window.document.querySelector('#selSerie').addEventListener('change', () => counts.typeChanges++);
  file.addEventListener('change', () => {
    counts.uploads++;
    const selectedFile = file.files[0];
    const save = window.document.querySelector('#btnSalvar');
    save.disabled = true;
    window.setTimeout(() => {
      window.document.querySelector('#hdnAnexos').value = `tmp-1±${selectedFile.name}±08/10/2026 14:30:01±${selectedFile.size}±1 KB±servidor±UNIDADE`;
      save.disabled = false;
    }, 3);
  });
  window.document.querySelector('#btnSalvar').addEventListener('click', () => {
    counts.saves++;
    window.document.querySelector('#hdnFlagDocumentoCadastro').value = '2';
  });
  return { surface, counts };
}

test('parses complete safe JS literals without executing page scripts or unrelated nodes', () => {
  const surface = dom(treeHtml(), pageUrl('procedimento_visualizar'));
  try {
    const result = execute(surface, inspectSeiFrame);
    assert.equal(result.processId, '42');
    assert.equal(result.processNumber, '1500.01.1234567/2026-01');
    assert.equal(result.unitId, '1100');
    assert.equal(result.incompleteTree, true);
    assert.match(result.expandedTreeUrl, /abrir_pastas=1/);
    assert.equal(result.includeUrl, pageUrl('documento_escolher_tipo'));
    assert.deepEqual(json(result.documents).map(item => [item.id, item.kind]), [['100', 'html'], ['101', 'pdf']]);
    assert.equal(result.documents[0].label, 'Cotação "A, B" (100)');
    assert.equal(surface.window.thisScriptMustNeverRun, undefined);
  } finally { surface.window.close(); }
});

test('HTML inspection is independent of document, window, and location', () => {
  const helper = dom();
  try {
    const result = vm.runInNewContext(`(${inspectSeiFrame.toString()})(input)`, {
      DOMParser: helper.window.DOMParser, URL,
      input: { html: treeHtml(), url: pageUrl('procedimento_visualizar') },
    });
    assert.equal(result.documents.length, 2);
    assert.equal(result.processId, '42');
  } finally { helper.window.close(); }
});

test('does not execute expressions supplied as tree constructor arguments', () => {
  const surface = dom(`<script>Nos[0] = new infraArvoreNo("PROCESSO", (globalThis.compromised = true), null);</script>`, pageUrl('procedimento_visualizar'));
  try {
    assert.equal(execute(surface, inspectSeiFrame).documents.length, 0);
    assert.equal(surface.window.compromised, undefined);
  } finally { surface.window.close(); }
});

test('identifies the iframe URL and does not treat links in a document body as process membership', () => {
  const surface = dom(`<iframe id="ifrArvore" src="${pageUrl('procedimento_visualizar')}"></iframe>`);
  try {
    const result = execute(surface, inspectSeiFrame);
    assert.equal(result.treeUrl, pageUrl('procedimento_visualizar'));
    assert.equal(result.incompleteTree, true);
    const body = execute(surface, inspectSeiFrame, { html: `<a href="${pageUrl('documento_visualizar', '&id_documento=999')}">Referenced document</a>`, url: pageUrl('documento_visualizar', '&id_documento=100') });
    assert.equal(body.documents.length, 0);
  } finally { surface.window.close(); }
});

test('rejects a tree whose process ID disagrees with the supplied page URL', () => {
  const surface = dom();
  try {
    const result = execute(surface, inspectSeiFrame, { html: treeHtml(), url: pageUrl('procedimento_visualizar').replace('id_procedimento=42', 'id_procedimento=99') });
    assert.equal(result.processMismatch, true);
    assert.equal(result.documents.length, 0);
  } finally { surface.window.close(); }
});

test('reads an observed same-origin PDF and uses manual redirects and session credentials', async () => {
  const target = pageUrl('documento_download_anexo', '&id_documento=101');
  const surface = dom(`<a href="${target}">CRC</a>`);
  try {
    let calls = 0;
    surface.window.fetch = async (url, init) => {
      calls++;
      assert.equal(url, target);
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.method, 'GET');
      return new Response(PDF, {headers: {'Content-Type': 'application/octet-stream'}});
    };
    const result = await execute(surface, fetchSeiResource, {url: target});
    assert.equal(result.mime, 'application/pdf');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), PDF);
    assert.equal(result.size, PDF.length);
    assert.equal(calls, 1);
  } finally { surface.window.close(); }
});

test('rejects unknown, write, cross-origin, and other-process resources without making a request', async () => {
  const targets = [
    pageUrl('documento_visualizar', '&id_documento=999'),
    pageUrl('documento_receber'),
    pageUrl('documento_visualizar', '&id_documento=101').replace(ORIGIN, 'https://example.org'),
    pageUrl('documento_visualizar', '&id_documento=101').replace('id_procedimento=42', 'id_procedimento=77'),
  ];
  const surface = dom(`<a href="${targets[1]}">Externo</a><a href="${targets[3]}">Other process</a>`);
  try {
    let calls = 0;
    surface.window.fetch = async () => { calls++; throw new Error('Must not fetch'); };
    for (const url of targets) await assert.rejects(execute(surface, fetchSeiResource, {url}));
    assert.equal(calls, 0);
  } finally { surface.window.close(); }
});

test('does not reuse observed URLs after leaving the process or when the caller expects another process', async () => {
  const target = pageUrl('documento_visualizar', '&id_documento=100');
  const surface = dom(`<a href="${target}">Document</a>`);
  try {
    execute(surface, inspectSeiFrame);
    let calls = 0;
    surface.window.fetch = async () => { calls++; return new Response('unused'); };
    await assert.rejects(execute(surface, fetchSeiResource, {url: target, processId: '99'}), /processo atual/);
    surface.reconfigure({url: `${ORIGIN}/sei/controlador.php?acao=procedimento_controlar`});
    await assert.rejects(execute(surface, fetchSeiResource, {url: target, processId: '42'}), /processo atual/);
    assert.equal(calls, 0);
  } finally { surface.window.close(); }
});

test('registers links in a downloaded tree, decodes Latin-1, and reads the next observed resource', async () => {
  const first = pageUrl('procedimento_visualizar');
  const second = pageUrl('documento_visualizar', '&id_documento=100');
  const surface = dom(`<a href="${first}">Tree</a>`);
  try {
    let calls = 0;
    surface.window.fetch = async () => {
      calls++;
      return new Response(Buffer.from(calls === 1 ? `<title>Cotação</title><a href="${second}">Documento</a>` : '<html><body>CNPJ</body></html>', 'latin1'), {headers: {'Content-Type': 'text/html;charset=ISO-8859-1'}});
    };
    const tree = await execute(surface, fetchSeiResource, {url: first});
    assert.match(tree.text, /Cotação/);
    const next = await execute(surface, fetchSeiResource, {url: second});
    assert.match(next.text, /CNPJ/);
    assert.equal(calls, 2);
  } finally { surface.window.close(); }
});

test('registers a SEI download encoded in an observed same-origin PDF viewer', async () => {
  const wrapperPage = pageUrl('arvore_visualizar', '&id_documento=101');
  const pdf = pageUrl('documento_download_anexo', '&id_anexo=9001');
  const viewer = `/sei/pdfjs/web/viewer.html?file=${encodeURIComponent(pdf)}`;
  const surface = dom(`<a href="${wrapperPage}">Open document</a>`);
  try {
    const calls = [];
    surface.window.fetch = async url => {
      calls.push(url);
      return url === wrapperPage
        ? new Response(`<iframe src="${viewer}"></iframe>`, {headers: {'Content-Type': 'text/html;charset=UTF-8'}})
        : new Response(PDF, {headers: {'Content-Type': 'application/pdf'}});
    };
    await execute(surface, fetchSeiResource, {url: wrapperPage, processId: '42', unitId: '1100'});
    const result = await execute(surface, fetchSeiResource, {url: pdf, processId: '42', unitId: '1100'});
    assert.equal(result.mime, 'application/pdf');
    assert.deepEqual(calls, [wrapperPage, pdf]);
  } finally { surface.window.close(); }
});

test('PDF viewers cannot register external, other-process, other-unit, or write URLs', async t => {
  const allowedPdf = pageUrl('documento_download_anexo', '&id_anexo=9001');
  const cases = [
    ['external wrapper', `https://example.org/viewer.html?file=${encodeURIComponent(allowedPdf)}`, allowedPdf],
    ['arbitrary wrapper', `/sei/other.html?file=${encodeURIComponent(allowedPdf)}`, allowedPdf],
    ['external file', `/sei/pdfjs/web/viewer.html?file=${encodeURIComponent('https://example.org/sei/controlador.php?acao=documento_download_anexo&id_anexo=9001')}`, 'https://example.org/sei/controlador.php?acao=documento_download_anexo&id_anexo=9001'],
    ['other process', `/sei/pdfjs/web/viewer.html?file=${encodeURIComponent(allowedPdf.replace('id_procedimento=42', 'id_procedimento=77'))}`, allowedPdf.replace('id_procedimento=42', 'id_procedimento=77')],
    ['other unit', `/sei/pdfjs/web/viewer.html?file=${encodeURIComponent(allowedPdf.replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200'))}`, allowedPdf.replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200')],
    ['write action', `/sei/pdfjs/web/viewer.html?file=${encodeURIComponent(pageUrl('documento_receber'))}`, pageUrl('documento_receber')],
  ];
  for (const [name, viewer, target] of cases) {
    await t.test(name, async () => {
      const wrapperPage = pageUrl('arvore_visualizar', '&id_documento=101');
      const surface = dom(`<a href="${wrapperPage}">Open document</a>`);
      try {
        let calls = 0;
        surface.window.fetch = async () => { calls++; return new Response(`<iframe src="${viewer}"></iframe>`, {headers: {'Content-Type': 'text/html'}}); };
        await execute(surface, fetchSeiResource, {url: wrapperPage});
        await assert.rejects(execute(surface, fetchSeiResource, {url: target}));
        assert.equal(calls, 1, 'Only the observed document wrapper may be fetched');
      } finally { surface.window.close(); }
    });
  }
});

test('does not follow redirects and detects an expired session delivered with HTTP 200', async () => {
  const target = pageUrl('documento_visualizar', '&id_documento=100');
  const surface = dom(`<a href="${target}">Document</a>`);
  try {
    surface.window.fetch = async () => new Response('', {status: 302, headers: {Location: 'https://example.org/login'}});
    await assert.rejects(execute(surface, fetchSeiResource, {url: target}), /redirecionou/);
    surface.window.fetch = async () => new Response('<form id="frmLogin"></form>', {headers: {'Content-Type': 'text/html'}});
    await assert.rejects(execute(surface, fetchSeiResource, {url: target}), /sessão.*expirou/);
  } finally { surface.window.close(); }
});

test('enforces the byte limit both from Content-Length and while streaming', async () => {
  const target = pageUrl('documento_download_anexo', '&id_documento=101');
  const surface = dom(`<a href="${target}">Document</a>`);
  try {
    surface.window.fetch = async () => new Response(PDF, {headers: {'Content-Type': 'application/pdf', 'Content-Length': '9999'}});
    await assert.rejects(execute(surface, fetchSeiResource, {url: target, maxBytes: 10}), /limite/);
    surface.window.fetch = async () => new Response(PDF, {headers: {'Content-Type': 'application/pdf'}});
    await assert.rejects(execute(surface, fetchSeiResource, {url: target, maxBytes: 10}), /limite/);
  } finally { surface.window.close(); }
});

test('navigates only through an observed signed control bound to the intended process', async () => {
  const target = pageUrl('documento_escolher_tipo');
  const surface = dom(`<a id="include" href="${target}">Incluir Documento</a>`);
  try {
    let clicks = 0;
    surface.window.document.querySelector('#include').addEventListener('click', event => { event.preventDefault(); clicks++; });
    assert.equal(execute(surface, navigateToExternalForm, {processId: '999'}).stage, 'manual');
    assert.equal(execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'}).stage, 'navigated');
    await tick();
    assert.equal(clicks, 1);
  } finally { surface.window.close(); }
});

test('finds SEI 5 type-choice controls with href=# and uses the visible external action', async () => {
  const surface = dom(`<form id="frmDocumentoEscolherTipo" action="${pageUrl('documento_escolher_tipo')}"><table id="tblSeries"><tr><td><a id="external" href="#" onclick="escolher(-1)">Externo</a></td></tr></table></form>`, pageUrl('documento_escolher_tipo'));
  try {
    let clicks = 0;
    surface.window.document.querySelector('#external').addEventListener('click', event => { event.preventDefault(); clicks++; });
    assert.equal(execute(surface, inspectSeiFrame).isTypeChoice, true);
    assert.equal(execute(surface, navigateToExternalForm, {processId: '42'}).stage, 'navigated');
    await tick();
    assert.equal(clicks, 1);
  } finally { surface.window.close(); }
});

test('reuses the exact observed signed process action in an existing content iframe', async () => {
  const surface = dom(treeHtml() + '<iframe id="ifrConteudoVisualizacao" src="about:blank"></iframe>');
  try {
    execute(surface, inspectSeiFrame);
    const result = execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'});
    assert.equal(result.stage, 'navigated');
    assert.equal(result.destination, 'choose-type');
    await tick();
    assert.equal(surface.window.document.querySelector('#ifrConteudoVisualizacao').getAttribute('src'), pageUrl('documento_escolher_tipo'));
  } finally { surface.window.close(); }
});

test('distinguishes an action recorded in the tree from the visible native toolbar in SEI nested frames', async () => {
  // Minimal markup from the SEI 4.1 trabalhar/arvore_visualizar fixtures:
  // top -> ifrConteudoVisualizacao (toolbar) -> ifrVisualizacao (action).
  // Native page scripts are not loaded or evaluated; the rendered root link
  // and toolbar are mounted directly to represent the finished SEI DOM.
  const surface = dom(`<iframe id="ifrArvore" src="${pageUrl('procedimento_visualizar')}"></iframe><iframe id="ifrConteudoVisualizacao" src="${pageUrl('arvore_visualizar')}"></iframe><section id="crc-sei-panel">Assistente</section>`);
  try {
    const top = surface.window;
    const tree = top.document.querySelector('#ifrArvore').contentWindow;
    tree.document.open();
    tree.document.write(`${treeHtml()}<div id="divArvore"><a id="process-root" target="ifrConteudoVisualizacao" href="${pageUrl('arvore_visualizar')}">Processo</a></div>`);
    tree.document.close();
    const outer = top.document.querySelector('#ifrConteudoVisualizacao');
    const shell = outer.contentWindow;
    shell.document.open();
    shell.document.write(`<div id="divArvoreAcoes"><a id="native-include" href="${pageUrl('documento_escolher_tipo')}" target="ifrVisualizacao"><img alt="Incluir Documento"></a></div><iframe id="ifrVisualizacao" name="ifrVisualizacao" src="about:blank"></iframe>`);
    shell.document.close();
    const invoke = (win, fn, args = {}) => win.eval(`(${fn.toString()})(${JSON.stringify(args)})`);
    const treeState = invoke(tree, inspectSeiFrame);
    const shellState = invoke(shell, inspectSeiFrame);
    assert.equal(treeState.includeUrl, shellState.includeUrl);
    assert.equal(treeState.hasVisibleIncludeControl, false);
    assert.equal(shellState.hasVisibleIncludeControl, true);
    assert.equal(shellState.hasVisibleExternalControl, false);
    assert.equal(treeState.isExternalForm, false);
    let rootClicks = 0;
    tree.document.querySelector('#process-root').addEventListener('click', event => { event.preventDefault(); rootClicks++; });
    const originalOuterUrl = outer.getAttribute('src');
    const inner = shell.document.querySelector('#ifrVisualizacao');
    const originalToolbar = shell.document.querySelector('#divArvoreAcoes');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = invoke(tree, navigateToExternalForm, {processId: '42', unitId: '1100'});
      assert.equal(result.stage, 'navigated');
      assert.equal(result.destination, 'choose-type');
      await tick();
      assert.equal(inner.getAttribute('src'), pageUrl('documento_escolher_tipo'));
      assert.equal(outer.getAttribute('src'), originalOuterUrl);
      assert.equal(shell.document.querySelector('#divArvoreAcoes'), originalToolbar);
      assert.ok(top.document.querySelector('#crc-sei-panel').isConnected);
    }
    assert.equal(rootClicks, 0, 'The usable signed action must take precedence over reselecting the process root');
  } finally { surface.window.close(); }
});

test('visible control flags exclude hidden controls, other units, unsigned links and document body links', () => {
  const target = pageUrl('documento_escolher_tipo');
  for (const scenario of [
    { html: `<style>.collapsed {display:none}</style><div class="collapsed"><a href="${target}">Incluir Documento</a></div>` },
    { html: `<a href="${target.replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200')}">Incluir Documento</a>` },
    { html: `<a href="${target.replace('&infra_hash=fixture', '')}">Incluir Documento</a>` },
    { html: `<a href="${target.replace('id_procedimento=42', 'id_procedimento=99')}">Incluir Documento</a>` },
    { html: `<a href="${target}">Incluir Documento</a>`, url: pageUrl('documento_visualizar', '&id_documento=100') },
  ]) {
    const surface = dom(scenario.html, scenario.url);
    try {
      const inspected = execute(surface, inspectSeiFrame);
      assert.equal(inspected.hasVisibleIncludeControl, false);
      assert.equal(inspected.hasVisibleExternalControl, false);
      assert.equal(execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'}).stage, 'manual');
    } finally { surface.window.close(); }
  }
});

test('the external choice requires its native choosing action, not merely a checkbox whose value is -1', async () => {
  for (const includeAction of [true, false]) {
    const surface = dom(`<form id="frmDocumentoEscolherTipo" action="${pageUrl('documento_escolher_tipo')}"><table id="tblSeries"><tbody><tr><td><input id="selection" type="checkbox" value="-1" onclick="infraSelecionarItens(this,'Infra');">${includeAction ? '<a id="external" href="#" onclick="escolher(-1)"> Externo</a>' : ''}</td></tr></tbody></table></form>`, pageUrl('documento_escolher_tipo'));
    try {
      let selections = 0, actions = 0;
      surface.window.document.querySelector('#selection').addEventListener('click', event => { event.preventDefault(); selections++; });
      surface.window.document.querySelector('#external')?.addEventListener('click', event => { event.preventDefault(); actions++; });
      assert.equal(execute(surface, inspectSeiFrame).hasVisibleExternalControl, includeAction);
      const result = execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'});
      assert.equal(result.stage, includeAction ? 'navigated' : 'manual');
      await tick();
      assert.equal(selections, 0);
      assert.equal(actions, includeAction ? 1 : 0);
    } finally { surface.window.close(); }
  }
});

test('signed inclusion without a form action uses the current URL and still rejects edit, unit and signature mismatches', () => {
  for (const scenario of [
    { url: pageUrl('documento_receber'), valid: true },
    { url: pageUrl('documento_receber').replace('&infra_hash=fixture', ''), valid: false },
    { url: pageUrl('documento_receber'), action: pageUrl('documento_receber').replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200'), valid: false },
    { url: pageUrl('documento_alterar_recebido', '&id_documento=100'), action: pageUrl('documento_receber'), valid: false },
    { url: pageUrl('documento_receber'), action: pageUrl('documento_receber').replace('id_procedimento=42', 'id_procedimento=99'), valid: false },
  ]) {
    const surface = dom(`<form id="frmDocumentoCadastro" ${scenario.action ? `action="${scenario.action}"` : ''}><input id="hdnIdProcedimento" value="42"></form>`, scenario.url);
    try {
      assert.equal(execute(surface, inspectSeiFrame).isExternalForm, scenario.valid);
      assert.equal(execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'}).stage, scenario.valid ? 'form' : 'manual');
    } finally { surface.window.close(); }
  }
});

test('the observed-action fallback does not use another unit when the current URL omits its unit', async () => {
  const surface = dom('<iframe id="ifrConteudoVisualizacao" src="about:blank"></iframe>', pageUrl('procedimento_trabalhar').replace('&infra_unidade_atual=1100', ''));
  try {
    surface.window.__CRC_SEI_OBSERVED_V1__ = { origin: ORIGIN, processId: '42', urls: new Set([pageUrl('documento_escolher_tipo').replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200')]) };
    assert.equal(execute(surface, navigateToExternalForm, {processId: '42', unitId: '1100'}).stage, 'manual');
    await tick();
    assert.equal(surface.window.document.querySelector('#ifrConteudoVisualizacao').getAttribute('src'), 'about:blank');
  } finally { surface.window.close(); }
});

test('type selection completes before fields and file are filled', async () => {
  const {surface, counts} = externalForm({selected: '1'});
  let replacement;
  try {
    const result = await execute(surface, prepareExternalDocument, PAYLOAD);
    assert.equal(result.stage, 'type-changing');
    assert.equal(counts.uploads, 0);
    assert.equal(surface.window.document.querySelector('#txtDataElaboracao').value, '01/01/2020');
    await tick();
    assert.equal(counts.typeChanges, 1);
    const repeated = await execute(surface, prepareExternalDocument, PAYLOAD);
    assert.equal(repeated.stage, 'type-changing');
    await tick();
    assert.equal(counts.typeChanges, 1, 'The old DOM cannot submit the type change twice');
    assert.equal(counts.uploads, 0, 'The selected value in the old DOM is not a completed form transition');
    assert.equal(surface.window.document.querySelector('#txtDataElaboracao').value, '01/01/2020');
    replacement = externalForm({selected: '55'});
    const prepared = await execute(replacement.surface, prepareExternalDocument, PAYLOAD);
    assert.equal(prepared.stage, 'prepared');
    assert.equal(replacement.counts.uploads, 1);
  } finally { surface.window.close(); replacement?.surface.window.close(); }
});

test('prepares a nato-digital public CRC and waits for confirmed upload without saving', async () => {
  const {surface, counts} = externalForm();
  try {
    const prepared = await execute(surface, prepareExternalDocument, {...PAYLOAD, submit: true});
    assert.equal(prepared.stage, 'prepared');
    assert.equal(prepared.access, '0');
    assert.equal(prepared.format, 'N');
    assert.equal(prepared.documentDate, '08/10/2026');
    assert.match(prepared.sha256, /^[0-9a-f]{64}$/);
    assert.match(prepared.observations, /14:30:00/);
    assert.equal(counts.saves, 0);
    assert.equal(surface.window.document.querySelector('#hdnFlagDocumentoCadastro').value, '1');
    const again = await execute(surface, prepareExternalDocument, PAYLOAD);
    assert.equal(again.stage, 'prepared');
    assert.equal(counts.uploads, 1, 'Repeated preparation must not upload a duplicate');
  } finally { surface.window.close(); }
});

test('only the separate final action saves, and an uncertain save cannot be repeated', async () => {
  const {surface, counts} = externalForm();
  try {
    await execute(surface, prepareExternalDocument, PAYLOAD);
    const saving = await execute(surface, submitPreparedExternalDocument, PAYLOAD);
    assert.equal(saving.stage, 'saving');
    await assert.rejects(execute(surface, submitPreparedExternalDocument, PAYLOAD), /salvamento já foi iniciado/);
    await tick();
    assert.equal(counts.saves, 1);
    assert.equal(surface.window.document.querySelector('#hdnFlagDocumentoCadastro').value, '2');
  } finally { surface.window.close(); }
});

test('does not replace generic certidão, an existing attachment, or an existing document', async t => {
  for (const scenario of ['generic', 'attachment', 'existing-document', 'wrong-process', 'invalid-pdf']) {
    await t.test(scenario, async () => {
      const {surface, counts} = externalForm({crcLabel: scenario === 'generic' ? 'Certidão' : 'CRC', existing: scenario === 'attachment' ? 'tmp±outro.pdf±08/10/2026±123±1 KB±u±x' : ''});
      try {
        if (scenario === 'existing-document') surface.window.document.querySelector('#hdnIdDocumento').value = '123';
        if (scenario === 'wrong-process') surface.window.document.querySelector('#hdnIdProcedimento').value = '43';
        const payload = scenario === 'invalid-pdf' ? {...PAYLOAD, fileBase64: Buffer.from('<html>Login</html>').toString('base64')} : PAYLOAD;
        await assert.rejects(execute(surface, prepareExternalDocument, payload));
        assert.equal(counts.uploads, 0);
        assert.equal(counts.saves, 0);
      } finally { surface.window.close(); }
    });
  }
});

test('accepts the expanded exact CRC label and an alphanumeric CNPJ', async () => {
  const {surface, counts} = externalForm({crcLabel: 'Certificado de Registro Cadastral (CRC)'});
  try {
    const result = await execute(surface, prepareExternalDocument, {...PAYLOAD, cnpj: '12.ABC.345/01DE-35'});
    assert.equal(result.cnpj, '12ABC34501DE35');
    assert.equal(result.stage, 'prepared');
    assert.equal(counts.saves, 0);
  } finally { surface.window.close(); }
});

test('refuses a PDF whose SHA-256 differs from the selected certificate', async () => {
  const {surface, counts} = externalForm();
  try {
    await assert.rejects(execute(surface, prepareExternalDocument, {...PAYLOAD, sha256: '0'.repeat(64)}), /conteúdo do CRC/);
    assert.equal(counts.uploads, 0);
    assert.equal(counts.saves, 0);
  } finally { surface.window.close(); }
});

test('refuses final saving when required fields, destination, or attachment changed', async t => {
  for (const scenario of ['date', 'access', 'type', 'annex', 'unit']) {
    await t.test(scenario, async () => {
      const {surface, counts} = externalForm();
      try {
        await execute(surface, prepareExternalDocument, PAYLOAD);
        const doc = surface.window.document;
        if (scenario === 'date') doc.querySelector('#txtDataElaboracao').value = '09/10/2026';
        if (scenario === 'access') doc.querySelector('#optRestrito').checked = true;
        if (scenario === 'type') doc.querySelector('#selSerie').value = '1';
        if (scenario === 'annex') doc.querySelector('#hdnAnexos').value += '¥tmp±other.pdf±08/10/2026±12';
        if (scenario === 'unit') surface.reconfigure({url: pageUrl('documento_receber').replace('infra_unidade_atual=1100', 'infra_unidade_atual=2200')});
        await assert.rejects(execute(surface, submitPreparedExternalDocument, PAYLOAD));
        await tick();
        assert.equal(counts.saves, 0);
      } finally { surface.window.close(); }
    });
  }
});
