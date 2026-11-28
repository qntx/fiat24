import { describe, expect, it } from "vite-plus/test";

import { profileSchema } from "../../packages/fiat24/src/api/schemas.ts";
import type { PathStats, ShapeProfile } from "./shape.ts";
import {
  classifyString,
  describeShape,
  diffShape,
  enumSummary,
  profileAsExpected,
  schemaShape,
} from "./shape.ts";

const mustGet = (profile: ShapeProfile, path: string): PathStats => {
  const stats = profile.get(path);
  if (stats === undefined) {
    throw new Error(`missing shape stats for ${path}`);
  }
  return stats;
};

describe("classifyString", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["", "empty"],
    ["•••• 4455", "masked"],
    ["0x815da6bf2b2767c61e11f2378e31d2e92c397b860e18c80b0ed7fb05ed5897a2", "hash32"],
    ["0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA", "address"],
    ["0xdeadbeef", "hex"],
    ["690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000", "payout-ref"],
    ["854ee1ef-6fc3-4009-a10e-7c3be268e52c", "uuid"],
    ["2023-09-16T09:04:00Z", "iso-datetime"],
    ["16.09.2023 - 9:04", "dotted-date"],
    ["-1.89", "decimal"],
    ["29405.00", "decimal"],
    ["-42", "integer"],
    ["CH93 0076 2011 6238 5295 7", "iban-like"],
    ["pii.sentinel@example.com", "email-like"],
    ["https://www.fiat24.com/img/mastercard.png", "url"],
    ["+41 79 123 45 67", "phone-like"],
    ["EC-0000001", "contact-id"],
    ["QRCH", "code"],
    ["PostFinance", "word"],
    ["PII-SENTINEL-1", "text"],
    ["fiat24-session-v1:42161:690333:1795328524;", "text"],
  ];

  it.each(cases)("%j -> %s", (input, expected) => {
    expect(classifyString(input)).toBe(expected);
  });
});

describe("describeShape", () => {
  it("keeps safe keys verbatim and redacts hostile ones", () => {
    const profile = describeShape({ plain: 1, UPP: 2, "PII-SENTINEL-KEY": 3 });
    expect(profile.has("$.plain")).toBe(true);
    expect(profile.has("$.UPP")).toBe(true);
    expect(profile.has("$.<key:text>")).toBe(true);
    expect([...profile.keys()].join(" ")).not.toContain("PII-SENTINEL");
  });

  it("keeps fixture/schema keys verbatim via the vocabulary", () => {
    const profile = describeShape({ debitCard: "MSTD", weirdKey: "x" }, new Set(["debitCard"]));
    expect(profile.has("$.debitCard")).toBe(true);
    expect(profile.has("$.weirdKey")).toBe(true); // matches the safe plain-key shape anyway
  });

  it("collapses objects with more than 32 keys into <key>", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) {
      wide[`k${i}secret`] = i;
    }
    const profile = describeShape({ m: wide });
    const entry = profile.get("$.m.<key>");
    expect(entry).toBeDefined();
    expect(entry?.kinds.has("integer")).toBe(true);
    expect(entry?.count).toBe(40);
    expect(entry?.keyCountBuckets.get("33-64")).toBe(1);
    expect(profile.has("$.m.k0secret")).toBe(false);
  });

  it("buckets integer digit counts (10 vs 13 distinguishes s/ms timestamps)", () => {
    const profile = describeShape({ a: 7, b: 1_234_567_890, c: 1_234_567_890_123 });
    expect(profile.get("$.a")?.intDigits.get("1-3")).toBe(1);
    expect(profile.get("$.b")?.intDigits.get("10")).toBe(1);
    expect(profile.get("$.c")?.intDigits.get("13")).toBe(1);
  });

  it("separates integer, unsafe-integer and fraction", () => {
    const profile = describeShape({ a: 42, b: 2 ** 60, c: 1.5, d: 1e-7 });
    expect(profile.get("$.a")?.kinds.has("integer")).toBe(true);
    expect(profile.get("$.b")?.kinds.has("unsafe-integer")).toBe(true);
    expect(profile.get("$.c")?.kinds.has("fraction")).toBe(true);
    expect(profile.get("$.d")?.lossyFractions).toBe(1);
  });

  it("aggregates array elements under []", () => {
    const profile = describeShape({ list: [{ a: "x" }, { a: "y", b: 1 }] });
    expect(profile.get("$.list")?.kinds.has("array")).toBe(true);
    expect(profile.get("$.list[]")?.count).toBe(2);
    expect(profile.get("$.list[].a")?.count).toBe(2);
    expect(profile.get("$.list[].b")?.count).toBe(1);
  });
});

