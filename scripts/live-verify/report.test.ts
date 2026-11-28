import { describe, expect, it } from "vite-plus/test";

import {
  cardsSchema,
  profileSchema,
  timestampSchema,
  transactionsSchema,
} from "../../packages/fiat24/src/api/schemas.ts";
import { fixtureBody } from "../../packages/fiat24/tests/api/stub.ts";
import type { EndpointReport } from "./report.ts";
import { renderReport } from "./report.ts";
import { collectKeys, describeShape, diffShape, profileAsExpected, schemaShape } from "./shape.ts";

const SIGNATURE = `0x${"c5".repeat(65)}`;
const LABEL = "fiat24-session-v1:42161:7493817:1795328524;";
const OWNER = "0xcf61F43b6fAd7394c784401743dF9a7BF5FF1536";

const knownKeys = new Set<string>();
for (const name of ["secured/br.json", "secured/cards-ok.json", "secured/transactions.json"]) {
  const body: unknown = JSON.parse(fixtureBody(name));
  collectKeys(body, knownKeys);
}

const hostileMap: Record<string, string> = {};
for (let i = 200; i < 240; i += 1) {
  hostileMap[`PII-SENTINEL-${i}`] = `PII-SENTINEL-VALUE-${i}`;
}

const hostile = {
  tokenId: 7493817,
  name: "PII-SENTINEL-100",
  email: "pii.sentinel@example.com",
  iban: "CH93 0076 2011 6238 5295 7",
  phone: "+41 79 123 45 67",
  street: "PII-SENTINEL-101",
  "PII-SENTINEL-KEY": "PII-SENTINEL-102",
  amount: "98765.43",
  sig: SIGNATURE,
  label: LABEL,
  owner: OWNER,
  nested: [[["PII-SENTINEL-103"], ["PII-SENTINEL-104", "PII-SENTINEL-105"]]],
  map: hostileMap,
};

const endpoint = (name: string, endpointName: string, schema: unknown): EndpointReport => {
  const body: unknown = JSON.parse(fixtureBody(name));
  const shape = describeShape(body, knownKeys);
  return {
    endpoint: endpointName,
    sent: true,
    httpStatus: 200,
    contentType: "json",
    outcome: "ok",
    shape,
    schemaDiff: diffShape(schemaShape(schema), shape),
    fixtureDiff: diffShape(profileAsExpected(describeShape(body, knownKeys)), shape),
  };
};

const hostileShape = describeShape(hostile, knownKeys);

const report = renderReport({
  generatedAt: "2026-02-13T00:00:00.000Z",
  ttlSeconds: 180n,
  signerMode: "cast",
  dryRun: false,
  account: { status: "live", tokenIdDigits: 7, deploymentOk: true },
  skew: { sign: "+", bucket: "1-5s" },
  o1: { answer: "yes" },
  cardsBody: { httpStatus: 200, statusCodeClass: "200" },
  payoutRefs: {
    candidates: 3,
    prefixedPadded45: 1,
    prefixedUnpadded: 1,
    invalid: 0,
    payoutNoRef: 1,
    unreadableReceipts: 0,
  },
  endpoints: [
    endpoint("public/timestamp.json", "GET /timestamp", timestampSchema),
    endpoint("secured/br.json", "GET /br", profileSchema),
    endpoint("secured/cards-ok.json", "GET /cards", cardsSchema),
    endpoint("secured/transactions.json", "GET /transactions", transactionsSchema),
    {
      endpoint: "GET /hostile",
      sent: true,
      httpStatus: 200,
      contentType: "json",
      outcome: "ok",
      shape: hostileShape,
      schemaDiff: diffShape(schemaShape(profileSchema), hostileShape),
      fixtureDiff: [],
    },
  ],
});

describe("renderReport redaction", () => {
  const forbidden = [
    "PII-SENTINEL",
    "pii.sentinel@example.com",
    "CH93 0076 2011 6238 5295 7",
    "CH9300762011623852957",
    "+41 79 123 45 67",
    "7493817",
    "98765.43",
    "98765",
    SIGNATURE,
    SIGNATURE.slice(2),
    LABEL,
    LABEL.slice(0, -1),
    OWNER,
    OWNER.toLowerCase(),
    "690333",
  ];

  it.each(forbidden)("does not contain forbidden string #%#", (needle) => {
    expect(report).not.toContain(needle);
  });

  it("renders the structural sections", () => {
    expect(report).toContain("O-1 session label accepted: yes");
    expect(report).toContain("tokenId digit count: 7");
    expect(report).toContain("skew bucket: 1-5s");
    expect(report).toContain("<key");
    expect(report).toContain("enum-candidate");
    expect(report).toContain("iban-like");
    expect(report).toContain("Read this whole file before sharing");
  });
});
