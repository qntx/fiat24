/**
 * The assertions shared by the native and the shim Hermes entries: every published entry point
 * loads, the pure core functions work, the session label/message match the §9.2 vector, and the
 * recorded NUL-padded `ClientPayoutRef` log decodes with its U+0000 padding intact.
 */
import * as abi from "../../src/abi/index.ts";
import * as api from "../../src/api/index.ts";
import * as calls from "../../src/calls/index.ts";
import * as chain from "../../src/chain/index.ts";
import * as core from "../../src/core/index.ts";
import * as deployments from "../../src/deployments/index.ts";
import * as events from "../../src/events/index.ts";
import * as flows from "../../src/flows/index.ts";
import * as index from "../../src/index.ts";

function assert(cond: boolean, name: string): asserts cond {
  if (!cond) {
    throw new Error(`smoke: ${name}`);
  }
}

// cast calldata "Error(string)" "Fiat24Token: amount < minimal payout amount"
const REVERT_PAYLOAD =
  "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002b466961743234546f6b656e3a20616d6f756e74203c206d696e696d616c207061796f757420616d6f756e74000000000000000000000000000000000000000000";

// The recorded NUL-padded ClientPayoutRef log of tx 0xbe87…dea3 (block 496377468, log 3):
// scripts/vectors/raw/events.json, ref "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\0\0".
const NUL_PAYOUT_REF_LOG = {
  address: "0x2c5d06f591d0d8cd43ac232c2b654475a142c7da",
  topics: [
    "0xb0edd2920d8642e5a9d1e38c772e65fabe13c83a27cef8f6929a7740b9041d36",
    "0x00000000000000000000000000000000000000000000000000000000000a889d",
    "0x000000000000000000000000cf61f43b6fad7394c784401743df9a7bf5ff1536",
  ],
  data: "0x000000000000000000000000000000000000000000000000000000000000238e000000000000000000000000000000000000000000000000000000000000102100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000b45412d303030303131353600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000103639303333332d34393633373734363800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002d3639303333332d35306662303934312d346635392d346138392d383733352d646437386261376435336133000000000000000000000000000000000000000000",
  blockNumber: 496377468n,
  transactionHash: "0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3",
  logIndex: 3,
} as const;

export function runSmoke(): void {
  const namespaces = { index, abi, api, calls, chain, core, deployments, events, flows };
  for (const [name, ns] of Object.entries(namespaces)) {
    assert(typeof ns === "object" && ns !== null, `${name} namespace`);
  }
  assert(index.Fiat24Error === core.Fiat24Error, "root re-exports core");
  const error = new index.Fiat24Error("invalid-argument", "bad input");
  assert(error instanceof Error && error instanceof index.Fiat24Error, "instanceof");
  assert(error.name === "Fiat24Error", "name");
  assert(error.code === "invalid-argument", "code");
  assert(error.cause === undefined, "no cause");
  assert(index.parseAmount("EUR24", "12.3") === 1230n, "parseAmount");
  assert(index.formatAmount("EUR24", 1230n) === "12.30", "formatAmount");
  assert(index.ibanOf(1n) === "CH6483051000000000001", "ibanOf");
  assert(index.isValidIban(index.ibanOf(12345n)), "isValidIban");
  const reason = index.decodeFiat24Revert(REVERT_PAYLOAD);
  assert(
    reason.kind === "error" && reason.reason === "Fiat24Token: amount < minimal payout amount",
    "decodeFiat24Revert",
  );
  assert(index.revertCode(reason) === "below-minimum", "revertCode");
  assert(index.arbitrum.chainId === 42161, "arbitrum deployment");
  assert(
    index.contractAddress(index.arbitrum, "account") === index.arbitrum.account.proxy,
    "contractAddress",
  );
  // §9.2 session strings (api layer; keccak over UTF-8 exercises the encoder).
  const session = { chainId: 42161 as const, tokenId: 123456n, deadline: 1795278000n };
  assert(api.sessionLabel(session) === "fiat24-session-v1:42161:123456:1795278000", "sessionLabel");
  assert(
    api.sessionMessage(session) ===
      "I agree to access my profile. 0x7aa5d53d52ac69271847fc6b9385c9080a249f9d3c2aff9f721ca821a8109025",
    "sessionMessage",
  );
  // A transfer call builder + the recorded NUL-padded ClientPayoutRef log (events layer).
  const call = calls.transferCall({ currency: "EUR24", to: `0x${"1".repeat(40)}`, amount: 1n });
  assert(call.data.startsWith("0xa9059cbb"), "transferCall selector");
  const decoded = events.decodeFiat24Log(NUL_PAYOUT_REF_LOG);
  assert(decoded !== undefined, "NUL log decodes");
  assert(
    decoded.kind === "payout-ref" &&
      decoded.ref === "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000" &&
      decoded.ref.length === 45 &&
      decoded.purposeId === 8n &&
      decoded.contactId === "EA-00001156" &&
      decoded.txid === "690333-496377468",
    "NUL-padded ref preserved verbatim",
  );
}
