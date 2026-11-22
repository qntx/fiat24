import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { payoutCall, payoutRefCall } from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  DESK,
  FORK_ENABLED,
  LIVE_1,
  decoded,
  eventsOfKind,
  expectSuccess,
  fund,
  minimalPayout,
  ownerOf,
  revertCodeOf,
  sendCall,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

// An address with no account NFT at the fork block (eth_call exists() -> false; used only as a
// revert-case sender, never funded with account assets).
const NO_ACCOUNT = getAddress("0xF011F011F011F011F011F011F011F011F011F011");

describe.skipIf(!FORK_ENABLED)("fork: payout", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;
  let eurMin = 0n;
  let chfMin = 0n;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    eurMin = await minimalPayout(fork, arbitrum.tokens.EUR24.proxy);
    chfMin = await minimalPayout(fork, arbitrum.tokens.CHF24.proxy);
  }, 120_000);

  beforeEach(async () => {
    snapshot = await fork.testClient.snapshot();
  });

  afterEach(async () => {
    await fork.testClient.revert({ id: snapshot });
  });

  afterAll(() => {
    fork.stop();
  });

  test("clientPayout EUR24 at the on-chain minimum decodes with the L2-block txid", async () => {
    const call = payoutCall({ currency: "EUR24", amount: eurMin, contactId: "EA-00001156" });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const payouts = eventsOfKind(decoded(receipt), "payout");
    expect(payouts).toHaveLength(1);
    const event = required(payouts[0]);
    expect(event.currency).toBe("EUR24");
    expect(event.tokenId).toBe(LIVE_1);
    expect(event.sender).toBe(owner1);
    expect(event.payoutAccount).toBe(9102n);
    expect(event.amount).toBe(eurMin);
    expect(event.contactId).toBe("EA-00001156");
    // txid is `<tokenId>-<ArbSys.arbBlockNumber()>` — the L2 block the payout was mined in.
    expect(event.txid).toBe(`${LIVE_1}-${receipt.blockNumber}`);
  });

  test("clientPayoutRef EUR24 at the on-chain minimum decodes", async () => {
    const ref = `${LIVE_1}-854ee1ef-6fc3-4009-a10e-7c3be268e52c`;
    const call = payoutRefCall({
      currency: "EUR24",
      amount: eurMin,
      contactId: "EA-00001156",
      purposeId: 8n,
      ref,
      tokenId: LIVE_1,
    });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const payouts = eventsOfKind(decoded(receipt), "payout-ref");
    expect(payouts).toHaveLength(1);
    const event = required(payouts[0]);
    expect(event.ref).toBe(ref);
    expect(event.purposeId).toBe(8n);
    expect(event.txid).toBe(`${LIVE_1}-${receipt.blockNumber}`);
  });

  // Same shape as recorded tx 0xbe87…dea3 (tokenId 690333): `<id>-<uuid>` + NULs to length 45.
  test("clientPayoutRef with a NUL-padded ref survives byte for byte", async () => {
    const ref = `${LIVE_1}-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000`;
    const call = payoutRefCall({
      currency: "EUR24",
      amount: eurMin,
      contactId: "EA-00001156",
      purposeId: 8n,
      ref,
      tokenId: LIVE_1,
    });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const payouts = eventsOfKind(decoded(receipt), "payout-ref");
    expect(payouts).toHaveLength(1);
    expect(required(payouts[0]).ref).toBe(ref);
  });

  test("clientPayout CHF24 at the on-chain minimum after desk funding", async () => {
    expectSuccess(await fund(fork, arbitrum.tokens.CHF24.proxy, DESK, owner1, 5000n));
    const call = payoutCall({ currency: "CHF24", amount: chfMin, contactId: "SP" });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const payouts = eventsOfKind(decoded(receipt), "payout");
    expect(payouts).toHaveLength(1);
    expect(required(payouts[0]).currency).toBe("CHF24");
    expect(required(payouts[0]).amount).toBe(chfMin);
    expect(required(payouts[0]).txid).toBe(`${LIVE_1}-${receipt.blockNumber}`);
  });

  test("clientPayoutRef CHF24 at the on-chain minimum after desk funding", async () => {
    expectSuccess(await fund(fork, arbitrum.tokens.CHF24.proxy, DESK, owner1, 5000n));
    const ref = `${LIVE_1}-50fb0941-4f59-4a89-8735-dd78ba7d53a3`;
    const call = payoutRefCall({
      currency: "CHF24",
      amount: chfMin,
      contactId: "SP",
      purposeId: 0n,
      ref,
      tokenId: LIVE_1,
    });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const payouts = eventsOfKind(decoded(receipt), "payout-ref");
    expect(payouts).toHaveLength(1);
    expect(required(payouts[0]).currency).toBe("CHF24");
    expect(required(payouts[0]).ref).toBe(ref);
  });

  test("clientPayout one unit below the minimum reverts below-minimum", async () => {
    const call = payoutCall({ currency: "EUR24", amount: eurMin - 1n, contactId: "SP" });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("below-minimum");
  });

  // tokenOfOwnerByIndex on a sender with no NFT hits
  // "ERC721Enumerable: owner index out of bounds" -> no-account (§6.3).
  test("clientPayout from an address with no account NFT reverts no-account", async () => {
    const call = payoutCall({ currency: "EUR24", amount: eurMin, contactId: "SP" });
    await expect(revertCodeOf(fork, NO_ACCOUNT, call)).resolves.toBe("no-account");
  });
});
