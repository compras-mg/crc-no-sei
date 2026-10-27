import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCnpj,
  isValidCnpj,
  formatCnpj,
  extractCnpjs,
  formatBrazilDate,
  formatBrazilDateTime,
} from "../lib/core.js";

const NUMERIC = "12345678000195";
const NUMERIC_FORMATTED = "12.345.678/0001-95";
const ALPHANUMERIC = "12ABC34501DE35";
const ALPHANUMERIC_FORMATTED = "12.ABC.345/01DE-35";

test("normalization preserves leading zeroes and uppercases alphanumeric CNPJs", () => {
  assert.equal(normalizeCnpj(" 00.000.000/0001-91 "), "00000000000191");
  assert.equal(normalizeCnpj("12.abc.345/01de-35"), ALPHANUMERIC);
  assert.equal(normalizeCnpj(ALPHANUMERIC.toLowerCase()), ALPHANUMERIC);
  assert.equal(normalizeCnpj(NUMERIC), NUMERIC);
});

test("normalization recognizes PDF whitespace while retaining a strict shape", () => {
  assert.equal(normalizeCnpj("12 .\nABC . 345 /\n01DE – 35"), ALPHANUMERIC);
  assert.equal(normalizeCnpj("1 2 . A B C . 3 4 5 / 0 1 D E - 3 5"), ALPHANUMERIC);
  assert.equal(normalizeCnpj("12\u00a0ABC 345\n01DE\u202f35"), ALPHANUMERIC);
  assert.equal(normalizeCnpj("12.\u200BABC.345/01DE-35"), ALPHANUMERIC);
  assert.equal(normalizeCnpj("12 345 678 0001 95"), NUMERIC);
});

test("normalization never turns prose or malformed tokens into a CNPJ", () => {
  for (const value of [
    `Fornecedor inscrito no CNPJ ${NUMERIC_FORMATTED}`,
    `${NUMERIC_FORMATTED} (filial)`,
    `CNPJ:${NUMERIC}`,
    `prefix${NUMERIC}`,
    `0${NUMERIC}`,
    `${NUMERIC}0`,
    "12:345:678/0001-95",
    "12.345.678/0001-AA",
    "Á2.ABC.345/01DE-35",
    "ßABC34501DE35",
    "ABCD EFGH IJKL35",
    12345678000195,
    null,
    undefined,
    {},
    "",
  ]) {
    assert.equal(normalizeCnpj(value), "", `must reject ${String(value)}`);
  }
});

test("numeric check digits and the official alphanumeric example validate", () => {
  for (const value of [
    NUMERIC,
    NUMERIC_FORMATTED,
    "04.252.011/0001-10",
    "11.222.333/0001-81",
    "00.000.000/0001-91",
    ALPHANUMERIC,
    ALPHANUMERIC_FORMATTED,
    "12.abc.345/01de-35",
  ]) {
    assert.equal(isValidCnpj(value), true, value);
  }
});

test("validation checks both digits and rejects repeated digits", () => {
  for (const value of [
    "12345678000194",
    "12345678000185",
    "12ABC34501DE34",
    "12ABC34501DE25",
    "12.ABC.345/01DF-35",
    "12.ABC.345/01DE-3A",
    `CNPJ ${NUMERIC_FORMATTED}`,
    ...Array.from({ length: 10 }, (_, digit) => String(digit).repeat(14)),
  ]) {
    assert.equal(isValidCnpj(value), false, value);
  }
});

test("formatting handles both formats and leaves check-digit validation separate", () => {
  assert.equal(formatCnpj(NUMERIC), NUMERIC_FORMATTED);
  assert.equal(formatCnpj(ALPHANUMERIC), ALPHANUMERIC_FORMATTED);
  assert.equal(formatCnpj("00000000000191"), "00.000.000/0001-91");
  assert.equal(formatCnpj("12ABC34501DE00"), "12.ABC.345/01DE-00");
  assert.equal(isValidCnpj("12ABC34501DE00"), false);
  assert.equal(formatCnpj("uma empresa 12345678000195"), "");
});

