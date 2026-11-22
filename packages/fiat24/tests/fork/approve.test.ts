import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { approveCall } from "../../src/calls/index.ts";
import type { ApprovalSpender, Asset } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  FORK_BLOCK,
  FORK_ENABLED,
  LIVE_1,
  castCall,
  castUint,
  decoded,
  eventsOfKind,
  ownerOf,
  sendCall,
  sendOk,
  startFork,
} from "./harness.ts";
import type { Fork } from "./harness.ts";

// §6.1 allowed pairs: cash -> card/deposit (in the §7.1 decoded set), USDC -> deposit and
// F24 -> account (plain ERC-20 tokens whose Approval logs are not in the decoded set).
const CASH_PAIRS: ReadonlyArray<readonly [Asset, ApprovalSpender]> = [
  ["USD24", "card"],
  ["USD24", "deposit"],
  ["EUR24", "card"],
  ["EUR24", "deposit"],
  ["CHF24", "card"],
  ["CHF24", "deposit"],
  ["CNH24", "card"],
  ["CNH24", "deposit"],
];

const OTHER_PAIRS: ReadonlyArray<readonly [Asset, ApprovalSpender]> = [
  ["USDC", "deposit"],
  ["F24", "account"],
];

const SPENDER_ADDR: Record<ApprovalSpender, Address> = {
  card: arbitrum.card.proxy,
  deposit: arbitrum.deposit.proxy,
  account: arbitrum.account.proxy,
};

const PIN = FORK_BLOCK.toString();

// SPEC §4.3 total supplies at the pinned fork block — viem readContract, the cast oracle and
// the SPEC literal must all agree (I11, the read the flows unlimited-approval guard uses).
const SUPPLIES: ReadonlyArray<readonly [Asset, Address, bigint]> = [
  ["EUR24", arbitrum.tokens.EUR24.proxy, 22_462_299_720n],
  ["USD24", arbitrum.tokens.USD24.proxy, 26_617_158_450n],
  ["CHF24", arbitrum.tokens.CHF24.proxy, 18_579_129_528n],
  ["CNH24", arbitrum.tokens.CNH24.proxy, 59_600_000_000n],
  ["F24", arbitrum.f24.address, 8_637_577_500n],
  ["USDC", arbitrum.usdc, 2_765_041_859_969_592n],
];

// The §6.1 spender for the above-supply approve path per asset.
const SUPPLY_SPENDER: Record<Asset, ApprovalSpender> = {
  EUR24: "deposit",
  USD24: "deposit",
  CHF24: "deposit",
  CNH24: "deposit",
  F24: "account",
  USDC: "deposit",
};

describe.skipIf(!FORK_ENABLED)("fork: approve", () => {
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

  test.each(CASH_PAIRS)(
    "approve %s -> %s succeeds and decodes approval",
    async (asset, spender) => {
      const receipt = await sendCall(
        fork,
        owner1,
        approveCall({ asset, spender, amount: 12_345n }),
      );
      expect(receipt.status).toBe("success");
      const approvals = eventsOfKind(decoded(receipt), "approval");
      expect(approvals).toHaveLength(1);
      const event = required(approvals[0]);
      expect(event.currency).toBe(asset);
      expect(event.owner).toBe(owner1);
      expect(event.spender).toBe(SPENDER_ADDR[spender]);
      expect(event.amount).toBe(12_345n);
    },
  );

  test.each(OTHER_PAIRS)(
    "approve %s -> %s succeeds with no decoded event",
    async (asset, spender) => {
      const receipt = await sendCall(
        fork,
        owner1,
        approveCall({ asset, spender, amount: 12_345n }),
      );
      expect(receipt.status).toBe("success");
      expect(eventsOfKind(decoded(receipt), "approval")).toHaveLength(0);
    },
  );

  test.each(SUPPLIES)(
    "totalSupply %s at the pin = cast = SPEC §4.3",
    async (_a, address, supply) => {
      const [viem, cast] = await Promise.all([
        fork.publicClient.readContract({
          address,
          abi: tokenAbi,
          functionName: "totalSupply",
          blockNumber: FORK_BLOCK,
        }),
        castCall(fork, [address, "totalSupply()(uint256)"], PIN),
      ]);
      expect(viem).toBe(supply);
      expect(castUint(cast)).toBe(supply);
    },
  );

  test.each(SUPPLIES)(
    "approve %s at totalSupply + 1 is accepted by builder and contract (I11)",
    async (asset, address, supply) => {
      // The builder's < 10^18 bound accepts it and `eth_call approve` succeeds — the
      // amount > totalSupply => unlimited-approval refusal is a flows-side rule, never
      // a builder or contract rule.
      const call = approveCall({ asset, spender: SUPPLY_SPENDER[asset], amount: supply + 1n });
      const out = await castCall(
        fork,
        [call.to, "approve(address,uint256)(bool)", owner1, String(supply + 1n)],
        PIN,
        owner1,
      );
      expect(out).toBe("true");
      expect(call.to).toBe(address);
    },
  );

  test("approve 0 revokes a previous allowance", async () => {
    const grant = approveCall({ asset: "EUR24", spender: "deposit", amount: 500n });
    await sendOk(fork, owner1, grant);
    const revoke = approveCall({ asset: "EUR24", spender: "deposit", amount: 0n });
    await sendOk(fork, owner1, revoke);
    const allowance = await fork.publicClient.readContract({
      address: arbitrum.tokens.EUR24.proxy,
      abi: tokenAbi,
      functionName: "allowance",
      args: [owner1, arbitrum.deposit.proxy],
    });
    expect(allowance).toBe(0n);
  });
});
