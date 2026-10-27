import assert from "node:assert/strict";
import test from "node:test";
import {
  base64ToBytes,
  bytesToBase64,
  readPdf,
  inspectCrcText,
  buildCrcFileName,
} from "../lib/pdf.js";

const NUMERIC = "12345678000195";
const OTHER = "00000000000191";
const ALPHANUMERIC = "12ABC34501DE35";
const TITLE = "CERTIFICADO DE REGISTRO CADASTRAL DO FORNECEDOR - CRC - Lei 14.133/21";
const FOOTER = "www.cagef.mg.gov.br/fornecedor-web Emitido em: 08/10/2026 às 14:21:09 Versão 1.0";

function certificate({ title = TITLE, identity, footer = FOOTER, extra = "" } = {}) {
  return [
    "ESTADO DE MINAS GERAIS",
    title,
    "SITUAÇÃO: Ativo VALIDADE: 29/09/2027",
    identity ?? "IDENTIFICAÇÃO\nInscrito no cadastro\nCNPJ 12.345.678/0001-95\nNome Empresarial Empresa de Teste Ltda.\nNome Fantasia Exemplo\nNatureza Jurídica Sociedade Limitada\nContatos",
    extra,
    footer,
  ].join("\n");
}

test("base64 helpers preserve all byte values, chunk boundaries and subarray limits", () => {
  const data = Uint8Array.from({ length: 50_003 }, (_, index) => index % 256);
  const before = new Uint8Array(data);
  const encoded = bytesToBase64(data);
  assert.deepEqual(base64ToBytes(encoded), before);
  assert.deepEqual(data, before);
  assert.equal(bytesToBase64(new Uint8Array()), "");
  assert.deepEqual(base64ToBytes(""), new Uint8Array());
  assert.equal(bytesToBase64(Uint8Array.of(255, 65, 66, 254).subarray(1, 3)), "QUI=");
  assert.deepEqual(base64ToBytes(" Q U I=\n"), Uint8Array.of(65, 66));
});

test("base64 decoder rejects URLs and malformed values", () => {
  for (const value of [null, 1234, "A", "%%", "AA=A", "A===", "https://example.com/a.pdf", "data:application/pdf;base64,QUI="]) {
    assert.throws(() => base64ToBytes(value), TypeError, String(value));
  }
  assert.throws(() => bytesToBase64([1, 2, 3]), TypeError);
});

test("PDF reader validates abort and inputs before loading its worker", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPdf("", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(readPdf(Uint8Array.of(1, 2, 3)), /assinatura de PDF/);
  await assert.rejects(readPdf(new Uint8Array(), { maxPages: 0 }), /inteiro positivo/);
  await assert.rejects(readPdf(new Uint8Array(), { maxPages: 1.5 }), /inteiro positivo/);
  await assert.rejects(readPdf(new ArrayBuffer(10)), /base64 ou como Uint8Array/);
});

test("CRC metadata comes from the identification field and the explicit emission footer", () => {
  const result = inspectCrcText(certificate(), NUMERIC);
  assert.equal(result.isCrc, true);
  assert.equal(result.titleValid, true);
  assert.equal(result.identityValid, true);
  assert.equal(result.emissionFound, true);
  assert.equal(result.emissionValid, true);
  assert.equal(result.cnpj, NUMERIC);
  assert.equal(result.supplierName, "Empresa de Teste Ltda.");
  assert.equal(result.emittedAt, "2026-10-08T14:21:09-03:00");
  assert.equal(result.documentDate, "08/10/2026");
  assert.equal(result.emittedAtText, "08/10/2026 14:21:09");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.issueCodes, []);
});

test("CRC metadata accepts alphanumeric CNPJ, PDF spacing and an accented supplier name", () => {
  const text = certificate({
    identity: "IDENTIFICAÇÃO\nCNPJ:\n12 . ABC . 345 / 01DE - 35\nRazão Social: Comércio de Teste\nLimitada\nNome Fantasia: Exemplo\nContatos",
    footer: "Emitido em:\n08 / 10 / 2026 às\n00 : 02 : 03",
  });
  const result = inspectCrcText(text, ALPHANUMERIC.toLowerCase());
  assert.equal(result.isCrc, true);
  assert.equal(result.cnpj, ALPHANUMERIC);
  assert.equal(result.supplierName, "Comércio de Teste Limitada");
  assert.equal(result.emittedAt, "2026-10-08T00:02:03-03:00");
});

