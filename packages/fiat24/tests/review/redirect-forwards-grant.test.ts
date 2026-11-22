/**
 * R-02 — the SDK issues secured reads with `{method, headers}` only (no `redirect` key), so a
 * redirecting answer forwards the session's bearer-grant headers (tokenid/hash/deadline/sign) to
 * whatever origin the redirect Location points at. This test asserts the current defective
 * behaviour; it is expected to fail once the finding is fixed.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { API_BASE_URL, createFiat24Api } from "../../src/api/index.ts";
import { fixtureBody, testSigner } from "../api/stub.ts";

const GRANT_HEADERS = ["sign", "hash", "deadline", "tokenid"] as const;

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

describe("redirect forwards the session grant (R-02)", () => {
  const receivedB: Array<Record<string, string | string[] | undefined>> = [];
  const inits: Array<RequestInit | undefined> = [];
  let serverA: Server;
  let serverB: Server;
  let portA = 0;

  beforeAll(async () => {
    serverB = createServer((req, res) => {
      receivedB.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixtureBody("secured/br.json"));
    });
    const portB = await listen(serverB);
    serverA = createServer((req, res) => {
      if (req.url === "/timestamp") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ timestamp: Date.now() }));
        return;
      }
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/br` });
      res.end();
    });
    portA = await listen(serverA);
  });

  afterAll(async () => {
    await new Promise((resolve) => serverA.close(resolve));
    await new Promise((resolve) => serverB.close(resolve));
  });

  test("session.profile() sends grant headers to the redirected origin", async () => {
    const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      inits.push(init);
      const url = String(input).replace(API_BASE_URL, `http://127.0.0.1:${portA}`);
      return globalThis.fetch(url, init);
    }) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: Date.now });
    const session = api.openSession({ tokenId: 690333n, signer: testSigner() });

    const profile = await session.profile();
    expect(profile.tokenId).toBe(690333n);

    expect(receivedB).toHaveLength(1);
    const [headers] = receivedB;
    for (const name of GRANT_HEADERS) {
      expect(headers?.[name], `grant header ${name} reached the other origin`).toBeDefined();
    }
    expect(String(headers?.["sign"])).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(headers?.["tokenid"]).toBe("690333");
    // The SDK's RequestInit carries no `redirect` key — fetch follows by default.
    // Two SDK-initiated fetches: the grant's /timestamp read and the /br read.
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init).toBeDefined();
      expect(init).not.toHaveProperty("redirect");
    }
  });
});
