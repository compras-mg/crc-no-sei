import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCrc, lookupSupplier } from '../lib/cagef.js';

const CNPJ = '12345678000195';
const MASKED = '12.345.678/0001-95';
const PDF = new TextEncoder().encode('%PDF-1.7\nCAGEF adapter fixture\n%%EOF');
const DOWNLOAD = '/fornecedor-web/zkau/view/desktop1/dwnmed-0/3711/Relatorio_Crc_Fornecedor.pdf';

function initial(endpoint = '/fornecedor-web/zkau') {
  return `<html><script>zkmx([0,'root',{dt:'desktop1',cu:'/fornecedor-web',uu:${JSON.stringify(endpoint)}},{},[
    ['zul.wnd.Window','main',{id:'index'},{},[
      ['zkmax.nav.Navitem','menuA',{id:'consultaFornecedoresItemMenu',$onClick:true,label:'Consultar Fornecedores'},{},[]]
    ]]
  ]]);</script></html>`;
}

function query(includeCrc = true) {
  return String.raw`{"rs":[["addChd",["root",[
    ['zul.inp.Textbox','inputA',{id:'cnpjBox',listeners:{onBind:function(event){cnpjAlfanumerico(this)}},constraint:'[s'},{},[]],
    ['zul.wgt.Button','searchA',{$onClick:true,label:'Pesquisar',autodisable:'self'},{},[]],
    ['zul.wgt.Button','reportA',{id:'relDadosFornecedor',label:'RELAT\xD3RIO DE DADOS DO FORNECEDOR'},{},[]],
    ${includeCrc ? "['zul.wgt.Button','crcA',{id:'botaoEmitirCRC',visible:false,label:'Emitir CRC do Fornecedor'},{},[]]," : ''}
    ['zul.sel.Listbox','resultsA',{id:'listaSelecao'},{},[]]
  ]]]],"rid":1}`;
}

function searchResult({ cnpj = MASKED, name = 'FORNECEDOR DE TESTE LTDA', duplicate = false, columns } = {}) {
  const fields = columns ?? [
    { id: 'headCpfCnpj', label: 'CPF ou CNPJ do Fornecedor', value: cnpj },
    { id: 'headNome', label: 'Nome Empresarial ou Nome do Fornecedor', value: name },
  ];
  const row = uuid => `['zul.sel.Listitem','${uuid}',{_loaded:true,_index:0},{},[
    ${fields.map((field, index) => `['zul.sel.Listcell','${uuid}${index}',{label:${JSON.stringify(field.value)}},{},[]]`).join(',\n')}
  ]]`;
  return `{"rs":[["outer",[{$u:'resultsA'},[
    ['zul.sel.Listbox','resultsA',{id:'listaSelecao',model:true,_totalSize:1},{},[
      ['zul.sel.Listhead','headA',{id:'cabecalho'},{},[
        ${fields.map((field, index) => `['zul.sel.Listheader','header${index}',{id:${JSON.stringify(field.id)},label:${JSON.stringify(field.label ?? field.id)}},{},[]]`).join(',\n')}
      ]],
      ${row('rowA')}${duplicate ? ',' + row('rowB') : ''}
    ]]
  ]]],
  ["addChd",["unrelatedColumnPicker",[
    ['zul.sel.Listitem','unrelatedA',{_index:0},{},[
      ['zul.sel.Listcell','unrelatedB',{label:'E-mail'},{},[]]
    ]]
  ]]]],"rid":2}`;
}

function fixture({ initialText = initial(), queryText = query(), searchText = searchResult(), selectionText = '{"rs":[],"rid":3}', emissionText, pdf = PDF, pdfHeaders = {}, requestLimit = 6 } = {}) {
  const output = [initialText, queryText, searchText, selectionText,
    emissionText ?? JSON.stringify({ rs: [['download', [DOWNLOAD]]], rid: 4 }), pdf];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    const index = calls.length - 1;
    assert.ok(index < Math.min(output.length, requestLimit), 'Unexpected additional request');
    return new Response(output[index], { status: 200, headers: index === 5
      ? { 'Content-Type': 'application/pdf;charset=UTF-8', ...pdfHeaders }
      : { 'Content-Type': 'text/plain;charset=UTF-8' } });
  };
  return { fetchImpl, calls };
}

