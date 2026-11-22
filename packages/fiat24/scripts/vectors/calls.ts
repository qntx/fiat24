import { readFileSync } from "node:fs";

import { cast } from "./lib.ts";
import type { VectorSource } from "./lib.ts";

// data/deployments.json is the source of truth for `to` (never the SDK).
type Deployments = {
  proxies: Record<string, { proxy: string }>;
  f24: { address: string };
  usdc: string;
};

const deployments: Deployments = JSON.parse(
  readFileSync(new URL("../../../../data/deployments.json", import.meta.url), "utf8"),
) as Deployments;

type RawTx = { to: string; input: string };
const payoutRefTx: RawTx = JSON.parse(
  readFileSync(new URL("raw/payout-ref-tx.json", import.meta.url), "utf8"),
) as RawTx;

const CURRENCIES = ["USD24", "EUR24", "CHF24", "CNH24"] as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYOUT_REF_TX_REF = "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3";

function proxy(name: string): string {
  const entry = deployments.proxies[name];
  if (entry === undefined) {
    throw new Error(`deployments.json: no proxy ${name}`);
  }
  return entry.proxy;
}

function calldata(sig: string, args: ReadonlyArray<string>): string {
  return cast(["calldata", sig, ...args]);
}

function ok(op: string, args: Record<string, unknown>, output: Record<string, unknown>) {
  return { op, args, output };
}

function fail(op: string, args: Record<string, unknown>, error: string) {
  return { op, args, error };
}

/** The recorded NUL-padded ref (tx 0xbe87…dea3): the two trailing U+0000 are real bytes. */
const NUL_REF = `${PAYOUT_REF_TX_REF}\u0000\u0000`;

