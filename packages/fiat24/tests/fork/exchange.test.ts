import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { approveCall, exchangeCall } from "../../src/calls/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  DESK,
  FORK_ENABLED,
  LIVE_1,
  decoded,
  eventsOfKind,
  exactOutInput,
  expectSuccess,
  fund,
  ownerOf,
  revertCodeOf,
  sendCall,
  sendOk,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

// [from, to, amount] — USD24 balance is 2 units at the fork block, CHF24 is 0 (funded separately).
const PAIRS: ReadonlyArray<readonly [Currency, Currency, bigint]> = [
  ["EUR24", "USD24", 1000n],
  ["USD24", "EUR24", 1n],
  ["CNH24", "USD24", 500n],
];

describe.skipIf(!FORK_ENABLED)("fork: exchange", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
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

  test.each(PAIRS)("exact-in %s -> %s succeeds and decodes", async (from, to, amount) => {
    const approve = approveCall({ asset: from, spender: "deposit", amount });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      exchangeCall({ side: "exact-in", from, to, amount }),
    );
    expect(receipt.status).toBe("success");
    const exchanges = eventsOfKind(decoded(receipt), "exchange");
    expect(exchanges).toHaveLength(1);
    const event = required(exchanges[0]);
    expect(event.side).toBe("exact-in");
    expect(event.sender).toBe(owner1);
    expect(event.input).toBe(from);
    expect(event.output).toBe(to);
    expect(event.inputAmount).toBe(amount);
  });

  test.each(PAIRS)("exact-out %s -> %s succeeds and decodes", async (from, to, amount) => {
    const approve = approveCall({ asset: from, spender: "deposit", amount: 1_000_000_000n });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      exchangeCall({ side: "exact-out", from, to, amount }),
    );
    expect(receipt.status).toBe("success");
    const exchanges = eventsOfKind(decoded(receipt), "exchange");
    expect(exchanges).toHaveLength(1);
    const event = required(exchanges[0]);
    expect(event.side).toBe("exact-out");
    expect(event.input).toBe(from);
    expect(event.output).toBe(to);
    expect(event.outputAmount).toBe(amount);
  });

  test("exact-in CHF24 -> USD24 after desk funding", async () => {
    expectSuccess(await fund(fork, arbitrum.tokens.CHF24.proxy, DESK, owner1, 5000n));
    const approve = approveCall({ asset: "CHF24", spender: "deposit", amount: 1000n });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      exchangeCall({ side: "exact-in", from: "CHF24", to: "USD24", amount: 1000n }),
    );
    expect(receipt.status).toBe("success");
    const exchanges = eventsOfKind(decoded(receipt), "exchange");
    expect(exchanges).toHaveLength(1);
    expect(required(exchanges[0]).input).toBe("CHF24");
    expect(required(exchanges[0]).output).toBe("USD24");
  });

  test("exact-out CHF24 -> USD24 after desk funding", async () => {
    expectSuccess(await fund(fork, arbitrum.tokens.CHF24.proxy, DESK, owner1, 5000n));
    const approve = approveCall({ asset: "CHF24", spender: "deposit", amount: 1_000_000n });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      exchangeCall({ side: "exact-out", from: "CHF24", to: "USD24", amount: 100n }),
    );
    expect(receipt.status).toBe("success");
    const exchanges = eventsOfKind(decoded(receipt), "exchange");
    expect(exchanges).toHaveLength(1);
    expect(required(exchanges[0]).outputAmount).toBe(100n);
  });

  // SPEC §8.3: exact-out EUR24->USD24 of 1 computes inputAmount = 0 -> ValueZero -> below-minimum.
  test("exact-out amount 1 reverts below-minimum (ValueZero)", async () => {
    const call = exchangeCall({ side: "exact-out", from: "EUR24", to: "USD24", amount: 1n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("below-minimum");
  });

  // SPEC §8.3: exact-in EUR24->USD24 of 1 computes outputAmount = 0 and the contract accepts it.
  test("exact-in amount 1 succeeds paying 0", async () => {
    const approve = approveCall({ asset: "EUR24", spender: "deposit", amount: 1n });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      exchangeCall({ side: "exact-in", from: "EUR24", to: "USD24", amount: 1n }),
    );
    expect(receipt.status).toBe("success");
    const exchanges = eventsOfKind(decoded(receipt), "exchange");
    expect(exchanges).toHaveLength(1);
    expect(required(exchanges[0]).outputAmount).toBe(0n);
  });

  // The input leg is safeTransferFrom; an allowance one unit below the computed input makes
  // TransferHelper collapse the ERC20 allowance revert into "STF" -> contract-revert (§6.3).
  test("exact-out with allowance one below the required input reverts contract-revert (STF)", async () => {
    const input = await exactOutInput(
      fork,
      arbitrum.tokens.EUR24.proxy,
      arbitrum.tokens.USD24.proxy,
      1000n,
    );
    const approve = approveCall({ asset: "EUR24", spender: "deposit", amount: input - 1n });
    await sendOk(fork, owner1, approve);
    const call = exchangeCall({ side: "exact-out", from: "EUR24", to: "USD24", amount: 1000n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("contract-revert");
  });
});
