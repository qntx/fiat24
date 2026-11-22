import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { getAvailability, getTopUpQuote, verifyDeployment } from "../../src/chain/index.ts";
import { CURRENCIES } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import {
  FORK_BLOCK,
  FORK_ENABLED,
  castCall,
  castStorage,
  expectSuccess,
  ownerOf,
  pause,
  startFork,
  unpause,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const PIN = FORK_BLOCK.toString();
const ACCOUNT = arbitrum.account.proxy;
const DEPOSIT = arbitrum.deposit.proxy;

// Slot 359 (0x167) of the account proxy: bytes 0-19 little-endian hold the priceList address,
// byte 20 is f24IsActive — chars 24-25 of the 0x-prefixed 64-char word.
const SLOT_359 = "0x167";

function setByte20(word: string, value: string): Hex {
  return `0x${word.slice(2, 24)}${value}${word.slice(26)}` as Hex;
}

async function castPaused(fork: Fork, address: Address, block = PIN): Promise<boolean> {
  return (await castCall(fork, [address, "paused()(bool)"], block)) === "true";
}

describe.skipIf(!FORK_ENABLED)("fork: availability", () => {
  let fork: Fork;
  let snapshot: Hex;
  let owner1: Address;

  beforeAll(async () => {
    fork = await startFork();
    owner1 = await ownerOf(fork, 350273n);
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

  test("getAvailability at the pin matches cast", async () => {
    const a = await getAvailability(fork.publicClient, { blockNumber: FORK_BLOCK });
    expect(a.account.paused).toBe(await castPaused(fork, ACCOUNT));
    const tokenPaused = await Promise.all(
      CURRENCIES.map(async (currency) => castPaused(fork, arbitrum.tokens[currency].proxy)),
    );
    expect(CURRENCIES.map((currency) => a.tokens[currency].paused)).toStrictEqual(tokenPaused);
    expect(a.deposit.paused).toBe(await castPaused(fork, DEPOSIT));
    expect(a.card.paused).toBe(await castPaused(fork, arbitrum.card.proxy));
    expect(a.f24Sales.paused).toBe(await castPaused(fork, arbitrum.f24Sales.proxy));
    expect(a.deposit.marketClosed).toBe(
      (await castCall(fork, [DEPOSIT, "marketClosed()(bool)"], PIN)) === "true",
    );
    expect(a.account.maxDigitForSale).toBe(
      Number(await castCall(fork, [ACCOUNT, "maxDigitForSale()(uint256)"], PIN)),
    );
    const word = await castStorage(fork, ACCOUNT, SLOT_359, PIN);
    // slotByte(word, 20): chars 24-25 of the prefixed word (byte 20 little-endian).
    expect(a.account.f24Active).toBe(word.slice(24, 26) !== "00");
    // §11.2 facts at the pin: deposit paused + market closed, everything else live.
    expect(a.deposit.paused).toBe(true);
    expect(a.deposit.marketClosed).toBe(true);
    expect(a.account.paused).toBe(false);
    expect(a.card.paused).toBe(false);
    expect(a.f24Sales.paused).toBe(false);
    expect(a.account.f24Active).toBe(true);
    expect(a.account.maxDigitForSale).toBe(6);
    expect(CURRENCIES.map((currency) => a.tokens[currency].paused)).toStrictEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("pause() on account, one token, card and f24Sales flips each flag", async () => {
    expectSuccess(await pause(fork, ACCOUNT));
    expectSuccess(await pause(fork, arbitrum.tokens.EUR24.proxy));
    expectSuccess(await pause(fork, arbitrum.card.proxy));
    expectSuccess(await pause(fork, arbitrum.f24Sales.proxy));
    const a = await getAvailability(fork.publicClient, {});
    expect(a.account.paused).toBe(await castPaused(fork, ACCOUNT, "latest"));
    expect(a.account.paused).toBe(true);
    expect(a.tokens.EUR24.paused).toBe(true);
    expect(a.card.paused).toBe(true);
    expect(a.f24Sales.paused).toBe(true);
    expect(a.tokens.USD24.paused).toBe(false);
  });

  test("unpause() on deposit flips deposit.paused and getTopUpQuote.paused", async () => {
    const pinned = await getTopUpQuote(fork.publicClient, {
      owner: owner1,
      output: "EUR24",
      usdcAmount: 5_000_000n,
      blockNumber: FORK_BLOCK,
    });
    expect(pinned.paused).toBe(true);
    expectSuccess(await unpause(fork, DEPOSIT));
    const a = await getAvailability(fork.publicClient, {});
    expect(a.deposit.paused).toBe(await castPaused(fork, DEPOSIT, "latest"));
    expect(a.deposit.paused).toBe(false);
    const after = await getTopUpQuote(fork.publicClient, {
      owner: owner1,
      output: "EUR24",
      usdcAmount: 5_000_000n,
    });
    expect(after.paused).toBe(false);
  });

  test("clearing slot 359 byte 20 flips f24Active but is no drift", async () => {
    const word = await castStorage(fork, ACCOUNT, SLOT_359, "latest");
    await fork.testClient.setStorageAt({
      address: ACCOUNT,
      index: SLOT_359,
      value: setByte20(word, "00"),
    });
    const a = await getAvailability(fork.publicClient, {});
    expect(a.account.f24Active).toBe(false);
    const check = await verifyDeployment(fork.publicClient, {});
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
  });
});
