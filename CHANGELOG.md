# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `vX.Y.Z` tag runs `publish-npm.yml` (publishing `packages/fiat24` via npm
trusted publishing / OIDC) and `release.yml` (the GitHub Release).

## [Unreleased]

## [0.1.0] - Unreleased

First release of `@qntx/fiat24`, an unofficial SDK for the Fiat24 protocol on
Arbitrum One (chain id 42161). Not affiliated with or endorsed by SR
Saphirstein AG.

### Added

- `abi` and `deployments`: the verified ABIs and the pinned deployment
  (proxies, implementations, admin, wiring) generated from `data/`.
- `core`: `Fiat24Error` with the closed `Fiat24ErrorCode` union, amount
  parsing and formatting, account-id rules, IBAN derivation and validation,
  revert decoding and the `Fiat24Signer` seam.
- `calls`: data-first builders for transfer, exchange, payout, approve,
  mint and top-up, each returning `{ to, data, value }` plus a typed intent.
- `events`: decoding of every Fiat24 event the SDK reports.
- `chain`: viem-style read actions (account, balances, allowances,
  availability, deployment verification, FX and top-up quotes, transfer
  checks, payout minimum and settlement, mint quote, history, simulation)
  and the `fiat24PublicActions` client decorator.
- `api`: the REST client for public endpoints, session grants with local
  lifetime bounds, secured reads, `/verify` bindings and card writes.
- `flows`: resumable state machines for the account view, P2P transfer, FX
  exchange, payout, card management, onboarding and USDC top-up, with
  persist-before-send, SDK-chosen nonces and reconciliation that never
  resends.
