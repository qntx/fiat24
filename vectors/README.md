# vectors/

Shared test vectors, produced by an independent oracle and consumed by the
TypeScript tests under `packages/fiat24/tests/`. Nothing here is written by
hand against our own implementation: expected outputs come from a reference
(`cast`, chain reads at a pinned block, recorded upstream responses) or a
spec reading, never from the SDK itself.

Each generator lives in `packages/fiat24/scripts/vectors/`, writes
`vectors/<area>/<name>.json`, and is run in check mode by `bun run lint`
(`bun run vectors --check`).

## Files

```text
vectors/core/amount.json      parseAmount/formatAmount (core.amount)
vectors/core/iban.json        ibanOf/isValidIban (core.iban)
vectors/core/iban-registry.json isValidIban vs SWIFT IBAN Registry R103
                              (schwifty oracle, core.iban-registry)
vectors/calls/calldata.json   the nine call builders (calls.calldata)
vectors/events/decode.json    decodeFiat24Log over recorded + synthetic logs
                              (events.decode)
vectors/api/session.json      sessionLabel/sessionMessage (api.session)
```

## Layout

```text
vectors/<area>/<name>.json    one file per capability, name = capability id
                              without the "<area>." prefix, dots as hyphens
vectors/<area>/<name>.<ext>   official external vectors keep their original
                              format
```

## Schema

JSON files share a single envelope:

```json
{
  "schema": 1,
  "capability": "chain.example",
  "source": { "kind": "reference", "name": "viem", "version": "2.57.12", "generator": "packages/fiat24/scripts/vectors/example.ts" },
  "cases": []
}
```

- `schema` — envelope version, currently always `1`.
- `capability` — the capability id this file exercises.
- `source.kind` — `spec` (hand-authored from the AGENTS.md "Shared
  semantics" rules; expected outputs are written from the spec, not dumped
  from an implementation), `official` (upstream vector, verbatim),
  `reference` (produced by an independent reference implementation; record
  its name and version in `source`), `recorded` (a fixed-block chain read
  or captured public API response; record the block or URL and date in
  `source`), `synthetic` (built from official documentation examples), or
  `generated` (frozen output of the TS implementation; `generator` names
  the producing script and `version` the package version that produced it).
- `cases` — always an array. Success cases carry inputs and expected
  outputs; failure cases carry an `error` field naming the shared
  `Fiat24ErrorCode` (`invalid-argument`, `contract-changed`,
  `unknown-outcome`, ...). Runners branch on the case fields; a file may
  mix case shapes.

The normal form for on-chain values in vector outputs: every integer (any
int/uint width) is a decimal string, addresses are EIP-55, bytes are
lowercase `0x` hex, booleans and strings are native JSON.
