import { readFileSync } from "node:fs";

import type { VectorSource } from "./lib.ts";

type RawCase = {
  readonly country: string;
  readonly variant: string;
  readonly iban: string;
  readonly valid: boolean;
  // The docs' generic check (alnum + table length + mod-97), recomputed and recorded by
  // record-iban-registry.py — not by this generator — so the divergence flag is also recorded.
  readonly docCheck: boolean;
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
    typeof value["docCheck"] === "boolean" &&
    (value["error"] === undefined || typeof value["error"] === "string")
  );
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
  const out: unknown[] = [];
  for (const c of raw["cases"] as unknown[]) {
    if (!isRawCase(c)) {
      throw new TypeError("raw/iban-registry.json: malformed case");
    }
    // `output` is schwifty's verdict verbatim. `docCheck` is emitted only where the recorded
    // docs' check disagrees with schwifty (e.g. schwifty enforces the registry BBAN structure
    // that the docs' alnum+length+mod-97 check does not implement).
    out.push({
      op: "isValidIban",
      country: c.country,
      variant: c.variant,
      input: c.iban,
      output: c.valid,
      ...(c.docCheck === c.valid ? {} : { docCheck: c.docCheck }),
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
