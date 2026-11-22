import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { fiat24ErrorCodes } from "../../src/core/index.ts";
import type { Currency } from "../../src/core/index.ts";
import { arbitrum } from "../../src/deployments/index.ts";
import { decodeFiat24Log } from "../../src/events/index.ts";
import type { RawLog } from "../../src/events/index.ts";
import { errorCodeStrings, expectError, loadVector, required } from "../helpers.ts";

const vector = loadVector("vectors/events/decode.json", "events.decode");
const synthetic = loadVector("vectors/events/decode-synthetic.json", "events.decode-synthetic");
const cases = [...vector.cases, ...synthetic.cases];
const DECODED_CASES = cases.filter((c) => "output" in c && c["output"] !== null);

// §3.5/§7.1 mapping, authored from SPEC (never from the decoder): raw ABI arg
// name -> Fiat24Event field, per event kind.
type Args = Readonly<Record<string, string>>;

const TOKEN_BY_ADDRESS = new Map(
  (["USD24", "EUR24", "CHF24", "CNH24"] as const).map(
    (name) => [arbitrum.tokens[name].proxy.toLowerCase(), name] as const,
  ),
);

function currencyOf(address: string): Currency | undefined {
  return TOKEN_BY_ADDRESS.get(address.toLowerCase());
}

function logOf(input: Readonly<Record<string, unknown>>): RawLog {
  return {
    address: input["address"] as Address,
    topics: input["topics"] as Hex[],
    data: input["data"] as Hex,
    blockNumber: input["blockNumber"] === null ? null : BigInt(String(input["blockNumber"])),
    transactionHash: input["transactionHash"] as `0x${string}` | null,
    logIndex: input["logIndex"] === null ? null : Math.trunc(Number(String(input["logIndex"]))),
  };
}

const big: (v: string) => bigint = BigInt;
const addr = (v: string): Address => v as Address;

function baseOf(input: Readonly<Record<string, unknown>>) {
  return {
    address: String(input["address"]),
    blockNumber: BigInt(String(input["blockNumber"])),
    transactionHash: String(input["transactionHash"]),
    logIndex: Math.trunc(Number(String(input["logIndex"]))),
  };
}

/**
 * Expected event for a decoded case: ERC-721 `Transfer` on the account contract is
 * `account-transfer`.
 */
function expectedOf(
  output: { kind: string; args: Args },
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (output.kind === "Transfer" && currencyOf(String(input["address"])) === undefined) {
    return {
      kind: "account-transfer",
      from: output.args["from"],
      to: output.args["to"],
      tokenId: big(output.args["tokenId"] ?? "0"),
      ...baseOf(input),
    };
  }
  return {
    ...expectedFields(output.kind, output.args, String(input["address"])),
    ...baseOf(input),
  };
}

