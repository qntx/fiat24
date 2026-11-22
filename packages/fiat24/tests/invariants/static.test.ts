import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { codeOnly, sendTransactionAllowed } from "../helpers.ts";

// I1/I14: the SDK never holds keys, never signs, never broadcasts. Scan the
// published surface for the viem signing/broadcast surface it must not touch.
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...srcFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

const FILES = srcFiles(SRC);
const TEXTS = new Map(FILES.map((path) => [path, readFileSync(path, "utf8")]));

const CODE = new Map(FILES.map((path) => [path, codeOnly(TEXTS.get(path) ?? "")]));

/** Files whose code (comments stripped) matches any pattern, as offender lines. */
function patternOffenders(patterns: RegExp[]): string[] {
  return FILES.flatMap((path) =>
    patterns.filter((re) => re.test(CODE.get(path) ?? "")).map((re) => `${path}: ${re.source}`),
  );
}

const SIGNING_IDENTIFIERS = [
  "signMessage",
  "signTypedData",
  "signTransaction",
  "privateKeyToAccount",
  "mnemonicToAccount",
  "hdKeyToAccount",
  "signAuthorization",
];

const BROADCAST_IDENTIFIERS = ["sendRawTransaction", "writeContract", "deployContract"];

// RPC method strings, not only viem action names: a `client.request({method})` bypass must
// trip the same scans. Word-bounded so `eth_sign` never matches inside `eth_signTypedData*`
// or `eth_sendTransaction` inside `eth_sendRawTransaction`.
const SIGNING_PATTERNS = [
  ...SIGNING_IDENTIFIERS.map((id) => new RegExp(`\\b${id}\\b`)),
  /\bpersonal_sign\b/,
  /\beth_sign\b/,
  /\beth_signTypedData\w*/,
];

const BROADCAST_PATTERNS = [
  ...BROADCAST_IDENTIFIERS.map((id) => new RegExp(`\\b${id}\\b`)),
  /\beth_sendRawTransaction\b/,
  /\beth_sendTransaction\b/,
];

describe("src static invariants", () => {
  test("scan found source files", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  test("no import from viem/accounts", () => {
    for (const [path, text] of TEXTS) {
      expect(text, `${path} imports viem/accounts`).not.toContain("viem/accounts");
    }
  });

  test("no signing imports", () => {
    expect(patternOffenders(SIGNING_PATTERNS)).toStrictEqual([]);
  });

  test("no broadcast", () => {
    expect(patternOffenders(BROADCAST_PATTERNS)).toStrictEqual([]);
  });

  test("sendTransaction appears only in core/signer.ts or as an access on a `signer` value", () => {
    for (const [path, text] of TEXTS) {
      for (const match of text.matchAll(/\bsendTransaction\b/g)) {
        const { index } = match;
        const before = text.slice(Math.max(0, index - 40), index);
        expect(sendTransactionAllowed(path, before), `${path}: stray sendTransaction`).toBe(true);
      }
    }
  });
});
