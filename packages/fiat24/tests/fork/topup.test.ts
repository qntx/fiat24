import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { depositAbi } from "../../src/abi/index.ts";
import { approveCall, topUpCall } from "../../src/calls/index.ts";
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
  mintUsdc,
  ownerOf,
  pause,
  paused,
  revertCodeOf,
  sendCall,
  sendOk,
  startFork,
  unpause,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const USDC_5 = 5_000_000n; // minUsdcDepositAmount at the fork block
const USDC_10 = 10_000_000n;

describe.skipIf(!FORK_ENABLED)("fork: topup", () => {
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

  // The deposit contract is paused at the pinned block (verified in beforeAll below) — I22.
  test("deposit is paused at the fork block", async () => {
    await expect(paused(fork, arbitrum.deposit.proxy)).resolves.toBe(true);
  });

  // Fiat24CryptoDeposit.sol:213 `if(paused()) revert Fiat24CryptoDeposit__Paused()` -> unavailable.
  test("top-up while deposit is paused reverts unavailable", async () => {
    const call = topUpCall({ output: "EUR24", usdcAmount: USDC_5 });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("unavailable");
  });

  test("top-up USDC -> EUR24 succeeds after operator unpause", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    expectSuccess(await fund(fork, arbitrum.usdc, DESK, owner1, USDC_10));
    const approve = approveCall({ asset: "USDC", spender: "deposit", amount: USDC_10 });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      topUpCall({ output: "EUR24", usdcAmount: USDC_5 }),
    );
    expect(receipt.status).toBe("success");
    const topUps = eventsOfKind(decoded(receipt), "top-up");
    expect(topUps).toHaveLength(1);
    const event = required(topUps[0]);
    expect(event.via).toBe("usdc");
    expect(event.sender).toBe(owner1);
    expect(event.output).toBe("EUR24");
    expect(event.inputAmount).toBe(USDC_5);
    expect(event.outputAmount).toBeGreaterThan(0n);
  });

  test("top-up USDC -> USD24 succeeds after operator unpause", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    expectSuccess(await fund(fork, arbitrum.usdc, DESK, owner1, USDC_10));
    const approve = approveCall({ asset: "USDC", spender: "deposit", amount: USDC_10 });
    await sendOk(fork, owner1, approve);
    const receipt = await sendCall(
      fork,
      owner1,
      topUpCall({ output: "USD24", usdcAmount: USDC_5 }),
    );
    expect(receipt.status).toBe("success");
    const topUps = eventsOfKind(decoded(receipt), "top-up");
    expect(topUps).toHaveLength(1);
    expect(required(topUps[0]).output).toBe("USD24");
  });

  // 4.999999 USDC < minUsdcDepositAmount (5 USDC) ->
  // Fiat24CryptoDeposit__UsdcAmountLowerMinDepositAmount -> below-minimum.
  test("top-up one unit below the USDC minimum reverts below-minimum", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    expectSuccess(await fund(fork, arbitrum.usdc, DESK, owner1, USDC_10));
    const approve = approveCall({ asset: "USDC", spender: "deposit", amount: USDC_10 });
    await sendOk(fork, owner1, approve);
    const call = topUpCall({ output: "EUR24", usdcAmount: USDC_5 - 1n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("below-minimum");
  });

  // > maxUsdcDepositAmount (50,000 USDC) -> UsdcAmountHigherMaxDepositAmount -> above-maximum.
  // USDC is minted through the FiatToken minter path (masterMinter read at the fork block).
  test("top-up above the USDC maximum reverts above-maximum", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    const max = await fork.publicClient.readContract({
      address: arbitrum.deposit.proxy,
      abi: depositAbi,
      functionName: "maxUsdcDepositAmount",
    });
    const amount = max + 1n;
    await mintUsdc(fork, owner1, amount);
    const approve = approveCall({ asset: "USDC", spender: "deposit", amount });
    await sendOk(fork, owner1, approve);
    const call = topUpCall({ output: "EUR24", usdcAmount: amount });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("above-maximum");
  });

  // With USD24 (the token) paused, the USD24 fee leg inside depositTokenViaUsdc fails and
  // TransferHelper collapses it into "STF" -> contract-revert (§6.3).
  test("top-up to USD24 while USD24 is paused reverts contract-revert (STF)", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    expectSuccess(await pause(fork, arbitrum.tokens.USD24.proxy));
    expectSuccess(await fund(fork, arbitrum.usdc, DESK, owner1, USDC_10));
    const approve = approveCall({ asset: "USDC", spender: "deposit", amount: USDC_10 });
    await sendOk(fork, owner1, approve);
    const call = topUpCall({ output: "USD24", usdcAmount: USDC_5 });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("contract-revert");
  });
});
