import { encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { accountAbi, tokenAbi } from "../../src/abi/index.ts";
import { transferCall, transferToAccountCall } from "../../src/calls/index.ts";
import { checkTransfer } from "../../src/chain/index.ts";
import type { TransferCheck } from "../../src/chain/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { Fiat24Error } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { throwsCode, required } from "../helpers.ts";
import {
  FORK_ENABLED,
  LIVE_1,
  LIVE_2,
  castCall,
  changeClientStatus,
  decoded,
  eventsOfKind,
  expectSuccess,
  ownerOf,
  pause,
  revertCodeOf,
  sendAs,
  sendCall,
  setClientLimit,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const FRESH: Address = "0x10000000000000000000000000000000000000e7";
const EUR24 = arbitrum.tokens.EUR24.proxy;

type CheckArgs = {
  readonly to: { address: Address } | { tokenId: bigint };
  readonly amount?: bigint;
  readonly currency?: Currency;
};

async function check(fork: Fork, owner: Address, args: CheckArgs): Promise<TransferCheck> {
  return checkTransfer(fork.publicClient, {
    from: owner,
    to: args.to,
    currency: args.currency ?? "EUR24",
    amount: args.amount ?? 100n,
  });
}

/** The Fiat24Error checkTransfer throws; throws when it resolves instead. */
async function checkError(fork: Fork, owner: Address, args: CheckArgs): Promise<Fiat24Error> {
  try {
    await check(fork, owner, args);
  } catch (error) {
    if (error instanceof Fiat24Error) {
      return error;
    }
    throw error;
  }
  throw new Error("checkTransfer unexpectedly succeeded");
}

/** The contract's own `tokenTransferAllowed` verdict, via cast. */
async function allowed(
  fork: Fork,
  token: Address,
  from: Address,
  to: Address,
  amount: bigint,
): Promise<string> {
  return castCall(
    fork,
    [token, "tokenTransferAllowed(address,address,uint256)(bool)", from, to, String(amount)],
    "latest",
  );
}

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

  test("checkTransfer Live -> Live by address and by id ok (recipientTokenId = LIVE_2)", async () => {
    const [byAddress, byId] = await Promise.all([
      check(fork, owner1, { to: { address: owner2 } }),
      check(fork, owner1, { to: { tokenId: LIVE_2 } }),
    ]);
    expect(byAddress.recipient.toLowerCase()).toBe(owner2.toLowerCase());
    expect(byAddress.recipientTokenId).toBe(LIVE_2);
    expect(byId.recipient.toLowerCase()).toBe(owner2.toLowerCase());
    expect(byId.recipientTokenId).toBe(LIVE_2);
  });

  test("checkTransfer internal by address and by id gives internal-account (I12)", async () => {
    const desk = await ownerOf(fork, 9100n);
    const [byAddress, byId] = await Promise.all([
      checkError(fork, owner1, { to: { address: desk } }),
      checkError(fork, owner1, { to: { tokenId: 9100n } }),
    ]);
    expect(byAddress.code).toBe("internal-account");
    expect(byId.code).toBe("internal-account");
  });

  test("checkTransfer walk-in refused: fresh recipient gives recipient-not-live, contract allows", async () => {
    const error = await checkError(fork, owner1, { to: { address: FRESH } });
    expect(error.code).toBe("recipient-not-live");
    // I18 — the contract would happily take the transfer; the SDK's refusal is its own §8.4 step 3.
    await expect(allowed(fork, EUR24, owner1, FRESH, 100n)).resolves.toBe("true");
  });

  test("checkTransfer stale recipient (I17): NFT moved but historicOwnership kept", async () => {
    // owner2 transfers the LIVE_2 NFT to a fresh address — Fiat24Account.sol:185-190 keeps
    // historicOwnership[owner2] = LIVE_2 while ownerOf(LIVE_2) is now FRESH.
    expectSuccess(
      await sendAs(
        fork,
        owner2,
        arbitrum.account.proxy,
        encodeFunctionData({
          abi: accountAbi,
          functionName: "transferFrom",
          args: [owner2, FRESH, LIVE_2],
        }),
      ),
    );
    await expect(
      fork.publicClient.readContract({
        address: arbitrum.account.proxy,
        abi: accountAbi,
        functionName: "historicOwnership",
        args: [owner2],
      }),
    ).resolves.toBe(LIVE_2);
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("stale-recipient");
    await expect(allowed(fork, EUR24, owner1, owner2, 100n)).resolves.toBe("true");
  });

  test("checkTransfer limit-exceeded after setClientLimit 0", async () => {
    expectSuccess(await setClientLimit(fork, LIVE_1, 0n));
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("limit-exceeded");
  });

  test("checkTransfer insufficient-balance at balance + 1", async () => {
    const balance = await fork.publicClient.readContract({
      address: EUR24,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [owner1],
    });
    const error = await checkError(fork, owner1, {
      to: { address: owner2 },
      amount: balance + 1n,
    });
    expect(error.code).toBe("insufficient-balance");
  });

  test("checkTransfer paused token gives unavailable token-paused", async () => {
    expectSuccess(await pause(fork, EUR24));
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("unavailable");
    expect(error.detail.reason).toBe("token-paused");
  });

  test("checkTransfer paused account gives unavailable account-paused", async () => {
    expectSuccess(await pause(fork, arbitrum.account.proxy));
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("unavailable");
    expect(error.detail.reason).toBe("account-paused");
  });

  test("checkTransfer SoftBlocked sender gives not-live", async () => {
    expectSuccess(await changeClientStatus(fork, LIVE_1, 1));
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("not-live");
  });

  test("checkTransfer Blocked recipient gives recipient-not-live", async () => {
    expectSuccess(await changeClientStatus(fork, LIVE_2, 3));
    const error = await checkError(fork, owner1, { to: { address: owner2 } });
    expect(error.code).toBe("recipient-not-live");
  });

  test("checkTransfer SoftBlocked recipient is accepted", async () => {
    expectSuccess(await changeClientStatus(fork, LIVE_2, 1));
    const ok = await check(fork, owner1, { to: { address: owner2 } });
    expect(ok.recipientTokenId).toBe(LIVE_2);
  });
});