test("the short CRC title is accepted but generic mentions are insufficient", () => {
  assert.equal(inspectCrcText(certificate({ title: "Certificado de Registro Cadastral - CRC" }), NUMERIC).titleValid, true);
  for (const title of ["CRC", "Consulta do fornecedor", "Certificado de Registro Cadastral", "Certidão de Regularidade Fiscal", "Certificado de Registro Cadastral do Fornecedorz"]) {
    const result = inspectCrcText(certificate({ title }), NUMERIC);
    assert.equal(result.isCrc, false);
    assert.equal(result.titleValid, false);
    assert.ok(result.issueCodes.includes("CRC_TITLE_MISSING"));
  }
});

test("ordinary supplier-name words are not mistaken for section headings", () => {
  const text = certificate({ identity: "IDENTIFICAÇÃO\nCNPJ 12.345.678/0001-95\nNome Empresarial Representante Comercial de Contatos Ltda.\nNome Fantasia Exemplo\nContatos" });
  const result = inspectCrcText(text, NUMERIC);
  assert.equal(result.isCrc, true);
  assert.equal(result.supplierName, "Representante Comercial de Contatos Ltda.");
});

test("a data report is blocked even when it refers to the certificate title", () => {
  const result = inspectCrcText(certificate({ title: `RELATÓRIO DE DADOS DO FORNECEDOR\nDocumento mencionado: ${TITLE}` }), NUMERIC);
  assert.equal(result.isCrc, false);
  assert.equal(result.titleValid, false);
  assert.ok(result.issueCodes.includes("DATA_REPORT_NOT_CRC"));
});

test("a CNPJ mentioned elsewhere cannot stand in for the main supplier field", () => {
  for (const identity of [
    "IDENTIFICAÇÃO\nNome Empresarial Empresa de Teste\nContatos\nCNPJ: 12.345.678/0001-95",
    "IDENTIFICAÇÃO\nCNPJ filial vinculada 12.345.678/0001-95",
    "CNPJ: 12.345.678/0001-95\nDados diversos",
    "IDENTIFICAÇÃO\nCNPJ 12.345.678/0001-94\nOutra menção: CNPJ 12.345.678/0001-95",
  ]) {
    const result = inspectCrcText(certificate({ identity }), NUMERIC);
    assert.equal(result.identityValid, false, identity);
    assert.equal(result.isCrc, false, identity);
    assert.equal(result.cnpj, "", identity);
  }
});

test("a different main CNPJ blocks the certificate even if the selected one appears elsewhere", () => {
  const result = inspectCrcText(certificate({ extra: `REGULARIDADE\nRepresentante: CNPJ ${OTHER}` }), OTHER);
  assert.equal(result.cnpj, NUMERIC);
  assert.equal(result.identityValid, false);
  assert.equal(result.isCrc, false);
  assert.ok(result.issueCodes.includes("CNPJ_MISMATCH"));
  const badInput = inspectCrcText(certificate(), "12345678000194");
  assert.equal(badInput.identityValid, false);
  assert.ok(badInput.issueCodes.includes("EXPECTED_CNPJ_INVALID"));
});

test("validity and expiration dates never substitute for emission", () => {
  const result = inspectCrcText(certificate({ footer: "Vencimento: 08/10/2026 às 14:21:09\nValidade: 29/09/2027" }), NUMERIC);
  assert.equal(result.titleValid, true);
  assert.equal(result.identityValid, true);
  assert.equal(result.isCrc, false);
  assert.equal(result.emissionFound, false);
  assert.equal(result.emissionValid, false);
  assert.equal(result.emittedAt, "");
  assert.equal(result.documentDate, "");
  assert.ok(result.issueCodes.includes("EMISSION_MISSING"));
});

