# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Scope

`@qntx/fiat24` is an unofficial, wallet-independent TypeScript SDK for the Fiat24 protocol (SR Saphirstein AG) on Arbitrum One (chain id 42161) only. Intended scope: the on-chain contracts, the public REST API, and resumable user flows (read, P2P, FX, sessions + secured reads, payouts, card management, onboarding, top-up). Out of scope: Mantle (no verified source), GBP24 (suspended, undocumented), `PUT /email` (it moves the 3-DS OTP channel), Sumsub, and any gateway/proxy.

The SDK never holds keys and never signs: every signature goes through an injected signer. Writes are data first — builders return `{ to, data, value }` plus a typed intent; nothing broadcasts except through the injected signer. Paused or maintenance-mode features are implemented, fork-tested, and report a typed `unavailable` state from on-chain facts at run time; they are never hidden behind build-time flags.

Landed so far: the `abi` layer (generated from `data/`), the `core` layer (errors, money, account ids, IBAN, status, revert decoding, signer and shared types), the `deployments` layer (generated `arbitrum` pin plus lookups), the `calls` layer (the nine §6.1 builders plus the §6.2 grammars), the `events` layer (`decodeFiat24Log(s)` over the §7.1 set), and `api`'s session helpers (`sessionLabel`/`sessionMessage`, §9.2). `chain` and `flows` are still empty subpaths.

## Source data

`data/` is the single source of truth: `data/abis/*.json` (the full verified ABIs exactly as verified, never hand-reduced), `data/deployments.json` (proxy address, pinned implementation address, runtime code keccak, the block they were read at), `data/SOURCE.md` (per-contract provenance: Sourcify match type, verified-source file hashes, retrieval date, URL). `bun run abi` fetches both from Sourcify; `bun run gen` writes `packages/fiat24/src/abi/*.ts` (`as const`) and `packages/fiat24/src/deployments/data.ts`; `bun run lint` runs it in check mode so generated files never drift. `scripts/deployments/verify.ts` re-reads every pinned value from chain.

## TypeScript (`packages/fiat24`)

- `viem` is a peer dependency (caret range); `zod` (used as `zod/mini`) is the only other runtime dependency (caret range). devDependencies are exact-pinned. Nothing else without owner approval.
- `src/` is platform-neutral and Hermes V1-safe: no Node or browser globals, no `node:*` imports, no ES2023+ array methods (`tsconfig.src.json` compiles `src` against `es2022`), no `Buffer`, no `crypto.subtle`, no top-level side effects (`"sideEffects": false`), no module-level mutable state. All I/O is injected (`fetch`, `now`, the viem client, the signer); `fetch` defaults to a call-time `globalThis.fetch` lookup. No ambient singletons.
- One-directional layering, enforced by lint (`LAYERS` in the root `vite.config.ts`): `abi` is the leaf (generated data); `core` imports `abi`; `deployments` imports `core`; `calls` (calldata builders returning `{ to, data, value }` + typed intent) and `events` (log decoding) import `abi`, `core`, `deployments`; `chain` (viem-style read actions `(client, args)`, deployment verification, availability) imports `abi`, `core`, `deployments`, `calls`, `events`; `api` (session grant, HTTP client, schemas) imports `core` only; `flows` (resumable state machines) imports `core`, `deployments`, `calls`, `events`, `chain`, `api`. Every layer is a subpath export. The root entry composes the chain-stack public surface and must not import `api` or `flows` — consumers opt into them via the `@qntx/fiat24/api` and `@qntx/fiat24/flows` subpaths.
- No `any`, no non-null assertions, no enums, no classes except `Fiat24Error`, no default exports, `bigint` for every amount and token id (never `number`), `readonly` data. No thrown strings and no untyped throws from any parser of untrusted data.

## Shared semantics

The SDK throws a single `Fiat24Error` whose `code` is the closed union `Fiat24ErrorCode` (declared as the `fiat24ErrorCodes` tuple in `core/errors.ts`) shared with the failure cases in `vectors/`.

## Versioning and release

`bun run release` runs `bumpp` (`bump.config.ts`), which bumps `packages/fiat24/package.json`, refreshes `bun.lock` via `scripts/sync-versions.ts`, and opens a `release/v<version>` pull request. `scripts/check-version.ts` (part of `bun run lint`) guards drift and enforces the dependency-spec policy. After the release PR merges, tag the merge commit `v*.*.*` and push by hand; the tag runs `publish-npm.yml` (npm trusted publishing / OIDC, `--provenance`) and `release.yml` (GitHub Release).

## Commands

Local gate before a pull request:

```bash
bunx vp cache clean && bunx vp check      # uncached lint + format over every file
bun run lint                            # vp check + check-version + gen --check + vectors --check
bun run typecheck
bun run build
bun run test                            # package tests with coverage thresholds + size budgets,
                                        # then repo-level scripts tests
bun run check:pkg                       # pack + dist-deps + API report + publint + attw
```

More:

```bash
bun run --cwd packages/fiat24 test:fork                    # runs only tests/fork (FIAT24_FORK=1 include
                                                           # switch; needs FIAT24_FORK_URL)
bun run --cwd packages/fiat24 smoke:hermes                 # needs HERMES=/path/to/hermes
bun scripts/check-api.ts packages/fiat24 --update          # re-baseline packages/fiat24/api/
bun scripts/deployments/verify.ts [--block N]              # re-read every deployments.json pin from
                                                           # chain (FIAT24_RPC or Tenderly archive)
bun run abi                                                # fetch data/abis + data/SOURCE.md from Sourcify
bun run abi --check                                        # re-fetch and fail on any difference
bun run gen                                                # regenerate src/abi + src/deployments/data.ts from data/
bun run vectors                                            # regenerate vectors/
```
