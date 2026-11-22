<!-- markdownlint-disable MD033 MD041 -->

# `@qntx/fiat24`

An unofficial TypeScript SDK for the Fiat24 protocol on Arbitrum One. Not affiliated with or endorsed by SR Saphirstein AG; "Fiat24" is used only to identify the protocol.

> **Status: pre-release.** Nothing is published yet. Implemented so far: the `abi`, `core`, `deployments`, `calls`, `events` and `chain` layers (the §3.6 read actions plus the `fiat24PublicActions` viem decorator) and `api`'s session label helpers (`sessionLabel`/`sessionMessage`); the `api` HTTP client and `flows` are pending.

Platform-neutral (Node, browsers, Hermes): one subpath export per layer — `@qntx/fiat24` plus `/abi`, `/core`, `/deployments`, `/calls`, `/events`, `/chain`, `/api`, `/flows`. `viem` is a peer dependency.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.