test("impossible calendars, truncated timestamps and invalid times are detected rather than normalized", () => {
  for (const footer of [
    "Emitido em: 31/02/2026 às 14:21:09",
    "Emitido em: 29/02/2025 às 14:21:09",
    "Emitido em: 31/04/2026 às 14:21:09",
    "Emitido em: 00/10/2026 às 14:21:09",
    "Emitido em: 08/13/2026 às 14:21:09",
    "Emitido em: 08/10/0000 às 14:21:09",
    "Emitido em: 08/10/2026 às 24:00:00",
    "Emitido em: 08/10/2026 às 14:60:09",
    "Emitido em: 08/10/2026 às 14:21:60",
    "Emitido em: 08/10/2026 às 14:21:099",
    "Emitido em: 08/10/2026",
    "Emitido em 08/10/2026 às 14:21:09",
    "Emitido em: texto não extraído",
  ]) {
    const result = inspectCrcText(certificate({ footer }), NUMERIC);
    assert.equal(result.emissionFound, true, footer);
    assert.equal(result.emissionValid, false, footer);
    assert.equal(result.emittedAt, "", footer);
    assert.ok(result.issueCodes.includes("EMISSION_INVALID"), footer);
    assert.equal(result.isCrc, false, footer);
  }
});

test("leap days validate using Gregorian calendar rules", () => {
  for (const year of [2000, 2024]) {
    assert.equal(inspectCrcText(certificate({ footer: `Emitido em: 29/02/${year} às 12:00:00` }), NUMERIC).emissionValid, true);
  }
  assert.equal(inspectCrcText(certificate({ footer: "Emitido em: 29/02/2100 às 12:00:00" }), NUMERIC).emissionValid, false);
});

test("repeated page footers agree, while conflicting or partly invalid footers block emission", () => {
  assert.equal(inspectCrcText(certificate({ footer: `${FOOTER}\nPágina 2\n${FOOTER}` }), NUMERIC).isCrc, true);
  const conflicting = inspectCrcText(certificate({ footer: `${FOOTER}\nEmitido em: 08/10/2026 às 14:21:10` }), NUMERIC);
  assert.equal(conflicting.emissionFound, true);
  assert.equal(conflicting.emissionValid, false);
  assert.ok(conflicting.issueCodes.includes("EMISSION_AMBIGUOUS"));
  const partiallyInvalid = inspectCrcText(certificate({ footer: `${FOOTER}\nEmitido em: 31/02/2026 às 14:21:09` }), NUMERIC);
  assert.equal(partiallyInvalid.emissionValid, false);
  assert.ok(partiallyInvalid.issueCodes.includes("EMISSION_INVALID"));
});

test("an unreadable document has no inferred certificate metadata", () => {
  for (const text of ["", null, 123]) {
    const result = inspectCrcText(text, NUMERIC);
    assert.equal(result.isCrc, false);
    assert.equal(result.titleValid, false);
    assert.equal(result.identityValid, false);
    assert.equal(result.emissionFound, false);
    assert.equal(result.supplierName, "");
  }
});

test("certificate filenames use the validated identity and printed Brasília instant", () => {
  assert.equal(buildCrcFileName(NUMERIC, "2026-10-08T14:21:09-03:00"), "CRC_12345678000195_2026-10-08_14-21-09.pdf");
  assert.equal(buildCrcFileName("12.abc.345/01de-35", "2026-10-08T00:02:03-03:00"), "CRC_12ABC34501DE35_2026-10-08_00-02-03.pdf");
  assert.throws(() => buildCrcFileName("../../file", "2026-10-08T14:21:09-03:00"), TypeError);
  assert.throws(() => buildCrcFileName(NUMERIC, "2026-02-31T14:21:09-03:00"), TypeError);
  assert.throws(() => buildCrcFileName(NUMERIC, "2026-10-08T14:21:09Z"), TypeError);
  assert.throws(() => buildCrcFileName(NUMERIC, ""), TypeError);
});
