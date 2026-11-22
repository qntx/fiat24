import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { parseSwissQr } from "../../src/api/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { DOC_QR } from "../api/stub.ts";

function outcome(qr: unknown): string {
  try {
    parseSwissQr(qr as string);
    return "ok";
  } catch (error) {
    return isFiat24Error(error) ? error.code : "non-fiat24-throw";
  }
}

const ACCEPTED = new Set(["ok", "invalid-argument"]);

const lineMutation = fc.oneof(
  fc.record({ kind: fc.constant("set"), index: fc.nat(), line: fc.string({ maxLength: 40 }) }),
  fc.record({ kind: fc.constant("drop"), index: fc.nat() }),
  fc.record({ kind: fc.constant("insert"), index: fc.nat(), line: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant("join"), sep: fc.constantFrom("\r\n", "\n", "\r", "\r\r\n") }),
);

type Mutation = {
  kind: "set" | "drop" | "insert" | "join";
  index?: number;
  line?: string;
  sep?: string;
};

// Applies one line-level mutation to the doc QR at module scope (no conditionals in tests).
function mutateQr(mutation: Mutation): string {
  const lines = DOC_QR.split("\r\n");
  const at = (mutation.index ?? 0) % lines.length;
  if (mutation.kind === "set") {
    lines[at] = mutation.line ?? "";
  } else if (mutation.kind === "drop") {
    lines.splice(at, 1);
  } else if (mutation.kind === "insert") {
    lines.splice(at, 0, mutation.line ?? "");
  }
  return lines.join(mutation.kind === "join" ? (mutation.sep ?? "\r\n") : "\r\n");
}

describe("parseSwissQr properties (I14)", () => {
  test("arbitrary strings => SwissQr or invalid-argument", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(ACCEPTED).toContain(outcome(text));
      }),
    );
  });

  test("line-level mutations of the doc QR => SwissQr or invalid-argument", () => {
    fc.assert(
      fc.property(lineMutation, (mutation) => {
        expect(ACCEPTED).toContain(outcome(mutateQr(mutation)));
      }),
    );
  });

  test("arbitrary values (non-strings) => invalid-argument", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
        ),
        (value) => {
          expect(outcome(value)).toBe("invalid-argument");
        },
      ),
    );
  });
});