test("extraction preserves each occurrence, exact offsets, order and evidence", () => {
  const text = `Fornecedor A: ${NUMERIC_FORMATTED}.\nFornecedor B: ${ALPHANUMERIC_FORMATTED}.\n` +
    `Repetido: ${NUMERIC}.`;
  const results = extractCnpjs(text);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((item) => item.cnpj), [NUMERIC, ALPHANUMERIC, NUMERIC]);
  assert.deepEqual(results.map((item) => text.slice(item.start, item.end)), [
    NUMERIC_FORMATTED,
    ALPHANUMERIC_FORMATTED,
    NUMERIC,
  ]);
  assert.equal(results[0].formatted, NUMERIC_FORMATTED);
  assert.match(results[0].context, /Fornecedor A/);
  assert.ok(results.every((item) => !item.context.includes("\n")));
});

test("extraction ignores invalid check digits and nonexistent inputs", () => {
  assert.deepEqual(extractCnpjs("CNPJ 12.345.678/0001-94 e 00.000.000/0000-00"), []);
  assert.deepEqual(extractCnpjs(null), []);
  assert.deepEqual(extractCnpjs(12345678000195), []);
  assert.deepEqual(extractCnpjs(""), []);
});

test("extraction cannot take a CNPJ out of a longer token or a 44-digit invoice key", () => {
  const invoiceKey = "3".repeat(15) + NUMERIC + "7".repeat(15);
  assert.equal(invoiceKey.length, 44);
  for (const text of [
    invoiceKey,
    `CNPJ: X${NUMERIC}`,
    `CNPJ: ${NUMERIC}X`,
    `CNPJ: _${NUMERIC}`,
    `CNPJ: ${NUMERIC}_`,
    `CNPJ: é${NUMERIC}`,
    `CNPJ: ${NUMERIC}漢`,
    `CNPJ: X${ALPHANUMERIC}`,
    `CNPJ: ${ALPHANUMERIC}00`,
    `CNPJ: x${NUMERIC_FORMATTED}`,
    `CNPJ: ${NUMERIC_FORMATTED}y`,
  ]) {
    assert.deepEqual(extractCnpjs(text), [], text);
  }
});

test("compact alphanumeric values require a nearby CNPJ label", () => {
  for (const text of [
    `hash: ${ALPHANUMERIC}`,
    `identificador ${ALPHANUMERIC.toLowerCase()}`,
    `CNPJ ${".".repeat(70)} ${ALPHANUMERIC}`,
    `CNPJ: campo anterior\n\nhash ${ALPHANUMERIC}`,
  ]) {
    assert.deepEqual(extractCnpjs(text), [], text);
  }
  for (const text of [
    `CNPJ: ${ALPHANUMERIC}`,
    `cnpj\n${ALPHANUMERIC.toLowerCase()}`,
    `Inscrita no C.N.P.J. sob o nº ${ALPHANUMERIC}`,
    `${ALPHANUMERIC} (CNPJ)`,
    `Documento ${ALPHANUMERIC_FORMATTED}`,
  ]) {
    assert.equal(extractCnpjs(text)[0]?.cnpj, ALPHANUMERIC, text);
  }
});

test("PDF extraction tolerates spaces and breaks around punctuation and glyphs", () => {
  const text = "Fornecedor: 1 2 .\n A B C . 3 4 5 / 0 1 D E − 3 5;\n" +
    "CNPJ: 12 345 678 0001 95.";
  assert.deepEqual(extractCnpjs(text).map((item) => item.cnpj), [ALPHANUMERIC, NUMERIC]);
  assert.deepEqual(extractCnpjs("Números de tabela: 12 345 678 0001 95"), []);
});

test("date helpers use São Paulo's date even across a UTC date boundary", () => {
  const instant = new Date("2026-10-08T01:15:09Z");
  assert.equal(formatBrazilDate(instant), "07/10/2026");
  assert.equal(formatBrazilDateTime(instant), "07/10/2026 22:15:09");
  assert.equal(formatBrazilDateTime("2026-10-08T03:00:00Z"), "08/10/2026 00:00:00");
  assert.equal(formatBrazilDateTime(Date.UTC(2026, 0, 2, 6, 4, 5)), "02/01/2026 03:04:05");
});

test("invalid dates fail safely without an invented timestamp", () => {
  for (const value of [new Date(NaN), "not a date", null, {}, false, Infinity]) {
    assert.equal(formatBrazilDate(value), "");
    assert.equal(formatBrazilDateTime(value), "");
  }
});
