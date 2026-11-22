/**
 * R-06 — every exported constant table must be deeply frozen: a host that mutates `CURRENCIES`, an
 * ABI array or an account map relabels results or changes contract behaviour under the SDK's feet.
 * A `Map`/`Set`/`WeakMap` export can never be protected this way, so none may exist.
 */
import { describe, expect, test } from "vite-plus/test";

import * as abi from "../../src/abi/index.ts";
import * as api from "../../src/api/index.ts";
import * as calls from "../../src/calls/index.ts";
import * as chain from "../../src/chain/index.ts";
import * as core from "../../src/core/index.ts";
import { CURRENCIES } from "../../src/core/index.ts";
import type { Currency } from "../../src/core/index.ts";
import * as deployments from "../../src/deployments/index.ts";
import * as events from "../../src/events/index.ts";
import * as flows from "../../src/flows/index.ts";
import * as root from "../../src/index.ts";

const ENTRIES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["src/index.ts", root],
  ["src/abi/index.ts", abi],
  ["src/api/index.ts", api],
  ["src/calls/index.ts", calls],
  ["src/chain/index.ts", chain],
  ["src/core/index.ts", core],
  ["src/deployments/index.ts", deployments],
  ["src/events/index.ts", events],
  ["src/flows/index.ts", flows],
];

function isCollection(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertDeepFrozen(value: Record<string, unknown>): void {
  expect(Object.isFrozen(value)).toBe(true);
  for (const item of Object.values(value)) {
    if (isCollection(item)) {
      assertDeepFrozen(item);
    }
  }
}

function checkExport(value: unknown): void {
  if (!isCollection(value)) {
    return;
  }
  // Object.freeze cannot stop Set#add / Map#set / WeakMap#set — none may be exported.
  expect(value instanceof Map || value instanceof Set || value instanceof WeakMap).toBe(false);
  assertDeepFrozen(value);
}

describe("exported constant tables are deeply frozen (R-06)", () => {
  test.each(ENTRIES)("%s", (_entry, ns) => {
    const objects = Object.values(ns).filter(isCollection);
    for (const value of objects) {
      checkExport(value);
    }
    expect(objects.every((value) => Object.isFrozen(value))).toBe(true);
  });

  test("CURRENCIES cannot be mutated: reverse() and sort() throw", () => {
    // oxlint-disable-next-line unicorn/no-array-reverse -- the test asserts mutation throws
    expect(() => (CURRENCIES as Currency[]).reverse()).toThrow(TypeError);
    // oxlint-disable-next-line unicorn/no-array-sort -- the test asserts mutation throws
    expect(() => (CURRENCIES as Currency[]).sort()).toThrow(TypeError);
    expect(() => {
      (CURRENCIES as Currency[])[0] = "CNH24";
    }).toThrow(TypeError);
    expect(CURRENCIES).toStrictEqual(["USD24", "EUR24", "CHF24", "CNH24"]);
  });

  test("fiat24ErrorsAbi entries cannot be mutated", () => {
    const { fiat24ErrorsAbi } = abi;
    for (const entry of fiat24ErrorsAbi) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(() => (fiat24ErrorsAbi as unknown as unknown[]).push({})).toThrow(TypeError);
  });
});
