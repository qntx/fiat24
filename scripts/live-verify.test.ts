import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress } from "viem";
import type { Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { API_BASE_URL } from "../packages/fiat24/src/api/http.ts";
import type { RawLog } from "../packages/fiat24/src/events/types.ts";
import {
  ANVIL_KEY,
  clock,
  fixtureBody as fixtureText,
  json,
  stubFetch,
  timestampRoute,
} from "../packages/fiat24/tests/api/stub.ts";
import type { Route } from "../packages/fiat24/tests/api/stub.ts";
import { fixtureBody, run } from "./live-verify.ts";
import type { LoadedAccount, RunDeps } from "./live-verify.ts";

const account = privateKeyToAccount(ANVIL_KEY);
const TOKEN_ID = 690333n;
const SERVER_MS = 1_795_328_524_822;

const loaded: LoadedAccount = {
  tokenId: TOKEN_ID,
  owner: account.address,
  ownsToken: true,
  status: "live",
  limit: { max: 1_000_000n, used: 27_880n },
  balances: { USD24: 0n, EUR24: 123n, CHF24: 0n, CNH24: 0n },
  blockNumber: 123n,
  deploymentOk: true,
};

const makeRoutes = (overrides: Readonly<Record<string, Route>> = {}) => ({
  "/timestamp": timestampRoute(SERVER_MS),
  "/br": json(fixtureText("secured/br.json")),
  "/cards": json(fixtureText("secured/cards-ok.json")),
  "/transactions?currency=ALL&recordscount=100": json(fixtureText("secured/transactions.json")),
  ...overrides,
});

type Harness = {
  deps: RunDeps;
  calls: ReadonlyArray<{ url: string; init: RequestInit }>;
  lines: string[];
  report: { path: string; text: string } | undefined;
};

function harness(routeTable: Readonly<Record<string, Route>>, sign?: RunDeps["sign"]): Harness {
  const stub = stubFetch(routeTable);
  const local = clock(SERVER_MS);
  const lines: string[] = [];
  const state: { report?: { path: string; text: string } } = {};
  const deps: RunDeps = {
    fetch: stub.fetch,
    load: async () => Promise.resolve(loaded),
    logsOf: async () => Promise.resolve([]),
    sign: sign ?? (async ({ message }) => account.signMessage({ message })),
    now: local.now,
    log: (line) => {
      lines.push(line);
    },
    writeReport: (path, text) => {
      state.report = { path, text };
    },
    fixture: fixtureBody,
  };
  return {
    deps,
    calls: stub.calls,
    lines,
    get report() {
      return state.report;
    },
  };
}

const options = {
  target: { tokenId: TOKEN_ID },
  ttl: 180n,
  signerMode: "cast" as const,
  dryRun: false,
  out: "live-verify-report.md",
};

const fetched = (calls: ReadonlyArray<{ url: string }>): string[] =>
  calls.map((c) => c.url.slice(API_BASE_URL.length));

const reportText = (h: Harness): string => h.report?.text ?? "";

const mustCase = <T extends { label: string }>(cases: ReadonlyArray<T>, label: string): T => {
  const found = cases.find((c) => c.label === label);
  if (found === undefined) {
    throw new Error(`vector case ${label} missing`);
  }
  return found;
};

describe("run", () => {
  it("issues exactly the four allow-listed GETs and writes a redacted report", async () => {
    const h = harness(makeRoutes());
    let signature: Hex = "0x";
    h.deps = {
      ...h.deps,
      sign: async ({ message }) => {
        signature = await account.signMessage({ message });
        return signature;
      },
    };
    await run(options, h.deps);
    expect(fetched(h.calls)).toStrictEqual([
      "/timestamp",
      "/br",
      "/cards",
      "/transactions?currency=ALL&recordscount=100",
    ]);
    const report = reportText(h);
    expect(report).toContain("O-1 session label accepted: yes");
    expect(report).toContain("GET /br");
    expect(report).toContain("GET /transactions");
    // Redaction: no PII, no identifiers, no credentials.
    for (const needle of [
      "PII-SENTINEL",
      "690333",
      account.address,
      account.address.toLowerCase(),
      signature,
      signature.slice(2),
      "fiat24-session-v1",
    ]) {
      expect(report).not.toContain(needle);
    }
    // The signature never reaches a log line either.
    expect(h.lines.join("\n")).not.toContain(signature);
    expect(h.lines.join("\n")).not.toContain(signature.slice(2));
  });

  it("answers O-1 = no when the first secured GET is a 401", async () => {
    const h = harness(makeRoutes({ "/br": () => new Response("no", { status: 401 }) }));
    await run(options, h.deps);
    expect(reportText(h)).toContain("O-1 session label accepted: no");
  });

  it("aborts before any secured fetch when the signer is not the owner", async () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const h = harness(makeRoutes(), async ({ message }) => other.signMessage({ message }));
    await expect(run(options, h.deps)).rejects.toThrow("account owner");
    expect(fetched(h.calls)).toStrictEqual(["/timestamp"]);
    expect(h.report).toBeUndefined();
  });

  it("sends nothing and writes nothing in dry-run", async () => {
    const sent: string[] = [];
    const h = harness(makeRoutes());
    h.deps = {
      ...h.deps,
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        sent.push(String(input));
        return Promise.reject(new Error("network disabled"));
      },
      sign: async () => Promise.reject(new Error("must not sign in dry-run")),
    };
    await run({ ...options, dryRun: true }, h.deps);
    expect(sent).toStrictEqual([]);
    expect(h.report).toBeUndefined();
    const printed = h.lines.join("\n");
    expect(printed).toContain(`request: GET ${API_BASE_URL}/br`);
    expect(printed).toContain(
      `request: GET ${API_BASE_URL}/transactions?currency=ALL&recordscount=100`,
    );
    expect(printed).toContain("dry-run complete");
  });

  it("aborts with nothing sent when signing finishes after deadline - 15 s", async () => {
    const local = clock(SERVER_MS);
    const h = harness(makeRoutes());
    h.deps = {
      ...h.deps,
      now: local.now,
      sign: async ({ message }) => {
        local.set(SERVER_MS + 200_000); // 20 s past the 180 s deadline
        return account.signMessage({ message });
      },
    };
    await expect(run(options, h.deps)).rejects.toThrow("15 s");
    expect(fetched(h.calls)).toStrictEqual(["/timestamp"]);
    expect(h.report).toBeUndefined();
  });

  it("judges expiry by server time when the server clock is ahead of local", async () => {
    // Local runs 200 s behind the server. After signing, local says 190 s are left but server time
    // is already past deadline - 15 s — the run must abort on server time, not local.
    const local = clock(SERVER_MS - 200_000);
    const h = harness(makeRoutes());
    h.deps = {
      ...h.deps,
      now: local.now,
      sign: async ({ message }) => {
        local.set(SERVER_MS - 10_000);
        return account.signMessage({ message });
      },
    };
    await expect(run(options, h.deps)).rejects.toThrow("15 s");
    expect(fetched(h.calls)).toStrictEqual(["/timestamp"]);
    expect(h.report).toBeUndefined();
  });

  it("classifies payout refs from receipts (O-3/O-9)", async () => {
    const txHash = `0x${"11".repeat(32)}`;
    const body = JSON.stringify({
      count: 1,
      transactions: [
        {
          title: "payout",
          subtitle: "x",
          amount: "1.00",
          timestamp: 1_683_221_111_000,
          txId: txHash,
          from: 690333,
          blockNumber: 1,
        },
      ],
    });
    const vectors: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, "../vectors/events/decode.json"), "utf8"),
    );
    const { cases } = vectors as { cases: Array<{ label: string; input: unknown }> };
    const toRaw = (input: unknown): RawLog => {
      const log = input as Record<string, unknown>;
      return {
        address: getAddress(log["address"] as string),
        topics: log["topics"] as Hex[],
        data: log["data"] as Hex,
        blockNumber: BigInt(log["blockNumber"] as string),
        transactionHash: log["transactionHash"] as Hash,
        logIndex: Number(log["logIndex"]),
      };
    };
    const padded = mustCase(cases, "NulPaddedRef.ClientPayoutRef");
    const otherAccount = mustCase(cases, "EUR24.ClientPayoutRef");
    const h = harness(makeRoutes({ "/transactions?currency=ALL&recordscount=100": json(body) }));
    h.deps = {
      ...h.deps,
      logsOf: async () => Promise.resolve([[toRaw(padded.input), toRaw(otherAccount.input)]]),
    };
    await run(options, h.deps);
    const report = reportText(h);
    expect(report).toContain("prefixed+padded-45: 1");
    expect(report).toContain("prefixed-unpadded: 0");
    // The other account's ClientPayoutRef (tokenId 109549) is filtered out.
    expect(report).toContain("invalid: 0");
  });
});
