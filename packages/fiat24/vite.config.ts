import { configDefaults, defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

/** ESM-only sugar flattens to a string; keep types/import/default for pack entries. */
export function applyPackExports(pkgExports: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(pkgExports)) {
    if (typeof value !== "string" || !value.endsWith(".mjs")) {
      continue;
    }
    pkgExports[key] = {
      types: value.replace(/\.mjs$/, ".d.mts"),
      import: value,
      default: value,
    };
  }
  return pkgExports;
}

const config: UserConfig = defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      abi: "src/abi/index.ts",
      core: "src/core/index.ts",
      deployments: "src/deployments/index.ts",
      calls: "src/calls/index.ts",
      events: "src/events/index.ts",
      chain: "src/chain/index.ts",
      api: "src/api/index.ts",
      flows: "src/flows/index.ts",
    },
    deps: {
      // Every third-party import must resolve as an external dependency; a src import that
      // lands in dist because it is undeclared is a packaging bug.
      onlyBundle: [],
    },
    dts: {
      generator: "tsgo",
    },
    sourcemap: true,
    exports: {
      customExports: applyPackExports,
    },
  },
  test: {
    // `bun run test` must never collect the anvil fork suite (SPEC §11.5); `test:fork` sets
    // FIAT24_FORK=1 to flip the include to it exclusively.
    include:
      process.env["FIAT24_FORK"] === "1" ? ["tests/fork/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude:
      process.env["FIAT24_FORK"] === "1"
        ? configDefaults.exclude
        : [...configDefaults.exclude, "tests/fork/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/abi/**", "src/deployments/data.ts"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});

export default config;
