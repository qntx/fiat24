import { readFileSync } from "node:fs";

import { cast } from "./lib.ts";
import type { VectorSource } from "./lib.ts";

// The recorded oracle (SPEC §11.1): `record-quote.sh` drove `eth_call` against an anvil fork of
// Arbitrum One at the pinned block and wrote `raw/quote.json`. This generator transcribes the
// recorded results — it never recomputes them with SDK code.
type EthCall = { result?: string; revert?: string };

type RawCase = {
  side: string;
  amount: string;
  rate: string;
  spread: string;
  ethCall: EthCall;
};

type RawTopUp = {
  usdcAmount: string;
  fee: string;
  usdcRate: string;
  rate: string;
  spread: string;
  ethCall: EthCall;
};

type Raw = {
  source: string;
  block: string;
  exchange: { cases: RawCase[] };
  topUp: { cases: RawTopUp[] };
  mint: {
    priceF24: string;
    quotePerEther: string;
    value: string;
    atValue: EthCall;
    atValueMinusOne: EthCall;
  };
};

const raw: Raw = JSON.parse(
  readFileSync(new URL("raw/quote.json", import.meta.url), "utf8"),
) as Raw;

function recordedDate(source: string): string {
  const date = /^recorded (\S+)/.exec(source)?.[1];
  if (date === undefined) {
    throw new Error(`raw/quote.json: unrecognised source line ${JSON.stringify(source)}`);
  }
  return date;
}

// `moneyExchangeExactOut` reverts Fiat24CryptoDeposit__ValueZero on a zero output request or a
// zero computed input (Fiat24CryptoDeposit.sol:388,394) — the quote formula's zero — verified
// here against `cast sig`, never hand-typed.
const VALUE_ZERO = cast(["sig", "Fiat24CryptoDeposit__ValueZero()"]);

const MINT_REASON = "Not sufficient msg.value for F24 purchase";

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const cases: unknown[] = [];
  let skipped = 0;

  for (const c of raw.exchange.cases) {
    const input = { side: c.side, amount: c.amount, rate: c.rate, spread: c.spread };
    const { result, revert } = c.ethCall;
    if (result !== undefined) {
      cases.push({ op: "exchange", input, output: result });
    } else if (revert === undefined) {
      throw new Error("raw/quote.json: exchange case with neither result nor revert");
    } else if (revert.startsWith(VALUE_ZERO)) {
      cases.push({
        op: "exchange",
        input,
        output: "0",
        contract: "Fiat24CryptoDeposit__ValueZero",
      });
    } else {
      // The only other admissible revert is an STF leg failure (computed input > funded
      // balance) — decoded by cast, never assumed; anything else fails the generator.
      const decoded = cast(["decode-error", revert]);
      if (!decoded.includes('"STF"')) {
        throw new Error(`raw/quote.json: unexpected exchange revert ${decoded}`);
      }
      skipped += 1;
    }
  }

  for (const c of raw.topUp.cases) {
    if (c.ethCall.result === undefined) {
      throw new Error("raw/quote.json: top-up case without eth_call result");
    }
    cases.push({
      op: "top-up",
      input: {
        usdcAmount: c.usdcAmount,
        fee: c.fee,
        usdcRate: c.usdcRate,
        rate: c.rate,
        spread: c.spread,
      },
      output: c.ethCall.result,
    });
  }

  // The mint price is only believable if the recorded `value - 1` eth_call reverted with the
  // contract's own reason — decoded by cast, never parsed by us.
  const { mint } = raw;
  if (mint.atValue.result === undefined) {
    throw new Error("raw/quote.json: mint atValue did not succeed");
  }
  const { revert } = mint.atValueMinusOne;
  if (revert === undefined) {
    throw new Error("raw/quote.json: mint atValueMinusOne did not revert");
  }
  const decoded = cast(["decode-error", revert]);
  if (!decoded.includes(MINT_REASON)) {
    throw new Error(`raw/quote.json: unexpected mint revert reason ${decoded}`);
  }
  cases.push({
    op: "mint",
    input: { priceF24: mint.priceF24, quotePerEther: mint.quotePerEther },
    output: mint.value,
  });

  return {
    capability: "chain/quote",
    source: {
      kind: "recorded",
      date: recordedDate(raw.source),
      block: raw.block,
      evidence: raw.source,
      skipped,
    },
    cases,
  };
}