test('issues the original CRC using discovered identifiers and the exact returned download URL', async () => {
  const mocked = fixture();
  const messages = [];
  const before = Date.now();
  const result = await generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl, onProgress: text => messages.push(text) });
  assert.equal(mocked.calls.length, 6);
  assert.deepEqual(Uint8Array.from(Buffer.from(result.base64, 'base64')), PDF);
  assert.equal(result.cnpj, CNPJ);
  assert.equal(result.supplierName, 'FORNECEDOR DE TESTE LTDA');
  assert.equal(result.mime, 'application/pdf');
  assert.match(result.fileName, /^CRC_12345678000195_\d{8}T\d{6}Z\.pdf$/);
  assert.ok(Date.parse(result.generatedAt) >= before && Date.parse(result.generatedAt) <= Date.now());
  assert.equal(result.sourceUrl, 'https://www.cagef.mg.gov.br/fornecedor-web');
  assert.equal(mocked.calls[5].url, `https://www.cagef.mg.gov.br${DOWNLOAD}`);
  const bodies = mocked.calls.slice(1, 5).map(call => new URLSearchParams(call.options.body));
  assert.equal(bodies[0].get('uuid_0'), 'menuA');
  assert.equal(bodies[1].get('dtid'), 'desktop1');
  assert.equal(bodies[1].get('cmd_0'), 'onChange');
  assert.deepEqual(JSON.parse(bodies[1].get('data_0')), { value: MASKED, start: 18 });
  assert.equal(bodies[1].get('uuid_1'), 'searchA');
  assert.deepEqual(JSON.parse(bodies[2].get('data_0')), { items: ['rowA'], reference: 'rowA', clearFirst: true, selectAll: false });
  assert.equal(bodies[3].get('uuid_0'), 'crcA');
  assert.ok(messages.every(message => typeof message === 'string'));
  assert.equal(messages.length, 4);
});

test('preserves CNPJ letters instead of converting an alphanumeric CNPJ to digits', async () => {
  const mocked = fixture({ searchText: searchResult({ cnpj: '12.ABC.345/01DE-35' }) });
  const result = await generateCrc('12.abc.345/01de-35', { fetchImpl: mocked.fetchImpl });
  assert.equal(result.cnpj, '12ABC34501DE35');
  const data = JSON.parse(new URLSearchParams(mocked.calls[2].options.body).get('data_0'));
  assert.equal(data.value, '12.ABC.345/01DE-35');
});

test('decodes ZK escaped URLs without executing JavaScript literals', async () => {
  const escaped = initial().replace("uu:\"/fornecedor-web/zkau\"", String.raw`uu:'\x2Ffornecedor\x2Dweb\x2Fzkau'`);
  const name = "A ['zul.sel.Listitem','spoof',{id:'bad'},{},[]] LTDA";
  const mocked = fixture({ initialText: escaped, searchText: searchResult({ name }) });
  const result = await generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl });
  assert.equal(result.supplierName, name);
  assert.equal(mocked.calls[1].url, 'https://www.cagef.mg.gov.br/fornecedor-web/zkau');
});

test('rejects incomplete or malformed CNPJ before any network request', async () => {
  const mocked = fixture();
  await assert.rejects(generateCrc('invalid', { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_CNPJ');
  assert.equal(mocked.calls.length, 0);
});

test('rejects a provider response for a different CNPJ', async () => {
  const mocked = fixture({ searchText: searchResult({ cnpj: '11.222.333/0001-81' }) });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_NOT_FOUND');
  assert.equal(mocked.calls.length, 3);
});

test('stops on ambiguous duplicate results before selecting or issuing a CRC', async () => {
  const mocked = fixture({ searchText: searchResult({ duplicate: true }) });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), /mais de um cadastro/);
  assert.equal(mocked.calls.length, 3);
});

test('never uses the separate supplier data report when the CRC button is absent', async () => {
  const mocked = fixture({ queryText: query(false) });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), /Emitir CRC do Fornecedor/);
  assert.equal(mocked.calls.length, 2);
});

