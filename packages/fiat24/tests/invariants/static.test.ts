import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { sendTransactionAllowed } from "../helpers.ts";

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

describe("src static invariants", () => {
  test("scan found source files", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  test("no import from viem/accounts", () => {
    for (const [path, text] of TEXTS) {
      expect(text, `${path} imports viem/accounts`).not.toContain("viem/accounts");
    }
  });

  test.each(SIGNING_IDENTIFIERS)("no signing identifier %s", (identifier) => {
    for (const [path, text] of TEXTS) {
      // word-boundary match so `Fiat24SessionSigner.signMessage`-shaped member
      // declarations are still caught unless they match the explicit allow-list.
      const re = new RegExp(`\\b${identifier}\\b`);
      expect(re.test(text), `${path} mentions ${identifier}`).toBe(false);
    }
  });

  test.each(BROADCAST_IDENTIFIERS)("no broadcast identifier %s", (identifier) => {
    for (const [path, text] of TEXTS) {
      const re = new RegExp(`\\b${identifier}\\b`);
      expect(re.test(text), `${path} mentions ${identifier}`).toBe(false);
    }
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