if (payoutRefTx.to.toLowerCase() !== deployments.proxies["EUR24"]?.proxy.toLowerCase()) {
  throw new Error("raw/payout-ref-tx.json: recorded `to` is not the EUR24 proxy");
}

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const cases: unknown[] = [];

  // transfer × 4 currencies (SPEC §6.1: contracts = token, account).
  for (const currency of CURRENCIES) {
    cases.push(
      ok(
        "transferCall",
        { currency, to: RECIPIENT, amount: "12345" },
        {
          to: proxy(currency),
          data: calldata("transfer(address,uint256)", [RECIPIENT, "12345"]),
          value: "0",
          contracts: [currency, "account"],
        },
      ),
    );
  }

  // transferToAccount × 4 + the internal-range boundaries 9099/9300 (valid ids).
  for (const currency of CURRENCIES) {
    cases.push(
      ok(
        "transferToAccountCall",
        { currency, tokenId: "123456", amount: "100" },
        {
          to: proxy(currency),
          data: calldata("transferByAccountId(uint256,uint256)", ["123456", "100"]),
          value: "0",
          contracts: [currency, "account"],
        },
      ),
    );
  }
  for (const tokenId of ["9099", "9300"]) {
    cases.push(
      ok(
        "transferToAccountCall",
        { currency: "EUR24", tokenId, amount: "1" },
        {
          to: proxy("EUR24"),
          data: calldata("transferByAccountId(uint256,uint256)", [tokenId, "1"]),
          value: "0",
          contracts: ["EUR24", "account"],
        },
      ),
    );
  }

  // exchange exact-in and exact-out for each `from` (to = next currency; contracts
  // = deposit, from, to, account; Fiat24CryptoDeposit.sol:369-404).
  for (const side of ["exact-in", "exact-out"] as const) {
    const fn = side === "exact-in" ? "moneyExchangeExactIn" : "moneyExchangeExactOut";
    for (const [index, from] of CURRENCIES.entries()) {
      const to = CURRENCIES[(index + 1) % CURRENCIES.length];
      cases.push(
        ok(
          "exchangeCall",
          { side, from, to, amount: "123456" },
          {
            to: proxy("deposit"),
            data: calldata(`${fn}(address,address,uint256)`, [
              proxy(from),
              proxy(to ?? "EUR24"),
              "123456",
            ]),
            value: "0",
            contracts: ["deposit", from, to, "account"],
          },
        ),
      );
    }
  }

  // payout × 2 (EUR24, CHF24).
  for (const [currency, contactId] of [
    ["EUR24", "SP"],
    ["CHF24", "EA-00000738"],
  ] as const) {
    cases.push(
      ok(
        "payoutCall",
        { currency, amount: "5000", contactId },
        {
          to: proxy(currency),
          data: calldata("clientPayout(uint256,string)", ["5000", contactId]),
          value: "0",
          contracts: [currency, "account"],
        },
      ),
    );
  }

  // payoutRef: the real ref of tokenId 109549 plus the recorded NUL-padded tx
  // 0xbe87…dea3 (expected data = the recorded input verbatim).
  cases.push(
    ok(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1000",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        tokenId: "109549",
      },
      {
        to: proxy("EUR24"),
        data: calldata("clientPayoutRef(uint256,string,uint256,string)", [
          "1000",
          "SP",
          "0",
          "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        ]),
        value: "0",
        contracts: ["EUR24", "account"],
      },
    ),
    ok(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "4129",
        contactId: "EA-00001156",
        purposeId: "8",
        ref: NUL_REF,
        tokenId: "690333",
      },
      {
        // recorded `to` is the EUR24 proxy in raw-rpc lowercase; normal form is EIP-55
        to: proxy("EUR24"),
        data: payoutRefTx.input,
        value: "0",
        contracts: ["EUR24", "account"],
      },
    ),
  );

  // approve: every allowed pair (cash→card, cash→deposit, USDC→deposit, F24→account)
  // plus a 0-amount revoke; expected spender address from deployments.json.
  const pairs: ReadonlyArray<readonly [string, "card" | "deposit" | "account", string]> = [
    ...CURRENCIES.flatMap((c): ReadonlyArray<readonly [string, "card" | "deposit", string]> => [
      [c, "card", proxy("card")],
      [c, "deposit", proxy("deposit")],
    ]),
    ["USDC", "deposit", proxy("deposit")],
    ["F24", "account", proxy("account")],
  ];
  for (const [asset, spender, spenderAddress] of pairs) {
    const target =
      asset === "USDC"
        ? deployments.usdc
        : asset === "F24"
          ? deployments.f24.address
          : proxy(asset);
    const contracts =
      asset === "USDC" ? ["deposit"] : asset === "F24" ? ["f24", "account"] : [asset, spender];
    cases.push(
      ok(
        "approveCall",
        { asset, spender, amount: "25000" },
        {
          to: target,
          data: calldata("approve(address,uint256)", [spenderAddress, "25000"]),
          value: "0",
          contracts,
        },
      ),
    );
  }
  cases.push(
    ok(
      "approveCall",
      { asset: "EUR24", spender: "deposit", amount: "0" },
      {
        to: proxy("EUR24"),
        data: calldata("approve(address,uint256)", [proxy("deposit"), "0"]),
        value: "0",
        contracts: ["EUR24", "deposit"],
      },
    ),
    // mint + mintWithEth (contracts per §6.1 column).
    ok(
      "mintAccountCall",
      { tokenId: "123456" },
      {
        to: proxy("account"),
        data: calldata("mintByClient(uint256)", ["123456"]),
        value: "0",
        contracts: ["account", "priceList", "f24"],
      },
    ),
    ok(
      "mintAccountWithEthCall",
      { tokenId: "123456", value: "10000000000000000" },
      {
        to: proxy("account"),
        data: calldata("mintByClientWithETH(uint256)", ["123456"]),
        value: "10000000000000000",
        contracts: ["account", "priceList", "f24", "f24Sales"],
      },
    ),
  );

  // topUp × 4: depositTokenViaUsdc(usdc, outputToken, usdcAmount); USD24 output
  // deduplicates to [deposit, account, USD24].
  for (const output of CURRENCIES) {
    const contracts =
      output === "USD24"
        ? ["deposit", "account", "USD24"]
        : ["deposit", "account", output, "USD24"];
    cases.push(
      ok(
        "topUpCall",
        { output, usdcAmount: "2000000" },
        {
          to: proxy("deposit"),
          data: calldata("depositTokenViaUsdc(address,address,uint256)", [
            deployments.usdc,
            proxy(output),
            "2000000",
          ]),
          value: "0",
          contracts,
        },
      ),
    );
  }

  // ---- refusal cases (SPEC §6.1); the runner asserts the Fiat24Error code.
  cases.push(
    fail(
      "transferCall",
      { currency: "EUR24", to: "0x0000000000000000000000000000000000000000", amount: "1" },
      "invalid-address",
    ),
    // a deployment address (the account proxy) is refused, case-insensitively
    fail(
      "transferCall",
      { currency: "EUR24", to: proxy("account"), amount: "1" },
      "invalid-address",
    ),
    fail(
      "transferCall",
      { currency: "EUR24", to: proxy("EUR24").toLowerCase(), amount: "1" },
      "invalid-address",
    ),
    fail(
      "transferCall",
      { currency: "EUR24", to: deployments.usdc, amount: "1" },
      "invalid-address",
    ),
    // badly checksummed (0x…dead with a capital D is not the EIP-55 form)
    fail(
      "transferCall",
      { currency: "EUR24", to: "0x111111111111111111111111111111111111De11", amount: "1" },
      "invalid-address",
    ),
    fail("transferCall", { currency: "EUR24", to: "0x123", amount: "1" }, "invalid-address"),
    fail("transferCall", { currency: "EUR24", to: RECIPIENT, amount: "0" }, "invalid-amount"),
    fail(
      "transferCall",
      { currency: "EUR24", to: RECIPIENT, amount: "1000000000000000000" },
      "amount-out-of-range",
    ),
    fail("transferCall", { currency: "DOGE", to: RECIPIENT, amount: "1" }, "unsupported-currency"),
    fail(
      "transferCall",
      { currency: "EUR24", to: RECIPIENT, amount: "1", chainId: "1" },
      "unsupported-chain",
    ),
    // transferToAccount: internal ids refused; id 0 and out-of-range amounts
    fail(
      "transferToAccountCall",
      { currency: "EUR24", tokenId: "9100", amount: "1" },
      "internal-account",
    ),
    fail(
      "transferToAccountCall",
      { currency: "EUR24", tokenId: "9299", amount: "1" },
      "internal-account",
    ),
    fail(
      "transferToAccountCall",
      { currency: "EUR24", tokenId: "0", amount: "1" },
      "invalid-account-id",
    ),
    fail(
      "transferToAccountCall",
      { currency: "EUR24", tokenId: "123456", amount: "0" },
      "invalid-amount",
    ),
    // exchange
    fail(
      "exchangeCall",
      { side: "exact-in", from: "EUR24", to: "EUR24", amount: "1" },
      "invalid-argument",
    ),
    fail(
      "exchangeCall",
      { side: "market", from: "EUR24", to: "USD24", amount: "1" },
      "invalid-argument",
    ),
    // payout
    fail(
      "payoutCall",
      { currency: "USD24", amount: "5000", contactId: "SP" },
      "unsupported-currency",
    ),
    fail(
      "payoutCall",
      { currency: "CNH24", amount: "5000", contactId: "SP" },
      "unsupported-currency",
    ),
    fail("payoutCall", { currency: "EUR24", amount: "5000", contactId: "sp" }, "invalid-argument"),
    fail(
      "payoutCall",
      { currency: "EUR24", amount: "5000", contactId: "TOOLONGGGGG" },
      "invalid-argument",
    ),
    fail("payoutCall", { currency: "EUR24", amount: "5000", contactId: "EA-" }, "invalid-argument"),
    fail(
      "payoutCall",
      { currency: "EUR24", amount: "5000", contactId: "EA-12345678901234567" },
      "invalid-argument",
    ),
    // payoutRef
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "1000001",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    // §6.2 ref grammar: bare uuidv4 (doc example), foreign prefix, uppercase uuid
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109548-854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854EE1EF-6FC3-4009-A10E-7C3BE268E52C",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    // NUL padding that does not fill to exactly 45
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c\u0000",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c\u0000\u0000\u0000",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    // a NUL before the uuid end
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52\u0000",
        tokenId: "109549",
      },
      "invalid-argument",
    ),
    // a 9-digit tokenId prefix that would need padding beyond the 45-byte field
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "123456789-854ee1ef-6fc3-4009-a10e-7c3be268e52\u0000",
        tokenId: "123456789",
      },
      "invalid-argument",
    ),
    fail(
      "payoutRefCall",
      {
        currency: "EUR24",
        amount: "1",
        contactId: "SP",
        purposeId: "0",
        ref: "109549-854ee1ef-6fc3-4009-a10e-7c3be268e52c",
        tokenId: "0",
      },
      "invalid-account-id",
    ),
    // approve
    fail(
      "approveCall",
      { asset: "EUR24", spender: "deposit", amount: "1000000000000000000" },
      "unlimited-approval",
    ),
    fail("approveCall", { asset: "EUR24", spender: "account", amount: "1" }, "invalid-argument"),
    fail("approveCall", { asset: "USDC", spender: "card", amount: "1" }, "invalid-argument"),
    fail("approveCall", { asset: "USDC", spender: "account", amount: "1" }, "invalid-argument"),
    fail("approveCall", { asset: "F24", spender: "card", amount: "1" }, "invalid-argument"),
    fail("approveCall", { asset: "F24", spender: "deposit", amount: "1" }, "invalid-argument"),
    fail("approveCall", { asset: "DOGE", spender: "deposit", amount: "1" }, "unsupported-currency"),
    fail("approveCall", { asset: "EUR24", spender: "owner", amount: "1" }, "invalid-argument"),
    // mint ids outside 100000..799999 (standard mint range only)
    fail("mintAccountCall", { tokenId: "99999" }, "invalid-account-id"),
    fail("mintAccountCall", { tokenId: "800000" }, "invalid-account-id"),
    fail("mintAccountCall", { tokenId: "900000" }, "invalid-account-id"),
    fail("mintAccountWithEthCall", { tokenId: "123456", value: "0" }, "invalid-amount"),
    // topUp
    fail("topUpCall", { output: "DOGE", usdcAmount: "2000000" }, "unsupported-currency"),
    fail("topUpCall", { output: "EUR24", usdcAmount: "0" }, "invalid-amount"),
  );

  return {
    capability: "calls.calldata",
    source: {
      kind: "reference",
      name: "cast",
      version: "1.10.0",
      evidence:
        "expected data via `cast calldata`; the NUL-padded payoutRef case carries the recorded input of tx 0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3 (raw/payout-ref-tx.json); contracts lists from SPEC §6.1",
    },
    cases,
  };
}
