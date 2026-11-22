/**
 * Bundle entry for the native Hermes smoke test: the raw Hermes CLI (`hermes`, RN 0.88) provides
 * TextEncoder/TextDecoder natively, so this run exercises the SDK on the real globals.
 * scripts/hermes-smoke.ts bundles this file to a single classic script and runs it on the Hermes V1
 * CLI that React Native ships. The `HERMES_SMOKE_OK` line is the pass contract: Hermes exits 0 even
 * for unhandled errors, so runners assert the marker.
 */
import { runSmoke } from "./shared.ts";

declare function print(msg: string): void;
declare function quit(code: number): void;

try {
  runSmoke();
  print("HERMES_SMOKE_OK");
} catch (error) {
  print(
    `HERMES_SMOKE_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  quit(1);
}
