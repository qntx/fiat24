/**
 * Structural profiles of JSON values. Everything in this module aggregates into fixed vocabularies
 * — kind names, regex classes, range buckets and counts — so a profile can be rendered into a
 * report that never contains a single response value. Values only ever appear as in-memory
 * `distinct` sets used for enum-candidate detection, and only members of PUBLIC_VOCABULARY may be
 * printed from them.
 */

export type Kind =
  | "null"
  | "boolean"
  | "integer"
  | "unsafe-integer"
  | "fraction"
  | "string"
  | "array"
  | "object";

const ALL_KINDS: ReadonlySet<Kind> = new Set([
  "null",
  "boolean",
  "integer",
  "unsafe-integer",
  "fraction",
  "string",
  "array",
  "object",
]);

export type PathStats = {
  count: number;
  readonly kinds: Set<Kind>;
  readonly arrayLengths: Map<string, number>;
  readonly intDigits: Map<string, number>;
  readonly fractionDecimals: Map<string, number>;
  lossyFractions: number;
  readonly stringClasses: Map<string, number>;
  readonly stringLengths: Map<string, number>;
  readonly keyCountBuckets: Map<string, number>;
  readonly distinct: Set<string>;
  distinctTotal: number;
};

export type ShapeProfile = Map<string, PathStats>;

const newStats = (): PathStats => ({
  count: 0,
  kinds: new Set(),
  arrayLengths: new Map(),
  intDigits: new Map(),
  fractionDecimals: new Map(),
  lossyFractions: 0,
  stringClasses: new Map(),
  stringLengths: new Map(),
  keyCountBuckets: new Map(),
  distinct: new Set(),
  distinctTotal: 0,
});

// Integer digit-count buckets: 10 vs 13 separates s and ms timestamps.
const digitsBucket = (count: number): string => {
  if (count <= 3) {
    return "1-3";
  }
  if (count <= 6) {
    return "4-6";
  }
  if (count <= 9) {
    return "7-9";
  }
  if (count === 10) {
    return "10";
  }
  if (count <= 12) {
    return "11-12";
  }
  if (count === 13) {
    return "13";
  }
  if (count <= 15) {
    return "14-15";
  }
  return "16+";
};

const stringLengthBucket = (n: number): string => {
  if (n === 0) {
    return "0";
  }
  if (n <= 4) {
    return "1-4";
  }
  if (n <= 8) {
    return "5-8";
  }
  if (n <= 16) {
    return "9-16";
  }
  if (n <= 32) {
    return "17-32";
  }
  if (n <= 64) {
    return "33-64";
  }
  if (n <= 128) {
    return "65-128";
  }
  if (n <= 256) {
    return "129-256";
  }
  if (n <= 1024) {
    return "257-1024";
  }
  return ">1024";
};

const arrayLengthBucket = (n: number): string => {
  if (n === 0) {
    return "0";
  }
  if (n === 1) {
    return "1";
  }
  if (n <= 4) {
    return "2-4";
  }
  if (n <= 16) {
    return "5-16";
  }
  if (n <= 64) {
    return "17-64";
  }
  if (n <= 256) {
    return "65-256";
  }
  if (n <= 1024) {
    return "257-1024";
  }
  return ">1024";
};

const decimalsBucket = (n: number): string => {
  if (n <= 2) {
    return "1-2";
  }
  if (n <= 6) {
    return "3-6";
  }
  return "7+";
};

// Objects with more keys than MAP_THRESHOLD are maps; the count itself is bucketed.
const keyCountBucket = (n: number): string => {
  if (n <= 64) {
    return "33-64";
  }
  if (n <= 256) {
    return "65-256";
  }
  if (n <= 1024) {
    return "257-1024";
  }
  return ">1024";
};

const MAP_THRESHOLD = 32;
const DISTINCT_CAP = 64;
const MAX_SIGNIFICANT_DIGITS = 15;

