/// <reference types="node" />
/**
 * Bundle the two Hermes entries into classic scripts and run each on the Hermes CLI (`HERMES` env
 * var):
 *
 * 1. `entry.ts` — the native run: bare-Hermes TextEncoder/TextDecoder (RN 0.88).
 * 2. `entry-shim.ts` — replaces both globals with a pure-JS UTF-8 shim before the SDK modules
 *    evaluate, then asserts the shim served every encode/decode.
 *
 * Each run must print its marker (`HERMES_SMOKE_OK` / `HERMES_SHIM_SMOKE_OK`); Hermes exits 0 on
 * unhandled async rejections, so the markers are the only contract. Full output is printed.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo does not depend on @types/bun; declare the used surface.
type BunBuildOutput = {
  success: boolean;
  logs: ReadonlyArray<{ toString: () => string }>;
  outputs: ReadonlyArray<{ kind: string }>;
};
declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
  }) => Promise<BunBuildOutput>;
  write: (path: string, data: unknown) => Promise<unknown>;
  spawnSync: (
    cmd: ReadonlyArray<string>,
    options: { stdout: "pipe"; stderr: "pipe" },
  ) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const root = fileURLToPath(new URL("..", import.meta.url));

type Bundle = { entry: string; out: string; marker: string };
const BUNDLES: Bundle[] = [
  {
    entry: "tests/hermes/entry.ts",
    out: ".hermes-smoke.iife.js",
    marker: "HERMES_SMOKE_OK",
  },
  {
    entry: "tests/hermes/entry-shim.ts",
    out: ".hermes-smoke-shim.iife.js",
    marker: "HERMES_SHIM_SMOKE_OK",
  },
];

async function main(): Promise<number> {
  const hermes = process.env["HERMES"];
  if (hermes === undefined || hermes === "") {
    console.error("set HERMES to the hermes binary");
    return 1;
  }

  for (const { entry, out, marker } of BUNDLES) {
    const result = await Bun.build({
      entrypoints: [resolve(root, entry)],
      target: "browser",
      format: "iife",
    });
    if (!result.success) {
      for (const log of result.logs) {
        console.error(String(log));
      }
      return 1;
    }
    const bundle = result.outputs.find((o: { kind: string }) => o.kind === "entry-point");
    if (!bundle) {
      console.error(`bun build produced no entry-point output for ${entry}`);
      return 1;
    }
    const outfile = resolve(root, out);
    await Bun.write(outfile, bundle);

    const proc = Bun.spawnSync([hermes, outfile], { stdout: "pipe", stderr: "pipe" });
    const text = proc.stdout.toString() + proc.stderr.toString();
    process.stdout.write(text);
    if (proc.exitCode !== 0 || !text.includes(marker)) {
      console.error(`hermes smoke failed for ${entry} (exit ${proc.exitCode}): no ${marker}`);
      return 1;
    }
  }
  return 0;
}

process.exitCode = await main();
