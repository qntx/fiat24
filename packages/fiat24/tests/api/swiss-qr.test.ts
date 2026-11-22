import { describe, expect, test } from "vite-plus/test";

import { parseSwissQr } from "../../src/api/index.ts";
import { expectError } from "../helpers.ts";
import { DOC_QR } from "./stub.ts";

function mutate(qr: string, from: string, to: string): string {
  expect(qr).toContain(from);
  return qr.replace(from, to);
}

describe("parseSwissQr", () => {
  test("doc example parses to the bound fields", () => {
    expect(parseSwissQr(DOC_QR)).toStrictEqual({
      account: "LI7830174502999200012",
      amount: 194975n,
      currency: "CHF",
    });
  });

  test("LF separators are accepted", () => {
    const qr = DOC_QR.replaceAll("\r\n", "\n");
    expect(parseSwissQr(qr)).toStrictEqual({
      account: "LI7830174502999200012",
      amount: 194975n,
      currency: "CHF",
    });
  });

  test.each([
    ["first line not SPC", mutate(DOC_QR, "SPC", "BCD")],
    ["version 0100", mutate(DOC_QR, "\r\n0200\r\n", "\r\n0100\r\n")],
    ["DE IBAN", mutate(DOC_QR, "LI7830174502999200012", "DE89370400440532013000")],
    ["bad checksum", mutate(DOC_QR, "LI7830174502999200012", "LI7830174502999200013")],
    ["amount 1949.7", mutate(DOC_QR, "1949.75\r\n", "1949.7\r\n")],
    ["empty amount", mutate(DOC_QR, "1949.75\r\n", "\r\n")],
    ["amount 1'949.75", mutate(DOC_QR, "1949.75\r\n", "1'949.75\r\n")],
    ["currency USD", mutate(DOC_QR, "\r\nCHF\r\n", "\r\nUSD\r\n")],
    // Dropping one UltmtCdtr line shifts the amount to index 17 — not the strict position.
    ["amount at line 17 (six UltmtCdtr lines)", mutate(DOC_QR, "\r\n\r\n1949.75", "\r\n1949.75")],
    ["998 chars", DOC_QR + "x".repeat(998 - DOC_QR.length)],
    ["19 lines", DOC_QR.split("\r\n").slice(0, 19).join("\r\n")],
  ])("refuses: %s", (_name, qr) => {
    expect.hasAssertions();
    expectError(() => parseSwissQr(qr), "invalid-argument");
  });

  test("a 997-char payload is still accepted", () => {
    const qr = DOC_QR + "x".repeat(997 - DOC_QR.length);
    expect(qr).toHaveLength(997);
    expect(parseSwissQr(qr).amount).toBe(194975n);
  });

  test("non-string input refuses", () => {
    expect.hasAssertions();
    expectError(() => parseSwissQr(123 as unknown as string), "invalid-argument");
    expectError(() => parseSwissQr(undefined as unknown as string), "invalid-argument");
  });

  test("EUR QRs keep the EUR currency", () => {
    const qr = mutate(DOC_QR, "\r\nCHF\r\n", "\r\nEUR\r\n");
    expect(parseSwissQr(qr).currency).toBe("EUR");
  });
});