test('explains a CAGEF refusal to issue a CRC and does not substitute another document', async () => {
  const mocked = fixture({ emissionText: JSON.stringify({ rs: [['alert', ['Cadastro Geral vencido.']]], rid: 4 }) });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), /Cadastro Geral vencido/);
  assert.equal(mocked.calls.length, 5);
});

test('extracts server messages from a ZK message box without evaluating its functions', async () => {
  const mocked = fixture({ emissionText: String.raw`{"rs":[["addChd",["root",[
    ['zul.wnd.Window','message',{id:'zk_msgbox',listeners:{onBind:function(){throw new Error('must not run')}}},{},[
      ['zul.wgt.Label','messageLabel',{value:'Fornecedor n\xE3o possui Cadastro Geral.'},{},[]]
    ]
  ]]]],"rid":4}` });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), /Fornecedor não possui Cadastro Geral/);
  assert.equal(mocked.calls.length, 5);
});

test('surfaces a not-found response rather than attempting another provider', async () => {
  const mocked = fixture({ searchText: '{"rs":[["alert",["Nenhum fornecedor encontrado."]]],"rid":2}' });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), /Nenhum fornecedor encontrado/);
  assert.equal(mocked.calls.length, 3);
});

test('does not follow an update URL outside the official CAGEF service', async () => {
  for (const endpoint of ['https://example.org/steal', '/outside', '/fornecedor-web/../outside']) {
    const mocked = fixture({ initialText: initial(endpoint) });
    await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_UNSAFE_URL');
    assert.equal(mocked.calls.length, 1);
  }
});

test('does not fetch an external or unexpected download path', async () => {
  for (const url of ['https://example.org/fake.pdf', '/fornecedor-web/public/fake.pdf', 'https://www.cagef.mg.gov.br@evil.example/fornecedor-web/zkau/view/fake.pdf']) {
    const mocked = fixture({ emissionText: JSON.stringify({ rs: [['download', [url]]] }) });
    await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => ['CAGEF_UNSAFE_URL', 'CAGEF_PROTOCOL'].includes(error.code));
    assert.equal(mocked.calls.length, 5);
  }
});

test('rejects HTML in the download even when the content type says PDF', async () => {
  const mocked = fixture({ pdf: '<html>Session expired</html>' });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_NOT_PDF');
});

test('rejects a download exceeding the declared 20 MB limit', async () => {
  const mocked = fixture({ pdfHeaders: { 'Content-Length': String(21 * 1024 * 1024) } });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_SIZE_LIMIT');
});

test('reports a blocked public portal without trying to bypass it', async () => {
  const mocked = fixture({ initialText: '<html>Request Rejected</html>' });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_BLOCKED');
  assert.equal(mocked.calls.length, 1);
});

test('honors cancellation before starting the query', async () => {
  const mocked = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(mocked.calls.length, 0);
});

test('honors cancellation during a request', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    controller.abort();
  });
  await assert.rejects(generateCrc(CNPJ, { fetchImpl, signal: controller.signal }), error => error.name === 'AbortError');
});

test('a UI progress callback failure cannot change the selected provider or document', async () => {
  const mocked = fixture();
  const result = await generateCrc(CNPJ, { fetchImpl: mocked.fetchImpl, onProgress() { throw new Error('UI unavailable'); } });
  assert.equal(result.cnpj, CNPJ);
  assert.equal(mocked.calls.length, 6);
});


