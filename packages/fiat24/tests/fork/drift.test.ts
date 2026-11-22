import type { Address, Hex, PublicClient } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  approveCall,
  exchangeCall,
  mintAccountCall,
  mintAccountWithEthCall,
  payoutCall,
  payoutRefCall,
  topUpCall,
  transferCall,
  transferToAccountCall,
} from "../../src/calls/index.ts";
import type { Fiat24Call } from "../../src/calls/index.ts";
import { assertDeployment, verifyDeployment } from "../../src/chain/index.ts";
import type { DriftField, Fiat24ErrorDetail } from "../../src/core/errors.ts";
import type { ContractName } from "../../src/core/index.ts";
import { isFiat24Error } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  FORK_BLOCK,
  FORK_ENABLED,
  OPERATOR,
  castStorage,
  expectSuccess,
  pause,
  startFork,
  unpause,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

const FRESH: Address = "0x10000000000000000000000000000000000000e7";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
// Account proxy packed slots (Fiat24Account storageLayout): 358 = f24 address in bytes 2-21 with
// the digit flags in bytes 0-1; 359 = priceList in bytes 0-19 with f24IsActive in byte 20; 364 =
// F24SalesAddress. Deposit slot 208 = usdc. ProxyAdmin stores owner in slot 0.
const SLOT_358 = "0x166" as Hex;
const SLOT_359 = "0x167" as Hex;
const SLOT_364 = "0x16c" as Hex;
const SLOT_USDC = "0xd0" as Hex;
const SLOT_OWNER = "0x0" as Hex;

const PROXIES: ReadonlyArray<readonly [ContractName, Address]> = [
  ["account", arbitrum.account.proxy],
  ["USD24", arbitrum.tokens.USD24.proxy],
  ["EUR24", arbitrum.tokens.EUR24.proxy],
  ["CHF24", arbitrum.tokens.CHF24.proxy],
  ["CNH24", arbitrum.tokens.CNH24.proxy],
  ["deposit", arbitrum.deposit.proxy],
  ["card", arbitrum.card.proxy],
  ["priceList", arbitrum.priceList.proxy],
  ["f24Sales", arbitrum.f24Sales.proxy],
];

/** Every §6.1 builder path — the set assertDeployment must guard (I5). */
const PATHS: ReadonlyArray<readonly [string, Fiat24Call]> = [
  ["transfer", transferCall({ currency: "EUR24", to: FRESH, amount: 1n })],
  ["transferToAccount", transferToAccountCall({ currency: "EUR24", tokenId: 469709n, amount: 1n })],
  ["approve cash", approveCall({ asset: "EUR24", spender: "card", amount: 1n })],
  ["approve usdc", approveCall({ asset: "USDC", spender: "deposit", amount: 1n })],
  ["approve f24", approveCall({ asset: "F24", spender: "account", amount: 1n })],
  ["exchange", exchangeCall({ side: "exact-in", from: "EUR24", to: "USD24", amount: 1n })],
  ["top-up", topUpCall({ output: "EUR24", usdcAmount: 1_000_000n })],
  ["payout", payoutCall({ currency: "EUR24", amount: 100n, contactId: "CH" })],
  [
    "payout-ref",
    payoutRefCall({
      currency: "EUR24",
      amount: 100n,
      contactId: "CH",
      purposeId: 1n,
      ref: "350273-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
      tokenId: 350273n,
    }),
  ],
  ["mint", mintAccountCall({ tokenId: 734519n })],
  ["mint-eth", mintAccountWithEthCall({ tokenId: 734519n, value: 1n })],
];

type Mutation = {
  readonly contract: ContractName;
  readonly field: DriftField;
  readonly address: Address;
  readonly slot: Hex;
  readonly mutate: (word: string) => Hex;
  readonly verify: ReadonlyArray<ContractName>;
};