// The string classifier — first match wins. `iban-like` is tested on the space-stripped value.
const CLASSIFIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["masked", /[•*]{2,}/],
  ["hash32", /^0x[0-9a-fA-F]{64}$/],
  ["address", /^0x[0-9a-fA-F]{40}$/],
  ["hex", /^0x(?:[0-9a-fA-F]{2})+$/],
  ["payout-ref", /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/],
  ["uuid", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/],
  ["iso-datetime", /^\d{4}-\d{2}-\d{2}([T ].*)?$/],
  ["dotted-date", /^\d{2}\.\d{2}\.\d{4}/],
  ["decimal", /^-?\d+\.\d+$/],
  ["integer", /^-?\d+$/],
  ["iban-like", /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/],
  ["email-like", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["url", /^https?:\/\//],
  ["phone-like", /^\+?[0-9 ()-]{6,}$/],
  ["contact-id", /^[A-Z]{2,8}-[0-9]{1,16}$/],
  ["code", /^[A-Z0-9_]{1,12}$/],
  ["word", /^[A-Za-z]+$/],
];

export function classifyString(value: string): string {
  if (value === "") {
    return "empty";
  }
  const deSpaced = value.replaceAll(" ", "");
  const unPadded = value.replaceAll("\u0000", "");
  const target = (name: string): string => {
    if (name === "iban-like") {
      return deSpaced;
    }
    if (name === "payout-ref" && unPadded !== value && value.startsWith(unPadded)) {
      return unPadded;
    }
    return value;
  };
  for (const [name, re] of CLASSIFIERS) {
    if (re.test(target(name))) {
      return name;
    }
  }
  return "text";
}

const PLAIN_KEY = /^[a-z][A-Za-z0-9_]{0,39}$/;
const SHORT_KEY = /^[A-Z]{2,5}$/;

/** Keys outside the two safe shapes are reported as `.<key:CLASS>` — never verbatim. */
const keySegment = (key: string, knownKeys: ReadonlySet<string>): string =>
  PLAIN_KEY.test(key) || SHORT_KEY.test(key) || knownKeys.has(key)
    ? `.${key}`
    : `.<key:${classifyString(key)}>`;

const bump = (map: Map<string, number>, bucket: string): void => {
  map.set(bucket, (map.get(bucket) ?? 0) + 1);
};

const recordNumber = (stats: PathStats, value: number | bigint): void => {
  const digits = String(value < 0 ? -value : value).length;
  const safe = typeof value === "bigint" || Number.isSafeInteger(value);
  const integral = typeof value === "bigint" || Number.isInteger(value);
  if (integral) {
    stats.kinds.add(safe ? "integer" : "unsafe-integer");
    bump(stats.intDigits, digitsBucket(digits));
    return;
  }
  stats.kinds.add("fraction");
  const printed = String(value);
  if (/[eE]/.test(printed)) {
    bump(stats.fractionDecimals, "7+");
    stats.lossyFractions += 1;
    return;
  }
  const dot = printed.indexOf(".");
  bump(stats.fractionDecimals, decimalsBucket(dot === -1 ? 0 : printed.length - dot - 1));
  if (printed.replaceAll(/[-.]/g, "").replace(/^0+/, "").length > MAX_SIGNIFICANT_DIGITS) {
    stats.lossyFractions += 1;
  }
};

/**
 * `distinct` string-value tracking feeds enum-candidate detection. The set is capped at
 * DISTINCT_CAP so a hostile body cannot grow memory without bound; at the cap the path can no
 * longer be an enum candidate anyway (k <= 8 required).
 */
export function describeShape(
  json: unknown,
  knownKeys: ReadonlySet<string> = new Set(),
): ShapeProfile {
  const profile: ShapeProfile = new Map();
  const statsOf = (path: string): PathStats => {
    let stats = profile.get(path);
    if (stats === undefined) {
      stats = newStats();
      profile.set(path, stats);
    }
    return stats;
  };

  const recordValue = (path: string, value: unknown): void => {
    const stats = statsOf(path);
    stats.count += 1;
    if (value === null) {
      stats.kinds.add("null");
    } else if (typeof value === "boolean") {
      stats.kinds.add("boolean");
    } else if (typeof value === "number" || typeof value === "bigint") {
      recordNumber(stats, value);
    } else if (typeof value === "string") {
      stats.kinds.add("string");
      bump(stats.stringClasses, classifyString(value));
      bump(stats.stringLengths, stringLengthBucket(value.length));
      stats.distinctTotal += 1;
      if (stats.distinct.size < DISTINCT_CAP) {
        stats.distinct.add(value);
      }
    } else if (Array.isArray(value)) {
      stats.kinds.add("array");
      bump(stats.arrayLengths, arrayLengthBucket(value.length));
      for (const item of value) {
        recordValue(`${path}[]`, item);
      }
    } else if (typeof value === "object") {
      stats.kinds.add("object");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > MAP_THRESHOLD) {
        const child = `${path}.<key>`;
        bump(statsOf(child).keyCountBuckets, keyCountBucket(keys.length));
        for (const key of keys) {
          recordValue(child, record[key]);
        }
      } else {
        for (const key of keys) {
          recordValue(path + keySegment(key, knownKeys), record[key]);
        }
      }
    }
  };

  recordValue("$", json);
  return profile;
}

/** Every object key anywhere in `json` — builds the known-keys vocabulary from fixtures. */
export function collectKeys(json: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(json)) {
    for (const item of json) {
      collectKeys(item, into);
    }
  } else if (typeof json === "object" && json !== null) {
    for (const [key, value] of Object.entries(json)) {
      into.add(key);
      collectKeys(value, into);
    }
  }
  return into;
}