function assertLookupOnly(calls) {
  assert.equal(calls.length, 3, 'Lookup must stop before selecting a supplier');
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST', 'POST']);
  assert.equal(calls[0].url, 'https://www.cagef.mg.gov.br/fornecedor-web');
  const menu = new URLSearchParams(calls[1].options.body);
  const search = new URLSearchParams(calls[2].options.body);
  assert.equal(menu.get('cmd_0'), 'onClick');
  assert.equal(menu.get('uuid_0'), 'menuA');
  assert.equal(menu.has('cmd_1'), false);
  assert.equal(search.get('cmd_0'), 'onChange');
  assert.equal(search.get('uuid_0'), 'inputA');
  assert.equal(search.get('cmd_1'), 'onClick');
  assert.equal(search.get('uuid_1'), 'searchA');
  assert.equal(search.has('cmd_2'), false);
  for (const call of calls) {
    assert.doesNotMatch(call.url, /zkau\/view\//);
    assert.doesNotMatch(call.options.body || '', /onSelect|crcA|reportA/);
  }
}

test('looks up the official supplier name with only the public search requests', async () => {
  const mocked = fixture({ requestLimit: 3 });
  const progress = [];
  const result = await lookupSupplier(MASKED, { fetchImpl: mocked.fetchImpl, onProgress: message => progress.push(message) });
  assert.deepEqual(result, {
    cnpj: CNPJ, supplierName: 'FORNECEDOR DE TESTE LTDA',
    sourceUrl: 'https://www.cagef.mg.gov.br/fornecedor-web',
  });
  assertLookupOnly(mocked.calls);
  assert.equal(progress.length, 2);
  assert.ok(progress.every(message => typeof message === 'string'));
  assert.ok(progress.every(message => !/emitindo|baixando/i.test(message)));
  const input = JSON.parse(new URLSearchParams(mocked.calls[2].options.body).get('data_0'));
  assert.deepEqual(input, { value: MASKED, start: 18 });
});

test('name lookup does not require a CRC button or select a supplier to check issuance eligibility', async () => {
  const mocked = fixture({
    queryText: query(false), requestLimit: 3,
    selectionText: JSON.stringify({ rs: [['alert', ['Cadastro Geral vencido.']]] }),
  });
  const result = await lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl });
  assert.equal(result.supplierName, 'FORNECEDOR DE TESTE LTDA');
  assertLookupOnly(mocked.calls);
});

test('name lookup normalizes alphanumeric CNPJs and preserves their letters in the request', async () => {
  const mocked = fixture({ searchText: searchResult({ cnpj: '12.ABC.345/01DE-35' }), requestLimit: 3 });
  const result = await lookupSupplier('12.abc.345/01de-35', { fetchImpl: mocked.fetchImpl });
  assert.equal(result.cnpj, '12ABC34501DE35');
  assert.equal(result.supplierName, 'FORNECEDOR DE TESTE LTDA');
  assertLookupOnly(mocked.calls);
  const data = JSON.parse(new URLSearchParams(mocked.calls[2].options.body).get('data_0'));
  assert.equal(data.value, '12.ABC.345/01DE-35');
});

test('name lookup rejects a different CNPJ or duplicated matching rows without selecting anything', async () => {
  for (const searchText of [searchResult({ cnpj: '11.222.333/0001-81' }), searchResult({ duplicate: true })]) {
    const mocked = fixture({ searchText, requestLimit: 3 });
    await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_NOT_FOUND');
    assertLookupOnly(mocked.calls);
  }
});

test('name lookup leaves an empty or non-text name unavailable instead of guessing', async () => {
  for (const name of ['', ' \n\t ', null, 42]) {
    const mocked = fixture({ searchText: searchResult({ name }), requestLimit: 3 });
    const result = await lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl });
    assert.equal(result.cnpj, CNPJ);
    assert.equal(result.supplierName, '');
    assertLookupOnly(mocked.calls);
  }
});

test('lookup and issuance follow identified columns even when the supplier name precedes the CNPJ', async () => {
  const searchText = searchResult({ columns: [
    { id: 'headNome', value: 'FORNECEDOR NA PRIMEIRA COLUNA LTDA' },
    { id: 'headMunicipio', value: 'BELO HORIZONTE' },
    { id: 'headCpfCnpj', value: MASKED },
  ] });
  const lookup = fixture({ searchText, requestLimit: 3 });
  const result = await lookupSupplier(CNPJ, { fetchImpl: lookup.fetchImpl });
  assert.equal(result.supplierName, 'FORNECEDOR NA PRIMEIRA COLUNA LTDA');
  assertLookupOnly(lookup.calls);
  const issuance = fixture({ searchText });
  const issued = await generateCrc(CNPJ, { fetchImpl: issuance.fetchImpl });
  assert.equal(issued.supplierName, result.supplierName);
  assert.equal(issuance.calls.length, 6);
});

