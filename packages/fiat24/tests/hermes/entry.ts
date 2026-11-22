/**
 * Bundle entry for the Hermes smoke test: imports every published entry point (the root plus one
 * per layer) and exercises the pure core functions — Fiat24Error, parseAmount, ibanOf and
 * decodeFiat24Revert on an `Error(string)` payload. scripts/hermes-smoke.ts bundles this file to a
 * single classic script and runs it on the Hermes V1 CLI that React Native ships. The
 * `HERMES_SMOKE_OK` line is the pass contract: Hermes exits 0 even for unhandled errors, so runners
 * assert the marker.
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

declare function print(msg: string): void;
declare function quit(code: number): void;

function assert(cond: boolean, name: string): asserts cond {
  if (!cond) {
    throw new Error(`smoke: ${name}`);
  }
}

// cast calldata "Error(string)" "Fiat24Token: amount < minimal payout amount"
const REVERT_PAYLOAD =
  "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002b466961743234546f6b656e3a20616d6f756e74203c206d696e696d616c207061796f757420616d6f756e74000000000000000000000000000000000000000000";

try {
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
  print("HERMES_SMOKE_OK");
} catch (error) {
  print(
    `HERMES_SMOKE_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  quit(1);
}