// The closed public vocabulary a distinct string value may be printed under (card statuses from
// secured.ts CARD_STATUS, token/fiat codes, transaction types, directions, QRCH, and the KYC
// status strings of schemas.ts). Everything else is counted, never shown.
export const PUBLIC_VOCABULARY: ReadonlySet<string> = new Set([
  "Active",
  "Blocked",
  "Expired",
  "EUR24",
  "USD24",
  "CHF24",
  "CNH24",
  "EUR",
  "USD",
  "CHF",
  "CNH",
  "ALL",
  "P2P",
  "FRX",
  "CTU",
  "CRD",
  "CDP",
  "CWD",
  "IN",
  "OUT",
  "QRCH",
  "NO_INIT",
  "NOT_INIT",
  "CA_COMPLETED_PENDING_SCAN",
  "PROCESSING_SCAN",
  "PENDING_ACTION",
  "MANUAL_REVIEW",
  "COMPLETED",
  "REJECTED",
  "INTERNAL_ERROR",
]);

/**
 * `distinct k of n` for a string path; `enum-candidate` when n >= 3, k <= 8 and k < n. Only
 * PUBLIC_VOCABULARY members are named; the rest is `other: m`.
 */
export function enumSummary(stats: PathStats): string | undefined {
  const k = stats.distinct.size;
  const n = stats.distinctTotal;
  if (n === 0) {
    return undefined;
  }
  const capped = k === DISTINCT_CAP && n > DISTINCT_CAP;
  if (!(n >= 3 && k <= 8 && k < n)) {
    return capped ? `distinct ${k}+ of ${n}` : `distinct ${k} of ${n}`;
  }
  const known = [...stats.distinct].filter((value) => PUBLIC_VOCABULARY.has(value)).toSorted();
  const other = k - known.length;
  const listed = known.join(", ");
  const rest = other > 0 ? (listed === "" ? `${other} other` : ` + ${other} other`) : "";
  return `enum-candidate: ${listed}${rest} (distinct ${k} of ${n})`;
}

// zod/mini internals — narrowed from `unknown` so scripts never import zod.
type ZodDef = {
  readonly type?: string;
  readonly shape?: Record<string, unknown>;
  readonly innerType?: unknown;
  readonly element?: unknown;
  readonly options?: ReadonlyArray<unknown>;
  readonly keyType?: unknown;
  readonly valueType?: unknown;
  readonly format?: string;
};

const defOf = (node: unknown): ZodDef | undefined => {
  if (typeof node === "object" && node !== null) {
    const inner = (node as { _zod?: unknown })._zod;
    if (typeof inner === "object" && inner !== null) {
      const { def } = inner as { def?: unknown };
      if (typeof def === "object" && def !== null) {
        return def;
      }
    }
  }
  return undefined;
};

export type ExpectedEntry = { readonly kinds: ReadonlySet<Kind>; readonly optional: boolean };
export type ExpectedShape = ReadonlyMap<string, ExpectedEntry>;

const leafKinds = (def: ZodDef): ReadonlySet<Kind> => {
  switch (def.type) {
    case "string":
    case "enum":
      return new Set(["string"]);
    case "boolean":
      return new Set(["boolean"]);
    case "number":
      return def.format === "safeint" || def.format === "int"
        ? new Set(["integer"])
        : new Set(["integer", "fraction"]);
    default:
      return ALL_KINDS;
  }
};

const kindOf = (node: unknown): Set<Kind> => {
  const def = defOf(node);
  if (def === undefined) {
    return new Set(ALL_KINDS);
  }
  switch (def.type) {
    case "object":
      return new Set(["object"]);
    case "array":
      return new Set(["array"]);
    case "optional": {
      const kinds = kindOf(def.innerType);
      return kinds;
    }
    case "nullable": {
      const kinds = kindOf(def.innerType);
      kinds.add("null");
      return kinds;
    }
    case "union": {
      const kinds = new Set<Kind>();
      for (const option of def.options ?? []) {
        for (const kind of kindOf(option)) {
          kinds.add(kind);
        }
      }
      return kinds;
    }
    default:
      return new Set(leafKinds(def));
  }
};

/**
 * Expected path -> {kinds, optional} out of a zod/mini schema: `object` walks `shape`, `optional`
 * marks descendants optional, `array` appends `[]`, `union` merges option kinds (children become
 * optional), `record` yields `.<key>` (always optional), `unknown` accepts every kind.
 */