test('name lookup requires a unique headNome and does not borrow another column or unrelated row', async () => {
  const cases = [
    [
      { id: 'headCpfCnpj', value: MASKED },
      { id: 'headMunicipio', label: 'Nome Empresarial ou Nome do Fornecedor', value: 'NÃO É NOME CONFIRMADO LTDA' },
    ],
    [
      { id: 'headCpfCnpj', value: MASKED },
      { id: 'headNome', value: 'PRIMEIRA RAZÃO SOCIAL LTDA' },
      { id: 'headNome', value: 'OUTRA RAZÃO SOCIAL LTDA' },
    ],
    [
      { id: 'headCpfCnpj', value: MASKED },
      { id: 'headNome', value: undefined },
      { id: 'headMunicipio', value: 'NOME EM OUTRA COLUNA LTDA' },
    ],
  ];
  for (const columns of cases) {
    const mocked = fixture({ searchText: searchResult({ columns }), requestLimit: 3 });
    const result = await lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl });
    assert.equal(result.supplierName, '');
    assertLookupOnly(mocked.calls);
  }
});

test('name lookup leaves the name unavailable when row cells do not align with the headers', async () => {
  const searchText = searchResult().replace("['zul.sel.Listcell','rowA1'", "['zul.sel.Listcell','extraCell',{label:'NOME SEM COLUNA CONFIRMADA'},{},[]],['zul.sel.Listcell','rowA1'");
  const mocked = fixture({ searchText, requestLimit: 3 });
  const result = await lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl });
  assert.equal(result.supplierName, '');
  assertLookupOnly(mocked.calls);
});

test('name lookup decodes escaped ZK names without treating name text as executable widgets', async () => {
  const escapedName = String.raw`'A\xC7O D\'\u00C1GUA "MG" \\ LTDA'`;
  const searchText = searchResult({ name: 'ESCAPED_NAME' }).replace('"ESCAPED_NAME"', escapedName);
  const mocked = fixture({ searchText, requestLimit: 3 });
  const result = await lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl });
  assert.equal(result.supplierName, "AÇO D'ÁGUA \"MG\" \\ LTDA");
  assertLookupOnly(mocked.calls);
  const literalName = "A ['zul.sel.Listitem','spoof',{id:'bad'},{},[]] LTDA";
  const literal = fixture({ searchText: searchResult({ name: literalName }), requestLimit: 3 });
  assert.equal((await lookupSupplier(CNPJ, { fetchImpl: literal.fetchImpl })).supplierName, literalName);
  assertLookupOnly(literal.calls);
});

test('name lookup refuses missing or ambiguous CNPJ headers even if a cell resembles the requested number', async () => {
  for (const columns of [
    [{ id: 'otherColumn', value: MASKED }, { id: 'headNome', value: 'NOME NÃO CONFIRMADO LTDA' }],
    [{ id: 'headCpfCnpj', value: MASKED }, { id: 'headCpfCnpj', value: MASKED }, { id: 'headNome', value: 'NOME NÃO CONFIRMADO LTDA' }],
  ]) {
    const mocked = fixture({ searchText: searchResult({ columns }), requestLimit: 3 });
    await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_PROTOCOL');
    assertLookupOnly(mocked.calls);
  }
});

test('name lookup rejects malformed CNPJs and cancellation before starting', async () => {
  const mocked = fixture({ requestLimit: 3 });
  await assert.rejects(lookupSupplier('invalid', { fetchImpl: mocked.fetchImpl }), error => error.code === 'CAGEF_CNPJ');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: mocked.fetchImpl, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(mocked.calls.length, 0);
});

test('name lookup honors cancellation before the search and after its last response arrives', async () => {
  const beforeSearch = fixture({ requestLimit: 3 });
  const beforeController = new AbortController();
  await assert.rejects(lookupSupplier(CNPJ, {
    fetchImpl: beforeSearch.fetchImpl,
    signal: beforeController.signal,
    onProgress(message) { if (message.startsWith('Consultando')) beforeController.abort(); },
  }), error => error.name === 'AbortError');
  assert.equal(beforeSearch.calls.length, 2);
  const duringSearch = fixture({ requestLimit: 3 });
  const duringController = new AbortController();
  await assert.rejects(lookupSupplier(CNPJ, {
    signal: duringController.signal,
    fetchImpl: async (url, options) => {
      const response = await duringSearch.fetchImpl(url, options);
      if (duringSearch.calls.length === 3) duringController.abort();
      return response;
    },
  }), error => error.name === 'AbortError');
  assertLookupOnly(duringSearch.calls);
});

