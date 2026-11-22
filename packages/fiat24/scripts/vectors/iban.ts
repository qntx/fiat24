import { readFileSync } from "node:fs";

import type { VectorSource } from "./lib.ts";

type RawResponse = { id: string; source: string; body: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ibanFromBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const iban = isRecord(parsed) ? parsed["iban"] : undefined;
    return typeof iban === "string" ? iban : undefined;
  } catch {
    return undefined;
  }
}

// Ids the SDK resolves into an IBAN (SPEC §5.3: 1 <= id <= 99999999999) and
// ids it refuses (0 = empty account field; >= 10^11 collides with the Mantle
// namespace the API answers for).
const SUCCESS_IDS = new Set(["1", "12345", "9102", "123456", "350000", "99999999999"]);
const REFUSAL_IDS = new Set(["0", "100000000000", "999999999999"]);

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const raw: unknown = JSON.parse(readFileSync(new URL("raw/iban.json", import.meta.url), "utf8"));
  const responses = isRecord(raw) ? raw["responses"] : undefined;
  if (!Array.isArray(responses)) {
    throw new TypeError("raw/iban.json: expected a responses array");
  }
  const recorded = new Map<string, RawResponse>();
  for (const response of responses) {
    if (
      !isRecord(response) ||
      typeof response["id"] !== "string" ||
      typeof response["body"] !== "string"
    ) {
      throw new Error("raw/iban.json: each response needs id/body strings");
    }
    recorded.set(response["id"], response as RawResponse);
  }

  const cases: unknown[] = [];
  const successIbans: string[] = [];
  for (const id of SUCCESS_IDS) {
    const response = recorded.get(id);
    if (response === undefined) {
      throw new Error(`raw/iban.json: no recording for id ${id}`);
    }
    const iban = ibanFromBody(response.body);
    if (iban === undefined) {
      throw new Error(`raw/iban.json: id ${id} recording carries no iban`);
    }
    successIbans.push(iban);
    cases.push({ op: "ibanOf", id, output: iban });
  }
  for (const id of REFUSAL_IDS) {
    const response = recorded.get(id);
    if (response === undefined) {
      throw new Error(`raw/iban.json: no recording for id ${id}`);
    }
    cases.push({ op: "ibanOf", id, error: "invalid-account-id", recorded: response.body });
  }

  for (const iban of successIbans) {
    cases.push({ op: "isValidIban", input: iban, output: true });
  }
  // Spec-derived cases (SPEC §5.3): a one-digit change in a recorded IBAN
  // breaks mod-97, a truncated one breaks the per-country length rule, and
  // lowercase with grouping spaces still validates (the check uppercases and
  // strips non-alphanumerics).
  const [first] = successIbans;
  if (first === undefined) {
    throw new Error("raw/iban.json: no success IBANs");
  }
  const lastDigit = (first.codePointAt(first.length - 1) ?? 48) - 48;
  const mutated = `${first.slice(0, -1)}${(lastDigit + 1) % 10}`;
  cases.push(
    { op: "isValidIban", input: mutated, output: false },
    { op: "isValidIban", input: first.slice(0, -1), output: false },
    {
      op: "isValidIban",
      input: first
        .toLowerCase()
        .replaceAll(/(.{4})/g, "$1 ")
        .trim(),
      output: true,
    },
  );

  return {
    capability: "core.iban",
    source: {
      kind: "recorded",
      url: "https://api.fiat24.com/iban/{id} (header network: 42161)",
      date: "2026-11-22",
      evidence: "packages/fiat24/scripts/vectors/raw/iban.json",
    },
    cases,
  };
}