export function schemaShape(schema: unknown): ExpectedShape {
  const out = new Map<string, { kinds: Set<Kind>; optional: boolean }>();
  const merge = (path: string, kinds: ReadonlySet<Kind>, optional: boolean): void => {
    const entry = out.get(path);
    if (entry === undefined) {
      out.set(path, { kinds: new Set(kinds), optional });
    } else {
      for (const kind of kinds) {
        entry.kinds.add(kind);
      }
      entry.optional = entry.optional && optional;
    }
  };
  // `flags.optional` = this node may be absent given its parent (its own optional wrapper or a
  // record value). `flags.relaxed` = the node sits inside one union branch, so children may be
  // absent even when their own type is required — propagated to descendants, unlike `optional`.
  type Flags = { readonly optional: boolean; readonly relaxed: boolean };
  const walk = (node: unknown, path: string, flags: Flags): void => {
    const def = defOf(node);
    if (def === undefined) {
      return;
    }
    switch (def.type) {
      case "object":
        merge(path, new Set(["object"]), flags.optional);
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          walk(child, `${path}.${key}`, { optional: flags.relaxed, relaxed: flags.relaxed });
        }
        break;

      case "optional":
        walk(def.innerType, path, { optional: true, relaxed: flags.relaxed });
        break;

      case "nullable":
        merge(path, new Set(["null"]), flags.optional);
        walk(def.innerType, path, { optional: true, relaxed: flags.relaxed });
        break;

      case "array":
        merge(path, new Set(["array"]), flags.optional);
        walk(def.element, `${path}[]`, { optional: flags.relaxed, relaxed: flags.relaxed });
        break;

      case "union":
        merge(path, kindOf(node), flags.optional);
        for (const option of def.options ?? []) {
          walk(option, path, { optional: true, relaxed: true });
        }
        break;

      case "record":
        merge(path, new Set(["object"]), flags.optional);
        walk(def.valueType, `${path}.<key>`, { optional: true, relaxed: flags.relaxed });
        break;

      default:
        merge(path, leafKinds(def), flags.optional);
    }
  };
  walk(schema, "$", { optional: false, relaxed: false });
  return out;
}

/** A live profile reused as an "expected" side (fixture diff): every observed path is optional. */
export function profileAsExpected(profile: ShapeProfile): ExpectedShape {
  const out = new Map<string, ExpectedEntry>();
  for (const [path, stats] of profile) {
    out.set(path, { kinds: new Set(stats.kinds), optional: true });
  }
  return out;
}

export type DiffIssue = "missing-required" | "missing-optional" | "kind-mismatch" | "extra";
export type DiffRow = { readonly path: string; readonly issue: DiffIssue; readonly detail: string };

const kindList = (kinds: ReadonlySet<Kind>): string => [...kinds].toSorted().join("|");

const parentPath = (path: string): string => {
  if (path.endsWith("[]")) {
    return path.slice(0, -2);
  }
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
};

/**
 * `missing-required` only when the parent is evidenced in live (object present / element path
 * occurred); `missing-optional` is informational; `kind-mismatch` when live kinds are not a subset
 * of expected; `extra` for live paths the schema strips.
 */
export function diffShape(expected: ExpectedShape, live: ShapeProfile): DiffRow[] {
  const rows: DiffRow[] = [];
  const parentEvidenced = (parent: string): boolean => {
    if (parent === "$" || parent === "") {
      return true;
    }
    const stats = live.get(parent);
    if (stats === undefined) {
      return false;
    }
    return parent.endsWith("[]") ? true : stats.kinds.has("object");
  };

  for (const [path, entry] of expected) {
    if (live.has(path) || path.endsWith("[]") || path.endsWith(".<key>")) {
      continue;
    }
    if (!parentEvidenced(parentPath(path))) {
      continue;
    }
    rows.push({
      path,
      issue: entry.optional ? "missing-optional" : "missing-required",
      detail: `expected ${kindList(entry.kinds)}`,
    });
  }

  const expectedFor = (livePath: string): ExpectedEntry | undefined => {
    const direct = expected.get(livePath);
    if (direct !== undefined) {
      return direct;
    }
    // `X.<key>` (a zod record) covers every concrete `X.foo` live path.
    const parent = parentPath(livePath);
    if (parent !== "" && !livePath.endsWith("[]")) {
      return expected.get(`${parent}.<key>`);
    }
    return undefined;
  };

  for (const [path, stats] of live) {
    const entry = expectedFor(path);
    if (entry === undefined) {
      rows.push({ path, issue: "extra", detail: `live ${kindList(stats.kinds)}` });
      continue;
    }
    const unexpected = [...stats.kinds].filter((kind) => !entry.kinds.has(kind));
    if (unexpected.length > 0) {
      rows.push({
        path,
        issue: "kind-mismatch",
        detail: `live ${kindList(stats.kinds)}, expected ${kindList(entry.kinds)}`,
      });
    }
  }

  return rows.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