test('name lookup preserves official-origin checks, portal blocking and text size limits', async () => {
  const unsafe = fixture({ initialText: initial('https://example.org/fornecedor-web/zkau'), requestLimit: 3 });
  await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: unsafe.fetchImpl }), error => error.code === 'CAGEF_UNSAFE_URL');
  assert.equal(unsafe.calls.length, 1);
  const blocked = fixture({ initialText: '<html>Request Rejected</html>', requestLimit: 3 });
  await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: blocked.fetchImpl }), error => error.code === 'CAGEF_BLOCKED');
  assert.equal(blocked.calls.length, 1);
  let requests = 0;
  await assert.rejects(lookupSupplier(CNPJ, { fetchImpl: async () => {
    requests += 1;
    return new Response(initial(), { headers: { 'Content-Length': String(3 * 1024 * 1024 + 1) } });
  } }), error => error.code === 'CAGEF_SIZE_LIMIT');
  assert.equal(requests, 1);
});

function cpfFixture({identity='012.345.678-90',duplicate=false,confirm=true}={}) {
 const cpfQuery=query().replace("['zul.inp.Textbox','inputA'", "['zul.wgt.Radiogroup','personGroup',{id:'tipoPessoa'},{},[['zul.wgt.Radio','personCpf',{label:'Pessoa Física',value:true},{},[]]]],\n['zul.inp.Textbox','cpfInput',{id:'cpfBox',visible:false},{},[]],\n['zul.inp.Textbox','inputA'");
 const output=[initial(),cpfQuery,JSON.stringify({rs:confirm?[['setAttr',[{$u:'cpfInput'},'visible',true]]]:[]}),searchResult({cnpj:identity,duplicate,name:'Pessoa de Teste'}),'{"rs":[]}',JSON.stringify({rs:[['download',[DOWNLOAD]]]}),PDF];
 const calls=[];
 return {calls,fetchImpl:async(url,options)=>{calls.push({url,options});assert.ok(calls.length<=output.length);return new Response(output[calls.length-1],{status:200});}};
}
test('CPF selects Pessoa Física using the verified ZK event before filling cpfBox and issuing CRC',async()=>{
 const f=cpfFixture();const result=await generateCrc('012.345.678-90',{fetchImpl:f.fetchImpl});assert.equal(result.cnpj,'01234567890');assert.equal(result.supplierName,'Pessoa de Teste');assert.equal(f.calls.length,7);
 const mode=new URLSearchParams(f.calls[2].options.body);assert.equal(mode.get('uuid_0'),'personCpf');assert.equal(mode.get('cmd_0'),'onCheck');assert.deepEqual(JSON.parse(mode.get('data_0')),{'':true});
 const search=new URLSearchParams(f.calls[3].options.body);assert.equal(search.get('uuid_0'),'cpfInput');assert.deepEqual(JSON.parse(search.get('data_0')),{value:'012.345.678-90',start:14});
});
test('CPF name lookup never selects a row or emits a certificate',async()=>{
 const f=cpfFixture();const result=await lookupSupplier('01234567890',{fetchImpl:f.fetchImpl});assert.equal(result.supplierName,'Pessoa de Teste');assert.equal(f.calls.length,4);
});
test('CPF lookup stops for wrong identity, duplicated results or unconfirmed person mode',async()=>{
 for(const options of [{identity:'123.456.789-09'},{duplicate:true},{confirm:false}]) {const f=cpfFixture(options);await assert.rejects(generateCrc('01234567890',{fetchImpl:f.fetchImpl}));assert.ok(f.calls.length<=4);}
 const f=cpfFixture();await assert.rejects(generateCrc('01234567891',{fetchImpl:f.fetchImpl}));assert.equal(f.calls.length,0);
});
