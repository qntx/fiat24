import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { transferCall, transferToAccountCall } from "../../src/calls/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { throwsCode, required } from "../helpers.ts";
import {
  FORK_ENABLED,
  LIVE_1,
  LIVE_2,
  decoded,
  eventsOfKind,
  expectSuccess,
  ownerOf,
  pause,
  revertCodeOf,
  sendCall,
  setClientLimit,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

describe.skipIf(!FORK_ENABLED)("fork: transfer", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;
  let owner2: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, LIVE_1);
    owner2 = await ownerOf(fork, LIVE_2);
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

  test("Live -> Live by address succeeds and decodes", async () => {
    const call = transferCall({ currency: "EUR24", to: owner2, amount: 100n });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const transfers = eventsOfKind(decoded(receipt), "transfer");
    expect(transfers).toHaveLength(1);
    const event = required(transfers[0]);
    expect(event.currency).toBe("EUR24");
    expect(event.from).toBe(owner1);
    expect(event.to).toBe(owner2);
    expect(event.amount).toBe(100n);
  });

  test("Live -> Live by account id succeeds and decodes", async () => {
    const call = transferToAccountCall({ currency: "EUR24", tokenId: LIVE_2, amount: 50n });
    const receipt = await sendCall(fork, owner1, call);
    expect(receipt.status).toBe("success");
    const transfers = eventsOfKind(decoded(receipt), "transfer");
    expect(transfers).toHaveLength(1);
    expect(required(transfers[0]).to).toBe(owner2);
    expect(required(transfers[0]).amount).toBe(50n);
  });

  test("transfer above the client limit reverts transfer-not-allowed", async () => {
    expectSuccess(await setClientLimit(fork, LIVE_1, 0n));
    const call = transferCall({ currency: "EUR24", to: owner2, amount: 1n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("transfer-not-allowed");
  });

  // The contract checks `balanceOf(from) < amount` inside `tokenTransferAllowed` and reverts
  // "Transfer not allowed for various reason" (Fiat24Token.sol:169,423) — §6.3 maps it to
  // transfer-not-allowed, never to insufficient-balance on this path.
  test("transfer above the balance reverts transfer-not-allowed", async () => {
    const call = transferCall({ currency: "EUR24", to: owner2, amount: 88_367n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("transfer-not-allowed");
  });

  test("transfer while the token is paused reverts unavailable", async () => {
    expectSuccess(await pause(fork, arbitrum.tokens.EUR24.proxy));
    const call = transferCall({ currency: "EUR24", to: owner2, amount: 1n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("unavailable");
  });

  test("transfer while the account contract is paused reverts unavailable", async () => {
    expectSuccess(await pause(fork, arbitrum.account.proxy));
    const call = transferCall({ currency: "EUR24", to: owner2, amount: 1n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("unavailable");
  });

  test("transferToAccount to an internal id is refused locally (I12)", () => {
    expect(
      throwsCode(
        () => transferToAccountCall({ currency: "EUR24", tokenId: 9100n, amount: 1n }),
        new Set(["internal-account"]),
      ),
    ).toBe(true);
  });
});