/** Expected Fiat24Event fields, mapped per the SPEC §3.5/§7.1 table. */
function expectedFields(
  kind: string,
  args: Args,
  logAddress: string,
): Readonly<Record<string, unknown>> {
  const currency = currencyOf(logAddress);
  switch (kind) {
    case "Transfer": // on a cash token: {from, to, value}
      return {
        kind: "transfer",
        currency,
        from: addr(args["from"] ?? ""),
        to: addr(args["to"] ?? ""),
        amount: big(args["value"] ?? "0"),
      };
    case "Approval": // on a cash token: {owner, spender, value}
      return {
        kind: "approval",
        currency,
        owner: addr(args["owner"] ?? ""),
        spender: addr(args["spender"] ?? ""),
        amount: big(args["value"] ?? "0"),
      };
    case "ClientPayout":
      return {
        kind: "payout",
        currency,
        tokenId: big(args["tokenId"] ?? "0"),
        sender: addr(args["sender"] ?? ""),
        payoutAccount: big(args["payoutAccount"] ?? "0"),
        amount: big(args["amount"] ?? "0"),
        contactId: args["contactId"],
        txid: args["txid"],
      };
    case "ClientPayoutRef":
      return {
        kind: "payout-ref",
        currency,
        tokenId: big(args["tokenId"] ?? "0"),
        sender: addr(args["sender"] ?? ""),
        payoutAccount: big(args["payoutAccount"] ?? "0"),
        amount: big(args["amount"] ?? "0"),
        contactId: args["contactId"],
        txid: args["txid"],
        purposeId: big(args["purposeId"] ?? "0"),
        ref: args["ref"],
      };
    case "CashDeposit": // §7.1: exaccId/bankId/trxId not exposed
      return {
        kind: "cash-deposit",
        currency,
        tokenId: big(args["recipientAccountId"] ?? "0"),
        recipient: addr(args["recipientAddress"] ?? ""),
        depositAccount: big(args["depositAccount"] ?? "0"),
      };
    case "CashDepositNOK": // §7.1: bank strings not exposed
      return {
        kind: "cash-deposit-rejected",
        currency,
        tokenId: big(args["recipientAccountId"] ?? "0"),
        depositAccount: big(args["depositAccount"] ?? "0"),
      };
    case "CashPayout": {
      const payoutAccount = big(args["payoutAccount"] ?? "0");
      // Fiat24Token.sol:109-125: 9104 = cashPayoutOK, 9103 = cashPayoutNOK
      const settlement =
        payoutAccount === 9104n ? "settled" : payoutAccount === 9103n ? "rejected" : "unknown";
      return {
        kind: "cash-payout",
        currency,
        tokenId: big(args["senderAccountId"] ?? "0"),
        sender: addr(args["senderAddress"] ?? ""),
        payoutAccount,
        settlement,
        bankId: args["bankId"],
        trxId: args["trxId"],
      };
    }
    case "MoneyExchangedExactIn":
    case "MoneyExchangedExactOut": {
      const input = currencyOf(args["inputToken"] ?? "");
      const output = currencyOf(args["outputToken"] ?? "");
      return {
        kind: "exchange",
        side: kind === "MoneyExchangedExactIn" ? "exact-in" : "exact-out",
        sender: addr(args["sender"] ?? ""),
        inputToken: addr(args["inputToken"] ?? ""),
        outputToken: addr(args["outputToken"] ?? ""),
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        inputAmount: big(args["inputAmount"] ?? "0"),
        outputAmount: big(args["outputAmount"] ?? "0"),
      };
    }
    case "DepositedTokenViaUsd":
    case "DepositedEth":
    case "DepositedTokenViaEth": {
      const output = currencyOf(args["outputToken"] ?? "");
      return {
        kind: "top-up",
        via:
          kind === "DepositedTokenViaUsd"
            ? "usdc"
            : kind === "DepositedEth"
              ? "eth"
              : "token-via-eth",
        sender: addr(args["sender"] ?? ""),
        inputToken: addr(args["inputToken"] ?? ""),
        outputToken: addr(args["outputToken"] ?? ""),
        ...(output === undefined ? {} : { output }),
        inputAmount: big(args["inputAmount"] ?? "0"),
        outputAmount: big(args["outputAmount"] ?? "0"),
      };
    }
    case "DepositedByWallet": {
      const output = currencyOf(args["outputToken"] ?? "");
      return {
        kind: "top-up-by-wallet",
        tokenId: big(args["tokenId"] ?? "0"),
        client: addr(args["clientAddress"] ?? ""),
        walletId: big(args["walletId"] ?? "0"),
        wallet: addr(args["walletAddress"] ?? ""),
        outputToken: addr(args["outputToken"] ?? ""),
        ...(output === undefined ? {} : { output }),
        usdcAmount: big(args["usdcAmount"] ?? "0"),
      };
    }
    case "Authorized":
    case "Incremented": {
      const cardCurrency = currencyOf(args["cardCurrency"] ?? "");
      return {
        kind: kind === "Authorized" ? "card-authorized" : "card-incremented",
        tokenId: big(args["tokenId"] ?? "0"),
        sender: addr(args["sender"] ?? ""),
        cardId: args["cardId"],
        authorizationToken: args["authorizationToken"],
        token: addr(args["cardCurrency"] ?? ""),
        ...(cardCurrency === undefined ? {} : { currency: cardCurrency }),
        amount: big(args["paidAmount"] ?? "0"),
      };
    }
    case "Adviced":
    case "Reversed": {
      const cardCurrency = currencyOf(args["cardCurrency"] ?? "");
      return {
        kind: kind === "Adviced" ? "card-refund" : "card-reversal",
        tokenId: big(args["tokenId"] ?? "0"),
        sender: addr(args["sender"] ?? ""),
        cardId: args["cardId"],
        adviceToken: args["adviceToken"],
        originalAuthorizationToken: args["originalAuthorizationToken"],
        token: addr(args["cardCurrency"] ?? ""),
        ...(cardCurrency === undefined ? {} : { currency: cardCurrency }),
        amount: big(args["paidAmount"] ?? "0"),
      };
    }
    default:
      throw new Error(`unmapped kind ${kind}`);
  }
}

describe("vectors/events/decode.json + decode-synthetic.json", () => {
  test("envelopes", () => {
    expect(vector.schema).toBe(1);
    expect(vector.capability).toBe("events.decode");
    expect(vector.cases.length).toBeGreaterThan(0);
    expect(synthetic.schema).toBe(1);
    expect(synthetic.capability).toBe("events.decode-synthetic");
    expect(synthetic.cases.length).toBeGreaterThan(0);
  });

  test("every failure code is a Fiat24ErrorCode", () => {
    expect(errorCodeStrings(cases).every((code) => fiat24ErrorCodes.some((c) => c === code))).toBe(
      true,
    );
  });

  test.each(DECODED_CASES.map((c) => [String(c["label"]), c] as const))(
    "decodes %s",
    (_label, c) => {
      const input = c["input"] as Readonly<Record<string, unknown>>;
      const output = c["output"] as { kind: string; args: Args };
      expect(required(decodeFiat24Log(logOf(input)))).toStrictEqual(expectedOf(output, input));
    },
  );

  test.each(cases.filter((c) => c["output"] === null).map((c) => [String(c["label"]), c] as const))(
    "returns undefined for %s",
    (_label, c) => {
      expect(
        decodeFiat24Log(logOf(c["input"] as Readonly<Record<string, unknown>>)),
      ).toBeUndefined();
    },
  );

  test.each(cases.filter((c) => "error" in c).map((c) => [String(c["label"]), c] as const))(
    "refuses %s",
    (_label, c) => {
      expect.hasAssertions();
      expectError(
        () => decodeFiat24Log(logOf(c["input"] as Readonly<Record<string, unknown>>)),
        c["error"],
      );
    },
  );
});
