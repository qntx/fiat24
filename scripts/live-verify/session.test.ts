import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import type { SessionHeaders } from "../../packages/fiat24/src/api/session.ts";
import { ANVIL_KEY } from "../../packages/fiat24/tests/api/stub.ts";
import { buildGrant, checkSignature, readOnlySession } from "./session.ts";

const SERVER_MS = 1_795_328_524_822n;
const TOKEN_ID = 690333n;

const HEADERS: SessionHeaders = {
  tokenid: "690333",
  hash: "h",
  deadline: "1",
  sign: "0x00",
};

describe("buildGrant", () => {
  it("computes deadline/hash/message from server time and ttl", () => {
    const grant = buildGrant({ tokenId: TOKEN_ID, serverMs: SERVER_MS });
    expect(grant.deadline).toBe(SERVER_MS / 1000n + 180n);
    expect(grant.hash).toBe(`fiat24-session-v1:42161:690333:${SERVER_MS / 1000n + 180n};`);
    expect(grant.message.startsWith("I agree to access my profile. 0x")).toBe(true);
    const custom = buildGrant({ tokenId: TOKEN_ID, serverMs: SERVER_MS, ttl: 60n });
    expect(custom.deadline).toBe(SERVER_MS / 1000n + 60n);
  });

  it("rejects ttl outside 60..600", () => {
    expect(() => buildGrant({ tokenId: TOKEN_ID, serverMs: SERVER_MS, ttl: 59n })).toThrow(
      "60..600",
    );
    expect(() => buildGrant({ tokenId: TOKEN_ID, serverMs: SERVER_MS, ttl: 601n })).toThrow(
      "60..600",
    );
    expect(() => buildGrant({ tokenId: TOKEN_ID, serverMs: SERVER_MS, ttl: 600n })).not.toThrow();
  });
});

describe("checkSignature", () => {
  it("accepts a signature recovering to the owner", async () => {
    const account = privateKeyToAccount(ANVIL_KEY);
    const signature = await account.signMessage({ message: "hello" });
    await expect(
      checkSignature({ message: "hello", signature, owner: account.address }),
    ).resolves.toBe(signature);
  });

  it("rejects malformed and foreign signatures without echoing them", async () => {
    const account = privateKeyToAccount(ANVIL_KEY);
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const signature = await account.signMessage({ message: "hello" });
    await expect(
      checkSignature({ message: "hello", signature: "0xdead", owner: account.address }),
    ).rejects.toThrow("65-byte");
    const error = await checkSignature({
      message: "hello",
      signature,
      owner: other.address,
    }).catch((error_: unknown) => error_);
    const { message } = error as Error;
    expect(message).toContain("account owner");
    expect(message).not.toContain(signature.slice(2, 12));
  });
});

describe("readOnlySession", () => {
  const sessionAt = (now: bigint) =>
    readOnlySession({ headers: HEADERS, deadline: 1000n, nowSeconds: () => now });

  it("passes the headers to run", async () => {
    const seen = await sessionAt(0n).read(async (headers) => Promise.resolve(headers));
    expect(seen).toBe(HEADERS);
  });

  it("propagates a 401 — it is the answer, never re-granted", async () => {
    let runs = 0;
    await expect(
      sessionAt(0n).read(async () => {
        runs += 1;
        return Promise.reject(new Error("unauthorized"));
      }),
    ).rejects.toThrow("unauthorized");
    expect(runs).toBe(1);
  });

  it("refuses to send a grant expiring within 15 s", async () => {
    await expect(sessionAt(985n).read(async () => Promise.resolve("x"))).rejects.toThrow("15 s");
    await expect(sessionAt(984n).read(async () => Promise.resolve("x"))).resolves.toBe("x");
  });

  it("write always rejects without calling run", async () => {
    let ran = false;
    await expect(
      sessionAt(0n).write(async () => {
        ran = true;
        return Promise.resolve("x");
      }),
    ).rejects.toThrow("live-verify is read-only");
    expect(ran).toBe(false);
  });

  it("end() drops the headers for good", async () => {
    const session = sessionAt(0n);
    await session.read(async () => Promise.resolve("x"));
    session.end();
    await expect(session.read(async () => Promise.resolve("x"))).rejects.toThrow("ended");
    await expect(session.read(async () => Promise.resolve("x"))).rejects.toThrow("ended");
  });
});