const MUTATIONS: ReadonlyArray<Mutation> = [
  ...PROXIES.flatMap(([contract, proxy]): Mutation[] => [
    {
      contract,
      field: "implementation",
      address: proxy,
      slot: IMPL_SLOT,
      mutate: (word) => withLowBytes(word, 20, FRESH),
      verify: [contract],
    },
    {
      contract,
      field: "admin",
      address: proxy,
      slot: ADMIN_SLOT,
      mutate: (word) => withLowBytes(word, 20, FRESH),
      verify: [contract],
    },
  ]),
  {
    contract: "account",
    field: "priceList",
    address: arbitrum.account.proxy,
    slot: SLOT_359,
    mutate: (word) => withHexRange(word, 24, 64, FRESH.slice(2)),
    verify: ["account"],
  },
  {
    contract: "account",
    field: "f24",
    address: arbitrum.account.proxy,
    slot: SLOT_358,
    mutate: (word) => withHexRange(word, 20, 60, FRESH.slice(2)),
    verify: ["account"],
  },
  {
    contract: "account",
    field: "f24Sales",
    address: arbitrum.account.proxy,
    slot: SLOT_364,
    mutate: (word) => withLowBytes(word, 20, FRESH),
    verify: ["account"],
  },
  {
    contract: "deposit",
    field: "usdc",
    address: arbitrum.deposit.proxy,
    slot: SLOT_USDC,
    mutate: (word) => withLowBytes(word, 20, FRESH),
    verify: ["deposit"],
  },
];

/** `word` with the low `bytes` bytes (rightmost) replaced by `replacement`'s tail. */
function withLowBytes(word: string, bytes: number, replacement: Address): Hex {
  const keep = 64 - 2 * bytes;
  return `0x${word.slice(2, 2 + keep)}${replacement.slice(2).slice(-2 * bytes)}` as Hex;
}

/** `word` with hex chars `lo..hi` (of the 64-char body) replaced. */
function withHexRange(word: string, lo: number, hi: number, fill: string): Hex {
  return `0x${word.slice(2, 2 + lo)}${fill}${word.slice(2 + hi)}` as Hex;
}

/** `word` with slot-359 byte 20 (chars 24-25 of the prefixed word) toggled between 00 and 01. */
function flipByte20(word: string): Hex {
  return `0x${word.slice(2, 24)}${word.slice(24, 26) === "00" ? "01" : "00"}${word.slice(26)}` as Hex;
}

async function setWord(fork: Fork, address: Address, slot: Hex, value: Hex): Promise<void> {
  await fork.testClient.setStorageAt({ address, index: slot, value });
}

/** The thrown error's `{contract, field}` detail; throws unless the code is contract-changed. */
async function contractChanged(
  client: PublicClient,
  contracts: ReadonlyArray<ContractName>,
): Promise<Fiat24ErrorDetail> {
  const error = await assertDeployment(client, { contracts }).then(
    () => undefined,
    (error_: unknown) => error_,
  );
  if (!isFiat24Error(error) || error.code !== "contract-changed") {
    throw new Error(`expected contract-changed, got ${String(error)}`);
  }
  return error.detail;
}

