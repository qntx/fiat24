import { readFileSync } from "node:fs";

import type { VectorSource } from "./lib.ts";

type RawCase = {
  readonly country: string;
  readonly variant: string;
  readonly iban: string;
  readonly valid: boolean;
  readonly error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawCase(value: unknown): value is RawCase {
  return (
    isRecord(value) &&
    typeof value["country"] === "string" &&
    typeof value["variant"] === "string" &&
    typeof value["iban"] === "string" &&
    typeof value["valid"] === "boolean" &&
    (value["error"] === undefined || typeof value["error"] === "string")
  );
}

// The docs' `isValidIbanNumber` check (Part 2 §10, the check the SDK implements): uppercase,
// strip non-alphanumerics, `^[A-Z]{2}[0-9]{2}[A-Z0-9]+$`, the per-country length, then the
// ISO 7064 mod-97 of the rearranged digits equals 1. Used only to flag where schwifty's
// stricter registry-grammar verdict diverges from the docs' check — never as an expected
// output (expected outputs are schwifty's verdicts).
function docCheck(input: string, lengths: Readonly<Record<string, number>>): boolean {
  const text = input.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
  const shape = /^([A-Z]{2})([0-9]{2})[A-Z0-9]+$/.exec(text);
  const country = shape?.[1];
  if (country === undefined || lengths[country] !== text.length) {
    return false;
  }
  let digits = "";
  for (const ch of text.slice(4) + text.slice(0, 4)) {
    digits += ch >= "A" && ch <= "Z" ? String((ch.codePointAt(0) ?? 0) - 55) : ch;
  }
  return BigInt(digits) % 97n === 1n;
}

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("raw/iban-registry.json", import.meta.url), "utf8"),
  );
  if (!isRecord(raw) || !isRecord(raw["lengths"]) || !Array.isArray(raw["cases"])) {
    throw new TypeError("raw/iban-registry.json: expected {lengths, cases}");
  }
  const lengths: Record<string, number> = {};
  for (const [country, length] of Object.entries(raw["lengths"])) {
    if (typeof length !== "number") {
      throw new TypeError(`raw/iban-registry.json: lengths.${country} must be a number`);
    }
    lengths[country] = length;
  }
  const out: unknown[] = [];
  for (const c of raw["cases"] as unknown[]) {
    if (!isRawCase(c)) {
      throw new TypeError("raw/iban-registry.json: malformed case");
    }
    const expected = docCheck(c.iban, lengths);
    // `output` is schwifty's verdict verbatim. `docCheck` is recorded only where the docs'
    // check disagrees with schwifty (e.g. schwifty enforces the registry BBAN structure that
    // the docs' alnum+length+mod-97 check does not implement).
    out.push({
      op: "isValidIban",
      country: c.country,
      variant: c.variant,
      input: c.iban,
      output: c.valid,
      ...(expected === c.valid ? {} : { docCheck: expected }),
    });
  }
  return {
    capability: "core.iban-registry",
    source: {
      kind: "official",
      name: "SWIFT IBAN Registry",
      version: "Release 103 (Sep 2026)",
      url: "https://www.swift.com/swift-resource/9606/download?language=en",
      evidence: "validator schwifty 2025.6.0 (raw/iban-registry.json)",
    },
    cases: out,
  };
}
