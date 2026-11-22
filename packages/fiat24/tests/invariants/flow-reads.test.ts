/**
 * R-05 — structural invariant: every chain read inside `src/flows` goes through `verifiedBlock`,
 * the single helper that asserts the deployment of the contracts read at that block first.
 * Text-based scan (there is no TS compiler API in the toolchain):
 *
 * 1. `snapshot(` and `assertDeployment(` appear only inside `verifiedBlock` in guards.ts (exactly once
 *    each) — except `snapshot(` in tx.ts, whose nonce-only probes read no contract state.
 * 2. Every name imported from `../chain/*` is classified PURE (no contract-state read) or READS
 *    (delegated read); an unclassified import fails — new reads must be classified.
 * 3. Every call of a READS name, and of the guards.ts read helpers
 *    (`senderLive|legAllowed|deskOwner|supplyBound`), receives `at` — the branded `VerifiedBlock` —
 *    in its argument text.
 * 4. Every declaration of the identifier `at` is `at: VerifiedBlock` or `const at = await
 *    verifiedBlock(`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { codeOnly } from "../helpers.ts";

const FLOWS = fileURLToPath(new URL("../../src/flows", import.meta.url));

const FILES = readdirSync(FLOWS)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(FLOWS, name));

const TEXTS = new Map(FILES.map((path) => [path, readFileSync(path, "utf8")]));

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** I/O-free or log-only helpers; `snapshot`/`assertDeployment` are pinned by rule 1. */
const PURE = new Set([
  "addressTopic",
  "asAddress",
  "asBigint",
  "asBoolean",
  "assertDeployment",
  "checkedAddress",
  "contractTarget",
  "errorChain",
  "getLogsChunked",
  "invalidResponse",
  "mapViemError",
  "remapRevert",
  "resolveDeployment",
  "revertError",
  "snapshot",
  "topic0Of",
]);

/** Imported types — `import type` performs no read at all. */
const TYPES = new Set([
  "Allowances",
  "Availability",
  "ExchangeQuote",
  "Fiat24Account",
  "LogFilter",
  "MintQuote",
  "PayoutSettlement",
  "TopUpQuote",
]);

/** Delegated contract-state reads: every call must see the verified block. */
const READS = new Set([
  "checkTransfer",
  "getAccount",
  "getAllowance",
  "getAllowances",
  "getAvailability",
  "getBalances",
  "getExchangeQuote",
  "getMintQuote",
  "getPayoutMinimum",
  "getPayoutSettlement",
  "getTopUpQuote",
  "readAt",
  "simulateCall",
]);

/** Guards.ts read helpers — same rule as READS even though they live in flows. */
const GUARD_HELPERS = new Set(["deskOwner", "legAllowed", "senderLive", "supplyBound"]);

/** Import specifiers, both `import` and `import type`, from `../chain/*`. */
function chainImports(text: string): string[] {
  const names: string[] = [];
  const pattern = /import(?:\s+type)?\s*\{([^}]*)\}\s*from\s*"\.\.\/chain\/[^"]+";/g;
  for (const match of text.matchAll(pattern)) {
    const [, body] = match;
    if (body === undefined) {
      continue;
    }
    for (const raw of body.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

/** The balanced-paren argument text following the `(` at `openParen`, or undefined. */
function callArgs(text: string, openParen: number): string | undefined {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openParen + 1, i);
      }
    }
  }
  return undefined;
}

/**
 * Call sites of `name` (word-bounded): a `name(` not preceded by `function` (declarations) or `.`
 * (member access).
 */
function callSites(source: string, name: string): number[] {
  const text = codeOnly(source);
  const sites: number[] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const before = text.slice(0, start);
    if (!/function\s*$/.test(before) && !/\.\s*$/.test(before)) {
      sites.push(start + match[0].length - 1);
    }
  }
  return sites;
}

