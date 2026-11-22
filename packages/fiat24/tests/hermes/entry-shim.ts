/**
 * Second Hermes smoke entry (I15): `shim.ts` replaces the native TextEncoder/TextDecoder with a
 * minimal pure-JS UTF-8 implementation _before_ viem/src modules evaluate (their module-level `new
 * TextEncoder()` singletons then capture the shim), then the same checks run and the
 * construction/use counters prove the shim — not the natives — served every call.
 *
 * `shared.ts` is imported dynamically: import sorting would otherwise hoist the static SDK imports
 * ahead of the shim installation. Pass contract: `HERMES_SHIM_SMOKE_OK`.
 */
import { hermesShimInstalled, shimStats } from "./shim.ts";

declare function print(msg: string): void;
declare function quit(code: number): void;

async function bootstrap(): Promise<void> {
  if (!hermesShimInstalled) {
    throw new Error("shim not installed");
  }
  const { runSmoke } = await import("./shared.ts");
  runSmoke();
  if (shimStats.encoders === 0 || shimStats.decoders === 0) {
    throw new Error("shim was never constructed");
  }
  if (shimStats.encodes === 0 || shimStats.decodes === 0) {
    throw new Error("shim was never used");
  }
  print(
    `HERMES_SHIM_SMOKE_OK encoders=${shimStats.encoders} decoders=${shimStats.decoders} encodes=${shimStats.encodes} decodes=${shimStats.decodes}`,
  );
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    await bootstrap();
  } catch (error) {
    print(
      `HERMES_SHIM_SMOKE_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    quit(1);
  }
})();
