import { getAddress } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { loadAccount } from "../../src/flows/index.ts";
import type { AccountView } from "../../src/flows/index.ts";
import {
  accountEntries,
  allowanceEntries,
  availabilityEntries,
  B_HEX,
  balanceEntries,
  honestStorage,
  makeFlowStub,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  RECIPIENT,
  SENDER_ID,
} from "./stub.ts";

type LoadedView = Exclude<AccountView, { readonly step: "no-account" }>;

function loaded(view: AccountView): LoadedView {
  if (view.step === "no-account") {
    throw new Error("expected an account view");
  }
  return view;
}

function table(party: Parameters<typeof accountEntries>[1]) {
  return mergeCalls(
    proxyAdminEntry(),
    accountEntries(OWNER, party),
    balanceEntries(OWNER),
    allowanceEntries(OWNER),
    availabilityEntries({}),
  );
}

describe("loadAccount", () => {
  test("no-account", async () => {
    const stub = makeFlowStub({
      calls: mergeCalls(proxyAdminEntry(), accountEntries(OWNER, { historic: 0n, balance: 0n })),
      storage: honestStorage(),
    });
    const view = await loadAccount({ client: stub.client }, { owner: OWNER });
    expect(view).toStrictEqual({ step: "no-account" });
  });

  test("live", async () => {
    const stub = makeFlowStub({ calls: table({ historic: SENDER_ID }), storage: honestStorage() });
    const view = loaded(await loadAccount({ client: stub.client }, { owner: OWNER }));
    expect(view.step).toBe("live");
    expect(view.account.tokenId).toBe(SENDER_ID);
    expect(view.account.owner).toBe(getAddress(OWNER));
    expect(view.account.ownsToken).toBe(true);
    expect(view.iban).toBe(view.account.iban);
    expect(view.iban).toMatch(/^CH/);
    expect(view.balances.EUR24).toBe(1000n);
    expect(view.availability.account.paused).toBe(false);
    expect(view.allowances.card.EUR24).toBe(0n);
    expect(view.allowances.deposit.USDC).toBe(0n);
    expect(view.allowances.account.F24).toBe(0n);
  });

  test("stale", async () => {
    // historicOwnership resolves the id but ownerOf moved on — ownsToken false.
    const stub = makeFlowStub({
      calls: table({ historic: SENDER_ID, owner: RECIPIENT }),
      storage: honestStorage(),
    });
    const view = loaded(await loadAccount({ client: stub.client }, { owner: OWNER }));
    expect(view.step).toBe("stale");
    expect(view.account.ownsToken).toBe(false);
    expect(view.account.owner).toBe(getAddress(RECIPIENT));
  });

  test("exactly one block for all reads", async () => {
    const stub = makeFlowStub({ calls: table({ historic: SENDER_ID }), storage: honestStorage() });
    await loadAccount({ client: stub.client }, { owner: OWNER });
    const blockNumberCalls = stub.requests.filter((r) => r.method === "eth_blockNumber");
    expect(blockNumberCalls).toHaveLength(1);
    for (const call of stub.calls) {
      expect(call.blockTag).toBe(B_HEX);
    }
    const storageCalls = stub.requests.filter((r) => r.method === "eth_getStorageAt");
    for (const request of storageCalls) {
      const params = request.params as [string, string, string];
      expect(params[2]).toBe(B_HEX);
    }
    // Sanity: the rounds actually happened — balances, availability, allowances.
    const balanceReads = stub.calls.filter((c) => c.functionName === "balanceOf");
    expect(balanceReads.length).toBeGreaterThanOrEqual(4);
  });
});
