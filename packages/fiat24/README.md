<!-- markdownlint-disable MD033 MD041 -->

# `@qntx/fiat24`

An unofficial TypeScript SDK for the Fiat24 protocol on Arbitrum One. Not affiliated with or endorsed by SR Saphirstein AG; "Fiat24" is used only to identify the protocol.

> **Status: pre-release.** Nothing is published yet. Implemented so far: the `abi`, `core`, `deployments`, `calls`, `events`, `chain` and `api` layers (the §3.6 read actions plus the `fiat24PublicActions` viem decorator, and the §9 REST client with session grants, `/verify` bindings and `parseSwissQr`); `flows` is pending.

Platform-neutral (Node, browsers, Hermes): one subpath export per layer — `@qntx/fiat24` plus `/abi`, `/core`, `/deployments`, `/calls`, `/events`, `/chain`, `/api`, `/flows`. `viem` is a peer dependency.

## API host obligations

The `api` layer is for React Native and server hosts.

- There is no CORS support: every request carries the non-safelisted `network` header and `OPTIONS` answers without `Access-Control-Allow-*`.
- The SDK sets no timeout; the host `fetch` must time out or abort. An aborted request becomes `network-error`.
- `/verify?sp=` and `/verify?qr=` carry the payee's name, address and account in the query string; `/banks/iban/{iban}` carries an IBAN in the path by Fiat24's design.
- `api.fiat24.com` must be excluded from network instrumentation such as Sentry, Flipper, proxies or logging interceptors, or an uninstrumented `fetch` must be injected. Request URLs and headers of secured calls must never be logged.
- Platform HTTP caches must be configured so `api.fiat24.com` responses are not stored (iOS `NSURLCache`, Android OkHttp cache).
- A session grant is a bearer credential: the server checks only that `sign` is the account owner's `personal_sign` of the grant message, so until `deadline` anyone holding the four grant header values (`tokenid`, `hash`, `deadline`, `sign`) can call every secured endpoint of that account: profile data, card display tokens, card creation/status/currency/device-token changes, payee creation via `/verify`, and `PUT /email`, which moves the one-time-password channel and which this SDK never calls. A wallet prompt must say what the grant permits.
- The SDK grants for 600 seconds and refuses a grant when the server clock differs from the local clock by more than 300 seconds.
- Owners that cannot produce an ECDSA `personal_sign` signature, including contract wallets, cannot open sessions.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.
