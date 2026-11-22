import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect } from "vite-plus/test";

import { isFiat24Error } from "../src/core/index.ts";

export type VectorCase = Readonly<Record<string, unknown>>;
export type NamedCase = readonly [title: string, vectorCase: VectorCase];

export type VectorFile = {
  schema: 1;
  capability: string;
  source: Readonly<Record<string, unknown>>;
  cases: VectorCase[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVectorFile(value: unknown): value is VectorFile {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["schema"] === 1 &&
    typeof value["capability"] === "string" &&
    isRecord(value["source"]) &&
    Array.isArray(value["cases"])
  );
}

/** Loads a `vectors/**` file and asserts the shared envelope. */
export function loadVector(relative: string, capability: string): VectorFile {
  const path = fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isVectorFile(parsed)) {
    throw new Error(`invalid vector file ${relative}`);
  }
  if (parsed.capability !== capability) {
    throw new Error(`capability mismatch in ${relative}: ${parsed.capability} != ${capability}`);
  }
  return parsed;
}

/** `[title, case]` tuples for `test.each`, filtered by op and outcome. */
export function named(cases: VectorCase[], op: string, outcome: "ok" | "err" = "ok"): NamedCase[] {
  return cases
    .filter((c) => {
      if ((c["op"] ?? "run") !== op) {
        return false;
      }
      return outcome === "ok" ? "output" in c && !("error" in c) : "error" in c;
    })
    .map((c) => [JSON.stringify("input" in c ? c["input"] : (c["id"] ?? c)).slice(0, 80), c]);
}

/** Every `error` string in the cases, for the union-membership assertion. */
export function errorCodeStrings(cases: VectorCase[]): unknown[] {
  return cases.filter((c) => "error" in c).map((c) => c["error"]);
}

/** Runs `fn` expecting a {@link Fiat24Error} with the given `code`. */
export function expectError(run: () => unknown, expected: unknown): void {
  try {
    run();
  } catch (error) {
    expect(isFiat24Error(error)).toBe(true);
    if (isFiat24Error(error)) {
      expect(error.code).toBe(expected);
    }
    return;
  }
  expect.unreachable(`expected error ${String(expected)}`);
}

/**
 * True when `run` returns a value `accept`ed, or throws a {@link Fiat24Error} whose code is in
 * `codes`.
 */
export function okOrCode(
  run: () => unknown,
  codes: ReadonlySet<string>,
  accept: (value: unknown) => boolean = (): boolean => true,
): boolean {
  try {
    return accept(run());
  } catch (error) {
    return isFiat24Error(error) && codes.has(error.code);
  }
}

/**
 * True when `run` throws a {@link Fiat24Error} whose code is in `codes`; every other outcome is
 * false.
 */
export function throwsCode(run: () => unknown, codes: ReadonlySet<string>): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return isFiat24Error(error) && codes.has(error.code);
  }
}

export type CapturedError = { code: string; message: string };

/** Captures the `{ code, message }` of the thrown {@link Fiat24Error}; undefined otherwise. */
export function captureError(run: () => unknown): CapturedError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return isFiat24Error(error) ? { code: error.code, message: error.message } : undefined;
  }
}

/** True when two captured errors either differ in code or agree on the message for that code. */
export function messagesAreFixed(
  a: CapturedError | undefined,
  b: CapturedError | undefined,
): boolean {
  return a === undefined || b === undefined || a.code !== b.code || a.message === b.message;
}

/** Narrows `T | undefined` for `expect(...).toStrictEqual(...)` when undefined means test failure. */
export function required<T>(value: T | undefined): T {
  if (value === undefined) {
    expect.unreachable("expected a defined value");
  }
  return value;
}

/**
 * The invariant whitelist for `sendTransaction` (I1): it may appear only as the `Fiat24Signer`
 * member type in `core/signer.ts` or as a property access on a value named `signer`.
 */
export function sendTransactionAllowed(path: string, before: string): boolean {
  return (
    path.endsWith("core/signer.ts") ||
    path.endsWith(String.raw`core\signer.ts`) ||
    /\bsigner\s*\.\s*$/.test(before)
  );
}

/** Asserts the deep-freeze contract of a builder result: call, intent, contracts, nested Recipient. */
export function expectFrozenCall(call: {
  readonly intent: Readonly<Record<string, unknown>>;
  readonly contracts: ReadonlyArray<unknown>;
}): void {
  expect(Object.isFrozen(call)).toBe(true);
  expect(Object.isFrozen(call.intent)).toBe(true);
  expect(Object.isFrozen(call.contracts)).toBe(true);
  const recipient = call.intent["to"];
  if (typeof recipient === "object" && recipient !== null) {
    expect(Object.isFrozen(recipient)).toBe(true);
  }
}
