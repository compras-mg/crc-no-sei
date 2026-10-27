import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCpf,isValidCpf,formatCpf,extractTaxIds,extractCpfs} from '../lib/core.js';
import {inspectCrcText,buildCrcFileName} from '../lib/pdf.js';
const cpf='01234567890';
const cert=(id='012.345.678-90',label='CPF')=>`CERTIFICADO DE REGISTRO CADASTRAL DO FORNECEDOR - CRC\nIDENTIFICAÇÃO\n${label}: ${id}\nNome do Fornecedor: Pessoa de Teste\nCONTATOS\nCPF: 123.456.789-09\nEmitido em: 08/10/2026 às 14:21:09`;
test('CPF preserves leading zeroes, validates both digits and rejects repeated/malformed values',()=>{
 assert.equal(normalizeCpf('012.345.678-90'),cpf);assert.equal(formatCpf(cpf),'012.345.678-90');assert.ok(isValidCpf(cpf));
 for(const value of ['11111111111','00000000000','01234567891','01234567990',1234567890,'CPF 01234567890','012x34567890'])assert.equal(isValidCpf(value),false);
});
test('CPF scan retains sources, requires labels for compact numbers and does not slice CNPJs/invoice keys',()=>{
 const text='CPF: 01234567890; CPF: 123.456.789-09; CNPJ: 12.345.678/0001-95; 01234567890; 00123456789099999999999';
 const found=extractTaxIds(text);assert.deepEqual(found.map(x=>x.type),['CPF','CPF','CNPJ']);assert.equal(found[0].cnpj,cpf);assert.equal(text.slice(found[0].start,found[0].end),cpf);
 assert.equal(extractCpfs('X01234567890 CPF: 11111111111').length,0);
});
test('CPF CRC must match identification block, document type and emission date',()=>{
 const result=inspectCrcText(cert(),cpf);assert.equal(result.isCrc,true);assert.equal(result.cnpj,cpf);assert.equal(result.supplierName,'Pessoa de Teste');
 assert.equal(inspectCrcText(cert('123.456.789-09'),cpf).isCrc,false);
 assert.equal(inspectCrcText(cert('012.345.678-91'),cpf).isCrc,false);
 assert.equal(inspectCrcText(cert(cpf),cpf).isCrc,true);
 assert.equal(inspectCrcText(cert(cpf,'CPF/CNPJ'),cpf).isCrc,true);
 assert.equal(inspectCrcText(cert('012.345.678-90','CNPJ'),cpf).isCrc,false);
 assert.equal(inspectCrcText(cert().replace('CPF: 012.345.678-90','CPF: [oculto]'),cpf).isCrc,false);
 assert.equal(buildCrcFileName(cpf,result.emittedAt).includes(cpf),true);
});
test('CPF PDF extraction tolerates glyph whitespace and unicode separators',()=>{
 const text='CPF: 0 1 2 . 3 4 5 . 6 7 8 – 9 0';
 const found=extractCpfs(text);assert.equal(found.length,1);assert.equal(found[0].cpf,cpf);assert.equal(text.slice(found[0].start,found[0].end),'0 1 2 . 3 4 5 . 6 7 8 – 9 0');
});
