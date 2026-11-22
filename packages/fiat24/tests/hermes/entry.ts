/**
 * Bundle entry for the Hermes smoke test: imports every published entry point (the root plus one
 * per layer) and exercises Fiat24Error, the only runtime behaviour src ships so far.
 * scripts/hermes-smoke.ts bundles this file to a single classic script and runs it on the Hermes V1
 * CLI that React Native ships. The `HERMES_SMOKE_OK` line is the pass contract: Hermes exits 0 even
 * for unhandled errors, so runners assert the marker.
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

try {
  const namespaces = { index, abi, api, calls, chain, core, deployments, events, flows };
  for (const [name, ns] of Object.entries(namespaces)) {
    assert(typeof ns === "object" && ns !== null, `${name} namespace`);
  }
  assert(index.Fiat24Error === core.Fiat24Error, "root re-exports core");
  const cause = new Error("root cause");
  const error = new index.Fiat24Error("invalid-argument", "bad input", { cause });
  assert(error instanceof Error && error instanceof index.Fiat24Error, "instanceof");
  assert(error.name === "Fiat24Error", "name");
  assert(error.code === "invalid-argument", "code");
  assert(error.cause === cause, "cause");
  print("HERMES_SMOKE_OK");
} catch (error) {
  print(
    `HERMES_SMOKE_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  quit(1);
}
