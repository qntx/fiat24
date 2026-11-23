# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `vX.Y.Z` tag runs `publish-npm.yml` (publishing `packages/fiat24` via npm
trusted publishing / OIDC) and `release.yml` (the GitHub Release).

## [Unreleased]

## [0.1.0] - 2026-11-23

First release of `@qntx/fiat24`, an unofficial SDK for the Fiat24 protocol on
Arbitrum One (chain id 42161). Not affiliated with or endorsed by SR
Saphirstein AG.

### Added

- `abi` and `deployments`: the verified ABIs and the pinned deployment
  (proxies, implementations, admin, wiring) generated from `data/`;
  every exported constant table is deep-frozen.
- `core`: `Fiat24Error` with the closed `Fiat24ErrorCode` union,
  amount parsing and formatting, account-id rules, IBAN derivation and
  validation (LY included; unregistered countries pass the generic
  check), revert decoding and the `Fiat24Signer` seam.
- `calls`: data-first builders for transfer, exchange, payout, approve,
  mint and top-up, each returning `{ to, data, value }` plus a typed
  intent; `approveCall` alone accepts `0n` (allowance revoke).
- `events`: decoding of every Fiat24 event the SDK reports.
- `chain`: viem-style read actions (account, balances, allowances,
  availability, deployment verification, FX and top-up quotes, transfer
  checks, payout minimum and settlement, mint quote, history,
  simulation) and the `fiat24PublicActions` client decorator. Paused or
  maintenance-mode features report a typed `unavailable` reason read
  from the chain at run time.
- `api`: the REST client for public endpoints (redirects refused, the
  response body capped while streaming, display and id JSON numbers
  required safe), session grants (label
  `fiat24-session-v1:<chainId>:<tokenId>:<deadline>;`) with local
  lifetime bounds and the exported `SessionArgs`, `sessionLabel` and
  `sessionMessage`, secured reads, `/verify` bindings and card writes
  (card `create` counts as done only on an `Active` card).
- `flows`: resumable state machines for the account view, P2P transfer,
  FX exchange, payout, card management, onboarding and USDC top-up.
  `FlowDeps` injects `client`, `signer` and `persist` (no clock), and
  states serialise with `encodeFlowState`/`decodeFlowState`.
  Every chain read happens at a `verifiedBlock` that asserts the pinned
  deployment of the contracts it touches first. Persist-before-send with
  SDK-chosen nonces; a hash-carrying record reconciles by its own
  receipt (a mined own-hash transaction is never `not-sent`; a binding
  mismatch is `unknown` with `mismatch`); `not-sent` needs the nonce at
  two blocks plus the pending count; `confirmed` re-checks the
  receipt on advance; payout settlement is read with
  `loadPayoutSettlement` from a fresh receipt; reconciliation never
  resends.
