import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { privateKeyToAccount } from "viem/accounts";
import { expect } from "vite-plus/test";

import { API_BASE_URL } from "../../src/api/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import type { Fiat24SessionGrant, Fiat24SessionSigner } from "../../src/core/index.ts";

export type RecordedCall = { readonly url: string; readonly init: RequestInit };

export function fixtureText(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/api/${relative}`, import.meta.url)),
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Public fixtures are the byte-frozen body itself; secured fixtures are the
// {source, doc, body|raw} envelope.
export function fixtureBody(relative: string): string {
  const text = fixtureText(relative);
  if (!relative.startsWith("secured/")) {
    return text;
  }
  const envelope: unknown = JSON.parse(text);
  if (!isRecord(envelope)) {
    throw new Error(`bad secured fixture ${relative}`);
  }
  if (typeof envelope["raw"] === "string") {
    return envelope["raw"];
  }
  return JSON.stringify(envelope["body"]);
}

export type Route = () => Response | Promise<Response>;

export function json(body: string, status = 200): Route {
  return () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * Answers `fetch(input, init)` from a `path (+query)` → Route table, recording `{url, init}` per
 * call. An unstubbed path throws — tests must route every request they expect, so a stray request
 * surfaces as `network-error`.
 */
export function stubFetch(routes: Readonly<Record<string, Route>>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const key = url.startsWith(API_BASE_URL) ? url.slice(API_BASE_URL.length) : url;
    const hit = routes[key];
    if (hit === undefined) {
      throw new Error(`unstubbed route ${key}`);
    }
    return hit();
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** Awaits `run` and returns the thrown value; fails the test when nothing is thrown. */
export async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

/** Awaits `run` and returns the thrown Fiat24Error's `code` ("non-fiat24-error" otherwise). */
export async function caughtCode(run: () => unknown): Promise<string> {
  const error = await caught(run);
  return isFiat24Error(error) ? error.code : "non-fiat24-error";
}

/** Awaits `run`, expecting a `Fiat24Error` with `code` (no `cause`, never a foreign throw). */
export async function expectCode(run: () => unknown, code: string): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (error_) {
    error = error_;
  }
  expect(isFiat24Error(error), `expected Fiat24Error ${code}`).toBe(true);
  if (isFiat24Error(error)) {
    expect(error.code).toBe(code);
    expect("cause" in error).toBe(false);
  }
}

/**
 * Awaits `run`, expecting a transport-level `Fiat24Error`: fixed `${endpoint} failed` message,
 * `{endpoint, status?}` detail, no `cause` — the §9.5 redaction contract.
 */
export async function expectApiError(
  run: () => Promise<unknown>,
  code: string,
  endpoint: string,
  status?: number,
): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (error_) {
    error = error_;
  }
  expect(error).toBeDefined();
  expect(isFiat24Error(error)).toBe(true);
  if (!isFiat24Error(error)) {
    return;
  }
  expect(error.code).toBe(code);
  expect(error.message).toBe(`${endpoint} failed`);
  const detail = error.detail as Record<string, unknown> | undefined;
  expect(detail?.["endpoint"]).toBe(endpoint);
  if (status === undefined) {
    expect(detail?.["status"]).toBeUndefined();
  } else {
    expect(detail?.["status"]).toBe(status);
  }
  expect("cause" in error).toBe(false);
}

/** I7: asserts a redacted `Fiat24Error` — no sentinels in message/detail, no `cause`. */
export function expectRedacted(error: unknown): void {
  expect(isFiat24Error(error)).toBe(true);
  if (isFiat24Error(error)) {
    expect(error.message).not.toContain("PII-SENTINEL");
    expect(JSON.stringify(error.detail)).not.toContain("PII-SENTINEL");
    expect("cause" in error).toBe(false);
  }
}

/** A controllable local clock for `Fiat24ApiOptions.now`; the server clock routes separately. */
export function clock(start = 1_795_328_524_822): {
  now: () => number;
  set: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
  };
}

export function timestampRoute(ms: number): Route {
  return json(JSON.stringify({ timestamp: ms }));
}

// The doc Part 2 §9 case 1 request URL's `qr=` value verbatim, decoded (32 lines: amount
// `1949.75` at index 18, `CHF` at 19, account LI7830174502999200012 at 3).
export const DOC_QR: string = decodeURIComponent(
  "SPC%0D%0A0200%0D%0A1%0D%0ALI7830174502999200012%0D%0AS%0D%0ARobert%20Schneider%20AG%0D%0AMusterstrasse%0D%0A18%0D%0A9490%0D%0AVaduz%0D%0ALI%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A1949.75%0D%0ACHF%0D%0AS%0D%0AHans%20Mustermann%0D%0AMusterstrasse%0D%0A27a%0D%0A9490%0D%0AVaduz%0D%0ALI%0D%0AQRR%0D%0A210000000003139471430009017%0D%0AAuftrag%20vom%2015.06.2020%0D%0AEPD%0D%0A%2F%2FS1%2F11%2F200427%2F30%2F102673386%2F31%2F200427%2F32%2F7.7%2F40%2F0%3A30",
);

/** Anvil account 0 — tests only (the SDK src never touches viem/accounts). */
export const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** A `Fiat24SessionSigner` that personal-signs the grant message and counts calls. */
export function testSigner(
  key: `0x${string}` = ANVIL_KEY,
): Fiat24SessionSigner & { readonly signCalls: number } {
  const account = privateKeyToAccount(key);
  let signCalls = 0;
  return {
    address: account.address,
    get signCalls() {
      return signCalls;
    },
    signSessionGrant: async (grant: Fiat24SessionGrant) => {
      signCalls += 1;
      return account.signMessage({ message: grant.message });
    },
  };
}