/** Rule 1: per-file `snapshot(`/`assertDeployment(` counts as offender lines. */
function placementOffenders(): string[] {
  const offenders: string[] = [];
  for (const [path, text] of TEXTS) {
    const file = fileName(path);
    const snapshots = text.split("snapshot(").length - 1;
    const asserts = text.split("assertDeployment(").length - 1;
    if (file === "guards.ts" && (snapshots !== 1 || asserts !== 1)) {
      offenders.push(`${file}: snapshot=${snapshots} assertDeployment=${asserts}`);
    }
    if (file === "tx.ts" && asserts !== 0) {
      offenders.push(`${file}: assertDeployment=${asserts}`);
    }
    if (file !== "guards.ts" && file !== "tx.ts" && (snapshots !== 0 || asserts !== 0)) {
      offenders.push(`${file}: snapshot=${snapshots} assertDeployment=${asserts}`);
    }
  }
  const guards = TEXTS.get(join(FLOWS, "guards.ts")) ?? "";
  const body = guards.slice(guards.indexOf("export async function verifiedBlock"));
  const snap = body.indexOf("snapshot(");
  const assert = body.indexOf("assertDeployment(");
  if (snap === -1 || assert === -1 || snap > assert) {
    offenders.push("guards.ts: verifiedBlock does not snapshot then assert");
  }
  return offenders;
}

/** Rule 2: `../chain/*` imports outside the PURE/TYPES/READS classifications. */
function unclassifiedImports(): string[] {
  const offenders: string[] = [];
  for (const [path, text] of TEXTS) {
    for (const name of chainImports(text)) {
      if (!PURE.has(name) && !READS.has(name) && !TYPES.has(name)) {
        offenders.push(`${fileName(path)}: ${name}`);
      }
    }
  }
  return offenders;
}

/** Rule 3: calls of READS/guard-helper names whose argument text never mentions `at`. */
function unverifiedReads(): string[] {
  const offenders: string[] = [];
  for (const [path, text] of TEXTS) {
    const stripped = codeOnly(text);
    for (const name of [...READS, ...GUARD_HELPERS]) {
      for (const openParen of callSites(text, name)) {
        const args = callArgs(stripped, openParen) ?? "";
        if (!/\bat\b/.test(args)) {
          offenders.push(`${fileName(path)}: ${name}(${args.slice(0, 60)}…)`);
        }
      }
    }
  }
  return offenders;
}

/** Rule 4: `at` declarations that are neither `at: VerifiedBlock` nor `= await verifiedBlock(`. */
function strayAtDeclarations(): string[] {
  const offenders: string[] = [];
  for (const [path, text] of TEXTS) {
    for (const match of text.matchAll(/\bat\s*:/g)) {
      const after = text.slice(match.index);
      if (!/^at\s*:\s*VerifiedBlock\b/.test(after)) {
        offenders.push(`${fileName(path)}: ${after.slice(0, 50)}`);
      }
    }
    for (const match of text.matchAll(/\b(?:const|let|var)\s+at\b/g)) {
      const after = text.slice(match.index);
      if (!/^(?:const|let|var)\s+at\s*=\s*await\s+verifiedBlock\(/.test(after)) {
        offenders.push(`${fileName(path)}: ${after.slice(0, 50)}`);
      }
    }
    // An unannotated `(at) =>` parameter is a declaration without the brand.
    for (const match of text.matchAll(/\(at\)\s*=>/g)) {
      offenders.push(`${fileName(path)}: (at) => at index ${match.index}`);
    }
  }
  return offenders;
}

describe("flow reads go through verifiedBlock (R-05)", () => {
  test("snapshot and assertDeployment live only inside verifiedBlock", () => {
    expect(placementOffenders()).toStrictEqual([]);
  });

  test("every chain import is classified pure or reads", () => {
    expect(unclassifiedImports()).toStrictEqual([]);
  });

  test("every delegated read receives the verified block", () => {
    expect(unverifiedReads()).toStrictEqual([]);
  });

  test("every `at` declaration is VerifiedBlock or produced by verifiedBlock", () => {
    expect(strayAtDeclarations()).toStrictEqual([]);
  });
});
