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
