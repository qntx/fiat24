<!-- markdownlint-disable MD033 MD041 -->

# fiat24

An unofficial, wallet-independent TypeScript SDK for the Fiat24 protocol on Arbitrum One: [`@qntx/fiat24`](packages/fiat24) on npm.

> **Status: pre-release.** Nothing is published yet. The `abi`, `core`, `deployments`, `calls`, `events` and `chain` layers are implemented (plus `api`'s session label helpers and the `fiat24PublicActions` viem decorator); the `api` HTTP client and `flows` are still pending.

This project is not affiliated with or endorsed by SR Saphirstein AG. "Fiat24" is used only to identify the protocol the SDK talks to; no partnership is claimed.

## Layout

```text
packages/fiat24/  @qntx/fiat24 — platform-neutral TypeScript SDK, layered
                  (abi, core, deployments, calls, events, chain, api,
                  flows), one subpath export per layer
data/             verified protocol ABIs (data/abis), the on-chain-verified
                  deployment table (data/deployments.json) and per-contract
                  provenance (data/SOURCE.md)
vectors/          shared test vectors produced by independent oracles
scripts/          repository tooling: gen.ts, version checks, API reports
.github/          workflows, rulesets (protection as code), CODEOWNERS
```

## Commands

```bash
bun install
bun run lint && bun run typecheck && bun run build && bun run test
bun run check:pkg
```

The contributor invariants and the full local gate live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project shall be dual-licensed as above, without any additional terms or conditions.

---

<div align="center">

A **[QuantX](https://qntx.org)** open-source project.

<a href="https://qntx.org"><img alt="QuantX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx.svg" /></a>

Code is law. We write both.

</div>
