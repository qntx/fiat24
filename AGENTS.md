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

All layers have landed: `abi` (generated from `data/`), `core`, `deployments`, `calls`, `events`, `chain` (read actions plus the `fiat24PublicActions` decorator), `api` (REST client, session grants, `/verify` bindings) and `flows` (the seven resumable flows of SPEC §10).

## Source data

`data/` is the single source of truth: `data/abis/*.json` (the full verified ABIs exactly as verified, never hand-reduced), `data/deployments.json` (proxy address, pinned implementation address, runtime code keccak, the block they were read at), `data/SOURCE.md` (per-contract provenance: Sourcify match type, verified-source file hashes, retrieval date, URL). `bun run abi` fetches both from Sourcify; `bun run gen` writes `packages/fiat24/src/abi/*.ts` (`as const`) and `packages/fiat24/src/deployments/data.ts`; `bun run lint` runs it in check mode so generated files never drift. `scripts/deployments/verify.ts` re-reads every pinned value from chain. `packages/fiat24/tests/fixtures/api/` holds the api fixtures: public bodies recorded byte-identically with provenance and SHA-256 in `SOURCE.json`, secured bodies synthetic from the documentation examples with PII replaced by `PII-SENTINEL-n` placeholders.

## TypeScript (`packages/fiat24`)

- `viem` is a peer dependency (caret range); `zod` (used as `zod/mini`) is the only other runtime dependency (caret range). devDependencies are exact-pinned. Nothing else without owner approval.
- `src/` is platform-neutral and Hermes V1-safe: no Node or browser globals, no `node:*` imports, no ES2023+ array methods (`tsconfig.src.json` compiles `src` against `es2022`), no `Buffer`, no `crypto.subtle`, no top-level side effects (`"sideEffects": false`), no module-level mutable state. All I/O is injected (`fetch`, `now`, the viem client, the signer); `fetch` defaults to a call-time `globalThis.fetch` lookup. No ambient singletons.
- One-directional layering, enforced by lint (`LAYERS` in the root `vite.config.ts`): `abi` is the leaf (generated data); `core` imports `abi`; `deployments` imports `core`; `calls` (calldata builders returning `{ to, data, value }` + typed intent) and `events` (log decoding) import `abi`, `core`, `deployments`; `chain` (viem-style read actions `(client, args)`, deployment verification, availability) imports `abi`, `core`, `deployments`, `calls`, `events`; `api` (session grant, HTTP client, schemas) imports `core` only; `flows` (resumable state machines) imports `core`, `deployments`, `calls`, `events`, `chain`, `api`. Every layer is a subpath export. The root entry composes the chain-stack public surface and must not import `api` or `flows` — consumers opt into them via the `@qntx/fiat24/api` and `@qntx/fiat24/flows` subpaths.
- No `any`, no non-null assertions, no enums, no classes except `Fiat24Error`, no default exports, `bigint` for every amount and token id (never `number`), `readonly` data. No thrown strings and no untyped throws from any parser of untrusted data.

## Shared semantics

The SDK throws a single `Fiat24Error` whose `code` is the closed union `Fiat24ErrorCode` (declared as the `fiat24ErrorCodes` tuple in `core/errors.ts`) shared with the failure cases in `vectors/`. Messages are fixed English templates; no error carries a `cause`, response body, header, query string, signature or PII. Every function throws on failure and returns plain values; there are no result wrappers.

- Money: amounts are `bigint` minor units (cash tokens and F24 2 decimals, USDC 6). `parseAmount` accepts only `^[0-9]+(\.[0-9]+)?$` up to 40 characters, never rounds (`too-many-decimals`) and refuses `>= 10^18`; `formatAmount` prints exactly the asset's decimals. Builders refuse zero. Limits are CHF cents. API money numbers are display only.
- Accounts: a `tokenId` is `1 … 2^256 − 1`; 9100–9299 are internal desks and are never P2P recipients (by id or by resolved address). Client mints are standard 6-digit ids `100000 … 799999`. `ibanOf` is defined for `1 … 10^11 − 1` (above that the Arbitrum and Mantle IBANs collide).
- Calls: builders are pure and return `{ to, data, value, intent, contracts }` for the pinned proxy; approvals are bounded (`< 10^18` in the builder, `<= totalSupply` in flows) and their spender is an enum, never an address. Payout `ref`s carry the payer's `tokenId` prefix and are passed verbatim, NUL padding included. Reverts map through the §6.3 table (`revertCode`); the deposit contract's `STF`/`ST`/`SA` stay `contract-revert`, so flows pre-check each transfer leg with the token's own `tokenTransferAllowed`.
- Events: decoding is keyed by `(address, topic0)` of the pinned contracts; unknown pairs are `undefined`, malformed or non-canonical data, strings over 1024 bytes and pending logs are `malformed-log`. History windows are sequential, `chunkSize` `1 … 10^7` (default 100,000), no adaptive splitting; history is only as complete as the RPC.
- Chain reads: one block per action (returned as `blockNumber`); only chain 42161; values operators can change are read at run time, never embedded. No SDK multicall. `verifyDeployment` checks the EIP-1967 implementation and admin slots and the wiring pointers; implementation code hashes are checked off the write path by `scripts/deployments/verify.ts`.
- API: base `https://api.fiat24.com`, `network: 42161` and `cache-control: no-store` on every request, no `fetch` `cache` option, no timeout and no automatic retry (writes are never retried). A session grant is lazy, lasts 600 s, is refused when the server clock is off by more than 300 s, re-grants at most once per session on a read 401, and dies on `end()`. `/verify` answers are bound value by value to the request before use. JSON numbers in amount and id positions must be safe integers or decimal strings (a fractional display amount at most 15 significant digits); anything else is `invalid-response`.
- Flows: `start*` validates and returns a state; `advance*` validates the state (persisted state is untrusted), checks the signer address against `owner`, re-reads the chain at a fresh block, verifies the deployment of every contract on the path before any guard read, and throws only when no transition happened. Every returned state is persisted once. Before a send the flow persists `sending` with an SDK-chosen nonce; a `sending`/`unknown` transaction is never resent, only reconciled: a record that carries a hash is reconciled first by that hash's receipt (a mined own-hash transaction is never `not-sent`; a mismatch is `unknown` with `mismatch`), `not-sent` requires the latest nonce at two different blocks and the pending nonce to be `<= N`, and a consumed nonce no own receipt explains stays `unknown` — logs only surface candidates. `confirmed` is re-checked on advance; nothing persisted depends on a receipt's block (`loadPayoutSettlement` re-reads it). Exact-out FX is sent only while the allowance equals the quoted input; quotes are re-checked before every send (`quote-changed`). Persisted state holds only the §10.2 fields (plus `actual`, `reason` and per-flow `quote` subsets), never PII; payout drafts stay in memory. Card API writes are issued once and reconciled by a single `GET /cards` read.

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
