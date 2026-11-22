import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { priceListAbi } from "../../src/abi/index.ts";
import { approveCall, mintAccountCall, mintAccountWithEthCall } from "../../src/calls/index.ts";
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
  mintPriceWei,
  ownerOf,
  pause,
  revertCodeOf,
  sendCall,
  sendOk,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

// Deterministic fresh addresses (no `historicOwnership` at the fork block — required by
// `_mintAllowed`, Fiat24Account.sol:121). Distinct per test so no account NFT accumulates.
const FRESH_ETH = getAddress("0x10000000000000000000000000000000000000E7");
const FRESH_F24 = getAddress("0x10000000000000000000000000000000000000F2");
const FRESH_TAKEN = getAddress("0x10000000000000000000000000000000000000AA");
const FRESH_PAUSED = getAddress("0x10000000000000000000000000000000000000AB");
const ZERO = getAddress("0x0000000000000000000000000000000000000000");

// Free 6-digit mint ids inside the standard client range (`maxDigitForSale` = 6 at the fork
// block; `exists()` verified false for each at 526365924; `getPrice` = 100 F24).
const MINT_ID_ETH = 734_519n;
const MINT_ID_F24 = 734_521n;
const MINT_ID_PAUSED = 734_525n;

describe.skipIf(!FORK_ENABLED)("fork: mint", () => {
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

  test("mintByClientWithETH at the §8.3 price succeeds and decodes account-transfer", async () => {
    const value = await mintPriceWei(fork, MINT_ID_ETH);
    const receipt = await sendCall(
      fork,
      FRESH_ETH,
      mintAccountWithEthCall({ tokenId: MINT_ID_ETH, value }),
    );
    expect(receipt.status).toBe("success");
    const mints = eventsOfKind(decoded(receipt), "account-transfer");
    expect(mints).toHaveLength(1);
    const event = required(mints[0]);
    expect(event.from).toBe(ZERO);
    expect(event.to).toBe(FRESH_ETH);
    expect(event.tokenId).toBe(MINT_ID_ETH);
    await expect(ownerOf(fork, MINT_ID_ETH)).resolves.toBe(FRESH_ETH);
  });

  // Fiat24Account.sol:108 "Not sufficient msg.value for F24 purchase" -> quote-changed (§6.3).
  test("mintByClientWithETH one wei below the price reverts quote-changed", async () => {
    const value = await mintPriceWei(fork, MINT_ID_ETH);
    const call = mintAccountWithEthCall({ tokenId: MINT_ID_ETH, value: value - 1n });
    await expect(revertCodeOf(fork, FRESH_ETH, call)).resolves.toBe("quote-changed");
  });

  // OZ ERC721 `_mint` on an existing id -> "ERC721: token already minted" -> account-id-taken.
  test("mintByClientWithETH a taken id reverts account-id-taken", async () => {
    const call = mintAccountWithEthCall({ tokenId: LIVE_1, value: 10n ** 16n });
    await expect(revertCodeOf(fork, FRESH_TAKEN, call)).resolves.toBe("account-id-taken");
  });

  // `_mintAllowed` refuses an address that owns/owned an NFT (Fiat24Account.sol:121)
  // -> "Not allowed. The address has/had another NFT." -> address-ineligible.
  test("mintByClientWithETH from an address that already has an NFT reverts address-ineligible", async () => {
    const call = mintAccountWithEthCall({ tokenId: MINT_ID_ETH, value: 10n ** 16n });
    await expect(revertCodeOf(fork, owner1, call)).resolves.toBe("address-ineligible");
  });

  // Mint while the account contract is paused hits "Account transfers suspended"
  // (Fiat24Account.sol:412) -> unavailable.
  test("mintByClientWithETH while the account contract is paused reverts unavailable", async () => {
    expectSuccess(await pause(fork, arbitrum.account.proxy));
    const call = mintAccountWithEthCall({ tokenId: MINT_ID_PAUSED, value: 10n ** 16n });
    await expect(revertCodeOf(fork, FRESH_PAUSED, call)).resolves.toBe("unavailable");
  });

  test("mintByClient with F24 from a desk-funded fresh address succeeds", async () => {
    const price = await fork.publicClient.readContract({
      address: arbitrum.priceList.proxy,
      abi: priceListAbi,
      functionName: "getPrice",
      args: [MINT_ID_F24],
    });
    expectSuccess(await fund(fork, arbitrum.f24.address, DESK, FRESH_F24, price));
    const approve = approveCall({ asset: "F24", spender: "account", amount: price });
    await sendOk(fork, FRESH_F24, approve);
    const receipt = await sendCall(fork, FRESH_F24, mintAccountCall({ tokenId: MINT_ID_F24 }));
    expect(receipt.status).toBe("success");
    const mints = eventsOfKind(decoded(receipt), "account-transfer");
    expect(mints).toHaveLength(1);
    expect(required(mints[0]).to).toBe(FRESH_F24);
    expect(required(mints[0]).tokenId).toBe(MINT_ID_F24);
    await expect(ownerOf(fork, MINT_ID_F24)).resolves.toBe(FRESH_F24);
  });
});