describe("enumSummary", () => {
  it("flags enum candidates and only names vocabulary values", () => {
    const profile = describeShape({
      t: [{ s: "EUR24" }, { s: "USD24" }, { s: "EUR24" }, { s: "PII-SENTINEL-1" }],
    });
    const summary = String(enumSummary(mustGet(profile, "$.t[].s")));
    expect(summary).toContain("enum-candidate");
    expect(summary).toContain("EUR24");
    expect(summary).toContain("USD24");
    expect(summary).toContain("1 other");
    expect(summary).not.toContain("PII-SENTINEL");
  });

  it("counts without flagging when cardinality rules fail", () => {
    const profile = describeShape({ s: ["a", "b", "c"] });
    expect(enumSummary(mustGet(profile, "$.s[]"))).toBe("distinct 3 of 3");
  });
});

describe("schemaShape", () => {
  it("extracts expected paths from profileSchema", () => {
    const shape = schemaShape(profileSchema);
    expect(shape.get("$.tokenId")).toStrictEqual({
      kinds: new Set(["integer"]),
      optional: false,
    });
    expect(shape.get("$.cardActivation")).toStrictEqual({
      kinds: new Set(["object"]),
      optional: true,
    });
    expect(shape.get("$.br")).toStrictEqual({ kinds: new Set(["string"]), optional: false });
    expect(shape.get("$.contacts")).toStrictEqual({ kinds: new Set(["object"]), optional: true });
    expect(shape.get("$.contacts.CHF[]")).toStrictEqual({
      kinds: new Set(["object"]),
      optional: false,
    });
    expect(shape.get("$.cardActivation.amount")?.kinds.has("integer")).toBe(true);
    expect(shape.get("$.cardActivation.amount")?.kinds.has("string")).toBe(true);
  });
});

describe("diffShape", () => {
  const expected = schemaShape(profileSchema);

  it("flags missing required keys only when the parent exists", () => {
    const live = describeShape({ tokenId: 1 });
    const rows = diffShape(expected, live);
    const issues = new Map(rows.map((row) => [row.path, row.issue]));
    expect(issues.get("$.br")).toBe("missing-required");
    // contacts is absent entirely: its children are not individually missing-required.
    expect(issues.get("$.contacts.EUR")).toBeUndefined();
    // and contacts itself is optional
    expect(issues.get("$.contacts")).toBe("missing-optional");
  });

  it("flags kind mismatches and extras", () => {
    const live = describeShape({ tokenId: "oops", surprise: "x" });
    const rows = diffShape(expected, live);
    const issues = new Map(rows.map((row) => [row.path, row.issue]));
    expect(issues.get("$.tokenId")).toBe("kind-mismatch");
    expect(issues.get("$.surprise")).toBe("extra");
  });

  it("treats fixture shapes as all-optional", () => {
    const fixture = describeShape({ tokenId: 690333, br: "PII-SENTINEL-1" });
    const live = describeShape({ tokenId: "7", extra: true });
    const rows = diffShape(profileAsExpected(fixture), live);
    const issues = new Map(rows.map((row) => [row.path, row.issue]));
    expect(issues.get("$.br")).toBe("missing-optional");
    expect(issues.get("$.extra")).toBe("extra");
    expect(issues.get("$.tokenId")).toBe("kind-mismatch");
  });
});
