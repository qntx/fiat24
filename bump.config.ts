import { defineConfig } from "bumpp";

// `execute` refreshes bun.lock via sync-versions — bumpp spawns `execute`
// without a shell, so the string must stay a single command with no shell
// operators.
const config: ReturnType<typeof defineConfig> = defineConfig({
  files: ["packages/fiat24/package.json"],
  execute: "bun scripts/sync-versions.ts",
  // execute rewrites bun.lock; commit it too.
  all: true,
  commit: true,
  // main is protected: release through a `release/v<version>` pull request
  // opened via `gh`. No tag is created; after the release PR merges, tag the
  // merge commit by hand (GITHUB_TOKEN tags do not trigger publish workflows).
  pr: true,
  push: true,
});

export default config;
