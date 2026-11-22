/**
 * R-05 — the onboarding tourist/kyc poll path reaches `live` without any deployment verification:
 * no `eth_getStorageAt` at all, so a swapped account implementation goes unnoticed while the
 * `check`/`ready` steps reject the same drift as `contract-changed`. This test asserts the current
 * defective behaviour; it is expected to fail once the finding is fixed.
 */
import type { Hex } from "viem";
import { getAddress, zeroAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import type { Fiat24Api } from "../../src/api/types.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import { advanceOnboarding } from "../../src/flows/index.ts";
import type { OnboardingState } from "../../src/flows/index.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import {
  B,
  flowDeps,
  honestStorage,
  makeFlowStub,
  OWNER,
  proxyAdminEntry,
  SENDER_ID,
  TXID_1,
  wordWithAddress,
} from "../flows/stub.ts";

const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const CONFIRMED_MAIN = {
  purpose: "main" as const,
  phase: "confirmed" as const,
  fromBlock: B,
  nonce: 6,
  hash: TXID_1,
  blockNumber: B + 1n,
};

const KYC: OnboardingState = {
  flow: "onboarding",
  version: 1,
  owner: OWNER_CS,
  txs: [CONFIRMED_MAIN],
  step: "kyc",
  tokenId: SENDER_ID,
  payment: "f24",
  quote: { input: 20_000n, blockNumber: B },
  kyc: "processing",
};

const CHECK: OnboardingState = {
  flow: "onboarding",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "check",
  tokenId: SENDER_ID,
  payment: "f24",
};

/** The getAccount({tokenId}) round the poll consumes; statusIndex 5 = live. */
function accountByIdEntries(statusIndex = 5): Map<string, CallEntry[]> {
  return new Map<string, CallEntry[]>([
    [`${ACCOUNT.toLowerCase()}:exists`, [{ args: [SENDER_ID], answer: { result: true } }]],
    [`${ACCOUNT.toLowerCase()}:status`, [{ args: [SENDER_ID], answer: { result: statusIndex } }]],
    [
      `${ACCOUNT.toLowerCase()}:limit`,
      [{ args: [SENDER_ID], answer: { result: [0n, 10_000n, 0n] } }],
    ],
    [`${ACCOUNT.toLowerCase()}:limitTourist`, [{ answer: { result: 400n } }]],
    [`${ACCOUNT.toLowerCase()}:walletProvider`, [{ args: [SENDER_ID], answer: { result: 0n } }]],
    [`${ACCOUNT.toLowerCase()}:ownerOf`, [{ args: [SENDER_ID], answer: { result: OWNER } }]],
    [
      `${ACCOUNT.toLowerCase()}:getApproved`,
      [{ args: [SENDER_ID], answer: { result: zeroAddress } }],
    ],
  ]);
}

function apiStub(status: string): Fiat24Api {
  return { kycStatus: async () => Promise.resolve(status as never) } as unknown as Fiat24Api;
}

/** Honest deployment storage with the account proxy's impl slot pointing somewhere else. */
function driftedStorage(): Map<string, Hex> {
  const storage = honestStorage();
  storage.set(`${ACCOUNT.toLowerCase()}:${IMPL_SLOT}`, wordWithAddress(OWNER));
  return storage;
}

describe("kyc poll skips the drift check (R-05)", () => {
  test("kyc state + drifted impl slot ⇒ live, and zero eth_getStorageAt", async () => {
    const stub = makeFlowStub({
      calls: accountByIdEntries(5),
      storage: driftedStorage(),
    });
    const { deps: base } = flowDeps(stub.client);
    const deps = { ...base, api: apiStub("completed") };
    const next = await advanceOnboarding(deps, KYC);
    expect(next.step).toBe("live");
    expect(stub.requests.some((r) => r.method === "eth_getStorageAt")).toBe(false);
  });

  test("control: check state + same drifted storage ⇒ contract-changed", async () => {
    const stub = makeFlowStub({ calls: proxyAdminEntry(), storage: driftedStorage() });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advanceOnboarding(deps, CHECK),
      "contract-changed",
    );
    expect(error.detail).toMatchObject({ contract: "account", field: "implementation" });
  });
});