describe.skipIf(!FORK_ENABLED)("fork: drift", () => {
  let fork: Fork;
  let snapshot: Hex;

  beforeAll(async () => {
    fork = await startFork();
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

  test("passes on the fresh fork for every builder path and the default list", async () => {
    const check = await verifyDeployment(fork.publicClient, { blockNumber: FORK_BLOCK });
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
    expect(check.proxyAdminOwner.toLowerCase()).toBe(OPERATOR.toLowerCase());
    await Promise.all(
      PATHS.map(async ([, call]) =>
        expect(
          assertDeployment(fork.publicClient, {
            contracts: call.contracts,
            blockNumber: FORK_BLOCK,
          }),
        ).resolves.toBe(FORK_BLOCK),
      ),
    );
  });

  test("passes after impersonated set-up transactions", async () => {
    expectSuccess(await unpause(fork, arbitrum.deposit.proxy));
    expectSuccess(await pause(fork, arbitrum.tokens.EUR24.proxy));
    expectSuccess(await unpause(fork, arbitrum.tokens.EUR24.proxy));
    const check = await verifyDeployment(fork.publicClient, {});
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
    await Promise.all(
      PATHS.map(async ([, call]) =>
        expect(
          assertDeployment(fork.publicClient, { contracts: call.contracts }),
        ).resolves.toBeGreaterThanOrEqual(FORK_BLOCK),
      ),
    );
  });

  test.each(MUTATIONS)("$contract $field drift ⇒ contract-changed", async (m) => {
    const containing = PATHS.filter(([, call]) => call.contracts.includes(m.contract));
    const excluding = PATHS.filter(([, call]) => !call.contracts.includes(m.contract));

    const word = await castStorage(fork, m.address, m.slot, "latest");
    await setWord(fork, m.address, m.slot, m.mutate(word));

    const check = await verifyDeployment(fork.publicClient, { contracts: m.verify });
    expect(check.ok).toBe(false);
    expect(check.drift).toHaveLength(1);
    const drift = required(check.drift[0]);
    expect(drift.contract).toBe(m.contract);
    expect(drift.field).toBe(m.field);
    expect(drift.actual.toLowerCase()).toBe(FRESH.toLowerCase());

    // Every builder path touching the contract must refuse; paths without it still pass.
    const details = await Promise.all(
      containing.map(async ([, call]) => contractChanged(fork.publicClient, call.contracts)),
    );
    expect(details.map((d) => ({ contract: d.contract, field: d.field }))).toStrictEqual(
      containing.map(() => ({ contract: m.contract, field: m.field })),
    );
    await Promise.all(
      excluding.map(async ([, call]) =>
        expect(
          assertDeployment(fork.publicClient, { contracts: call.contracts }),
        ).resolves.toBeGreaterThan(0n),
      ),
    );
  });

  test("slot 359 byte 20 alone (f24IsActive) is no drift", async () => {
    const word = await castStorage(fork, arbitrum.account.proxy, SLOT_359, "latest");
    await setWord(fork, arbitrum.account.proxy, SLOT_359, flipByte20(word));
    const check = await verifyDeployment(fork.publicClient, { contracts: ["account"] });
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
  });

  test("slot 358 bytes 0-1 alone (digit flags) is no drift", async () => {
    const word = await castStorage(fork, arbitrum.account.proxy, SLOT_358, "latest");
    // Bytes 0-1 are the most significant — body chars 0-3.
    const flipped = `0xffff${word.slice(6)}` as Hex;
    await setWord(fork, arbitrum.account.proxy, SLOT_358, flipped);
    const check = await verifyDeployment(fork.publicClient, { contracts: ["account"] });
    expect(check.ok).toBe(true);
    expect(check.drift).toStrictEqual([]);
  });

  test("ProxyAdmin owner change reports ownerChanged, never drift", async () => {
    // Slot 0 confirmed by cast storage at the pin (SPEC §11.2: owner = OPERATOR).
    const word0 = await castStorage(fork, arbitrum.proxyAdmin.address, SLOT_OWNER, "latest");
    expect(word0.slice(-40).toLowerCase()).toBe(OPERATOR.slice(2).toLowerCase());
    const check0 = await verifyDeployment(fork.publicClient, {});
    expect(check0.ok).toBe(true);
    expect(check0.ownerChanged).toBe(false);

    const word = await castStorage(fork, arbitrum.proxyAdmin.address, SLOT_OWNER, "latest");
    await setWord(fork, arbitrum.proxyAdmin.address, SLOT_OWNER, withLowBytes(word, 20, FRESH));
    const check = await verifyDeployment(fork.publicClient, {});
    expect(check.ok).toBe(true);
    expect(check.ownerChanged).toBe(true);
    expect(check.proxyAdminOwner.toLowerCase()).toBe(FRESH.toLowerCase());
    expect(check.drift).toStrictEqual([]);
  });
});
