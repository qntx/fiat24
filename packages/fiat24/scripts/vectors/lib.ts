import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHECK = process.argv.includes("--check");
const ROOT = new URL("../../../../", import.meta.url).pathname;

let drifted = 0;

// Envelope `source` (vectors/README.md): `kind` plus whichever of name,
// version, date, url, block or evidence identifies the oracle that produced
// the expected outputs; `generator` names the producing script.
export type VectorSource = {
  readonly kind: "spec" | "official" | "reference" | "recorded" | "synthetic" | "generated";
  readonly name?: string;
  readonly version?: string;
  readonly date?: string;
  readonly url?: string;
  readonly block?: string;
  readonly evidence?: string;
  readonly skipped?: number;
  readonly generator: string;
};

export function vectorFile(
  relative: string,
  capability: string,
  source: VectorSource,
  cases: unknown[],
): void {
  const envelope = { schema: 1, capability, source, cases };
  const path = `${ROOT}${relative}`;
  const content = `${JSON.stringify(envelope, null, 2)}\n`;
  if (CHECK) {
    let existing: string | undefined;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== content) {
      console.error(`drift: ${relative}`);
      drifted += 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${relative} (${cases.length} cases)`);
}

export function finish(): void {
  if (CHECK) {
    if (drifted > 0) {
      console.error(`${drifted} vector file(s) out of date — run bun run vectors`);
      process.exitCode = 1;
    }
    console.log("vectors up to date");
  }
}

// The repo does not depend on @types/bun; declare the used surface (same
// pattern as packages/fiat24/scripts/hermes-smoke.ts).
declare const Bun: {
  spawnSync: (
    cmd: ReadonlyArray<string>,
    options: { stdout: "pipe"; stderr: "pipe" },
  ) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

/**
 * The vector oracle (§11.1): `cast` 1.x run synchronously. Expected values are produced by foundry
 * tooling or recorded bytes, never by SDK code; check mode re-runs the same commands and never
 * touches the network.
 */
export function cast(args: ReadonlyArray<string>): string {
  const out = Bun.spawnSync(["cast", ...args], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`cast ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  }
  return out.stdout.toString().trim();
}
