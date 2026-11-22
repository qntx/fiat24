/// <reference types="node" />
/**
 * Bundles each pack entry minified as a browser ESM and enforces its gzip budget. `viem` stays
 * external, as it does for consumers (peer dependency). The root entry must never pull the api or
 * flows layers — they are opt-in subpaths — so its bundle inputs are asserted free of them.
 *
 * Each entry is measured through a synthetic `export *` re-export under `.size-check/` with an
 * empty `package.json` next to it. Without that shield Bun treats a package carrying `name` +
 * `sideEffects: false` + `devEngines` as an external package and marks its own `.ts` imports
 * external, which would make both the sizes and the layer guard pass vacuously.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

type BunBuildMetafile = {
  inputs: Record<
    string,
    { imports?: ReadonlyArray<{ path: string; original?: string; external?: boolean }> }
  >;
};
type BunBuildOutput = {
  success: boolean;
  logs: ReadonlyArray<{ toString: () => string }>;
  metafile?: BunBuildMetafile;
  outputs: ReadonlyArray<{ kind: string; text: () => Promise<string> }>;
};
declare const Bun: {
  build: (options: {
    entrypoints: string[];
    target: "browser";
    format: "esm";
    minify: boolean;
    external: string[];
    metafile: boolean;
  }) => Promise<BunBuildOutput>;
};

const root = fileURLToPath(new URL("..", import.meta.url));

// Each budget is the gzip size measured when the entry was last sized, rounded
// up to the next 1024 B. When an entry grows past its budget, re-measure and
// raise the number deliberately in the same PR.
const ENTRIES = [
  { name: "index", entry: "src/index.ts", budget: 5120 },
  { name: "abi", entry: "src/abi/index.ts", budget: 6144 },
  { name: "core", entry: "src/core/index.ts", budget: 4096 },
  { name: "deployments", entry: "src/deployments/index.ts", budget: 2048 },
  { name: "calls", entry: "src/calls/index.ts", budget: 8192 },
  { name: "events", entry: "src/events/index.ts", budget: 8192 },
  { name: "chain", entry: "src/chain/index.ts", budget: 1024 },
  { name: "api", entry: "src/api/index.ts", budget: 1024 },
  { name: "flows", entry: "src/flows/index.ts", budget: 1024 },
] as const;

// Layers the root entry may never pull: they are opt-in subpaths, and a
// bundled import would grow every consumer (AGENTS.md layering). Checked
// against package-relative metafile input paths, bundled or external.
const FORBIDDEN_ROOT_INPUT = /(^|\/)src\/(api|flows)\//;

const measure = async (
  name: string,
  entry: string,
): Promise<{ bytes: number; inputs: ReadonlyArray<string> }> => {
  // `export *` bundles; `export * as` and bare side-effect imports are also
  // marked external under the package.json quirk described above.
  writeFileSync(resolve(root, ".size-check", `${name}.ts`), `export * from "../${entry}";\n`);
  const result = await Bun.build({
    entrypoints: [resolve(root, ".size-check", `${name}.ts`)],
    target: "browser",
    format: "esm",
    minify: true,
    external: ["viem"],
    metafile: true,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(String(log));
    }
    throw new Error(`size-check: bundle failed for ${entry}`);
  }
  const texts = await Promise.all(result.outputs.map(async (output) => output.text()));
  const bytes = texts.reduce((sum, text) => sum + gzipSync(Buffer.from(text)).length, 0);
  // The root-entry layer guard reads the metafile: missing inputs must fail, never pass vacuously.
  if (result.metafile === undefined) {
    throw new Error(`size-check: no metafile for ${entry}`);
  }
  // Imports marked external never become inputs of their own; they stay visible only as
  // specifiers in the importer's imports array. Resolve both forms to package-relative paths.
  const inputs = new Set<string>();
  for (const [key, input] of Object.entries(result.metafile.inputs)) {
    inputs.add(key);
    for (const specifier of input.imports ?? []) {
      const spec = specifier.original ?? specifier.path;
      inputs.add(spec.startsWith(".") ? normalize(join(dirname(key), spec)) : spec);
    }
  }
  return { bytes, inputs: [...inputs] };
};

async function main(): Promise<number> {
  let failed = false;
  const dir = resolve(root, ".size-check");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "package.json"), "{}\n");
  try {
    for (const { name, entry, budget } of ENTRIES) {
      const { bytes, inputs } = await measure(name, entry);
      console.log(`size-check ${name}: ${bytes} B gzipped (budget ${budget} B)`);
      if (bytes > budget) {
        console.error(`size-check ${name}: budget exceeded`);
        failed = true;
      }
      if (name === "index") {
        for (const input of inputs) {
          if (FORBIDDEN_ROOT_INPUT.test(input)) {
            console.error(`size-check ${name}: bundle pulls opt-in layer (${input})`);
            failed = true;
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
