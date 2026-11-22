import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import { approveCall } from "../../src/calls/index.ts";
import type { ApprovalSpender, Asset } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { required } from "../helpers.ts";
import {
  FORK_ENABLED,
  LIVE_1,
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
