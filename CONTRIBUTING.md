# Contributing

## Prerequisites

- **Bun 1.4** — package scripts, tests, and tooling.
- **Foundry** (`anvil`, `cast`) — fork tests and vector oracles.

## Repository layout

```text
packages/fiat24/  @qntx/fiat24 — platform-neutral TypeScript SDK (layered:
                  abi, core, deployments, calls, events, chain, api,
                  flows); builds with vp pack
data/             source data: verified ABIs (data/abis) and the on-chain-
                  verified deployment table (data/deployments.json); does
                  not exist yet
vectors/          shared test vectors (see vectors/README.md)
scripts/          repository tooling: gen.ts regenerates src/abi from
                  data/abis (`bun run gen`, checked in lint via --check),
                  check-version.ts and sync-versions.ts guard version
                  drift, check-api.ts snapshots the published API surface
```

## Local gate

Run before opening a pull request:

```bash
bunx vp cache clean && bunx vp check
bun run lint && bun run typecheck && bun run build && bun run test
bun run check:pkg
```

## Versioning and release

`bun run release` runs `bumpp` (`bump.config.ts`), which bumps
`packages/fiat24/package.json`, refreshes `bun.lock`, and opens a
`release/v<version>` pull request. `scripts/check-version.ts` (part of
`bun run lint`) guards drift: internal dependency ranges, the bun.lock
workspace mirror, and each published package's `repository` field.

After the release PR merges, tag the merge commit `v*.*.*` and push it by
hand; one tag publishes npm (`@qntx/fiat24`) and the GitHub Release.

## Commits

English Conventional Commits: `type(scope): subject` (`feat`, `fix`, `docs`,
`style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`), subject
in the imperative mood without a trailing period, ≤ 50 characters. Breaking
changes get a `BREAKING CHANGE:` footer.
