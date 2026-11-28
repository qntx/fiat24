# live-verify

An owner-run, **read-only** live verification of a real Fiat24 account. The script performs public
chain reads, builds the SDK's session-grant message, obtains a `personal_sign` from a Ledger
(without the script ever touching a key), issues an explicit allow-list of four GETs against
`api.fiat24.com`, and writes a local Markdown report that contains **shapes and counts only** — no
values, no PII. You read the report and decide whether to share it.

## What it does

1. **Chain reads** (Arbitrum One): resolves the account NFT, prints owner, status, the 30-day
   limit, the four cash-token balances and the deployment check to the terminal.
2. **`GET /timestamp`** to measure clock skew (aborts when it exceeds 300 s).
3. Builds the session grant (`fiat24-session-v1:…` label + `I agree to access my profile. 0x…`
   message) with a short deadline (default 180 s).
4. Obtains one `personal_sign` — via `cast` + Ledger, or pasted from a wallet UI.
5. Issues exactly three secured GETs: `GET /br`, `GET /cards`,
   `GET /transactions?currency=ALL&recordscount=100`.
6. Classifies payout refs in your own transactions' receipts (O-3/O-9).
7. Writes `live-verify-report.md` (file mode `0600`).

## Hard guarantees

- A **transport guard** sits between the SDK and `fetch`: only the four GETs above pass. Writes,
  `/verify`, `PUT /email`, any other path, origin, query, method, body or redirect mode are refused
  before the request is made. A refusal aborts the run.
- The session object is read-only by construction: `write` rejects without calling fetch; there is
  no re-grant on a 401 (a 401 is the answer to "does the server accept the label?").
- The grant lives **in memory only**. The signature, headers and session label are never logged,
  never written to disk, and never appear in the report.
- The report contains **shapes only**: JSON paths, type kinds, format classes (e.g. `iban-like`,
  `masked`, `hash32`), length/digit buckets and counts — never a single response value.
- `--dry-run` exercises the whole pipeline (guard included) without any request to
  `api.fiat24.com` and without signing.

## Install

- Bun 1.4 (`bun install` in the repo)
- Foundry `cast` (`curl -L https://foundry.paradigm.xyz | bash && foundryup`) — only for
  `--signer cast`
- A Ledger with the Ethereum app, holding the account NFT's owner key
- An Arbitrum One RPC endpoint

## Usage

```bash
# 1. Dry run first — nothing is sent, nothing is signed.
bun scripts/live-verify.ts --owner 0xYourAddress --rpc https://arb1.example --dry-run

# 2. Sign with a Ledger via cast (Ledger Live derivation account 0 by default).
bun scripts/live-verify.ts --owner 0xYourAddress --rpc https://arb1.example

# Legacy derivation path or another account index:
bun scripts/live-verify.ts --token-id 690333 --rpc https://arb1.example --account-index 2
bun scripts/live-verify.ts --token-id 690333 --rpc https://arb1.example --hd-path "m/44'/60'/0'/0"

# 3. Or paste a signature produced by a wallet UI.
bun scripts/live-verify.ts --owner 0xYourAddress --rpc https://arb1.example --signer paste
```

## Flags

| Flag                   | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `--owner 0x…`          | resolve the account by owner address (exclusive with `--token-id`) |
| `--token-id N`         | account token id (exclusive with `--owner`)                        |
| `--rpc <url>`          | Arbitrum One RPC; or env `FIAT24_RPC`; required                    |
| `--signer cast\|paste` | signature source (default `cast`)                                  |
| `--hd-path <m/…>`      | Ledger derivation path (legacy style)                              |
| `--account-index N`    | Ledger Live index → `m/44'/60'/N'/0/0` (default 0)                 |
| `--ttl 60-600`         | grant lifetime in seconds (default 180)                            |
| `--out <path>`         | report file (default `live-verify-report.md`)                      |
| `--dry-run`            | exercise everything without contacting api.fiat24.com or signing   |
| `--help`               | usage                                                              |

## Signing with `cast` and a Ledger

`cast wallet address --ledger` confirms the device derives the account owner (else the script
suggests `--account-index N` or `--hd-path`), then `cast wallet sign --ledger … <message>` asks the
device to sign. If `cast` cannot reach the Ledger, the script prints a checklist: connect and
unlock with the PIN; open the Ethereum app until ready; quit Ledger Live/Ledger Wallet and any
browser wallet holding the device; Ethereum app ≥ 1.9.19 shows the message text ("Blind signing" is
not needed for a personal message); Linux needs the Ledger udev rules.

Expected device screens (wording varies by model/firmware):

- **Nano S Plus / X**: "Sign message" → message text pages
  `I agree to access my profile. 0x…` → "Sign message" to approve or "Cancel" to reject.
- **Stax / Flex**: "Review message" → the message text → "Hold to sign".
- **Older Ethereum app versions** show "Message hash" = SHA-256 of the message — the script prints
  that digest so you can compare it character by character.

Before approving, check: the text starts with `I agree to access my profile. 0x` and the 64-hex
digest equals the one printed in the terminal.

## Signing with a wallet UI (`--signer paste`)

There is no `--signature 0x…` flag: the signed message embeds this run's deadline, so a signature
can only exist after the run has printed the message. The `signature>` prompt is that flag,
interactively.

Rabby and MetaMask have no built-in "sign arbitrary text" screen — they are the connector between
the Ledger and the signing UI. The steps:

1. Connect the Ledger to Rabby or MetaMask (hardware-wallet import; the Ethereum app open on the
   device, Ledger Live closed) and select the owner account.
2. Open Etherscan → "Verified Signatures" → "Sign Message", connect with Rabby/MetaMask and
   confirm the connected address is the owner.
3. Paste the message exactly as printed (one line, no extra spaces or newline) and click
   "Sign Message".
4. The wallet shows the text, then the Ledger shows it — check it as in the `cast` section above
   and approve.
5. Copy the "Signature Hash" and paste it at the `signature>` prompt.
6. Close the dialog **without** clicking "Publish" — publishing makes the bearer credential public
   while it is still valid.

The pasted signature stays in the terminal scrollback and the browser tab — close or clear both
afterwards. After the deadline it is harmless anyway: the grant has expired.

## What the report contains

Header (date, ttl, signer mode), account facts limited to status enum, tokenId digit count and the
deployment check; per endpoint: whether it was sent, HTTP status, content-type class, SDK outcome,
a shape table, and diffs against the SDK zod schema and the synthetic fixture. Then the answered
open questions:

- **O-1** — is the `fiat24-session-v1:` label accepted? (`yes` on a secured 2xx, `no` on a 401,
  `inconclusive` otherwise)
- **O-2** — clock skew bucket (`<1s`, `1-5s`, `5-30s`, `30-300s`) with sign; whether a `ttl=N`
  grant was accepted. The documented 1200 s server cap is **not** tested — by design this script
  never signs a longer grant.
- **O-7** — `GET /cards` HTTP status and body `statusCode` class (200/404/other).
- **O-3 / O-9** — payout-ref counts: `prefixed+padded-45`, `prefixed-unpadded`, `invalid`,
  `payout` (no ref) events, unreadable receipts.

### Limits of the redaction

JSON keys are printed verbatim only when they look like identifiers (`^[a-z][A-Za-z0-9_]{0,39}$`
or `^[A-Z]{2,5}$`) or already occur in the SDK fixtures; every other key becomes a classified
placeholder such as `<key:iban-like>`. Response **values** are never printed — only their format
class and a length/digit bucket. This is a heuristic, not a proof — which is why the report closes
by telling you to read the whole file before sharing it.

## Aborting and residual risk

Ctrl-C before signing aborts everything; rejecting on the device aborts the run after `cast`
fails. Once you have signed, the credential cannot be revoked — it simply expires at the printed
deadline. **For the grant's lifetime the signature is a bearer credential for the whole account**
(profile, card display tokens, card changes, payees via `/verify`, `PUT /email`) even though this
script only reads. Until the deadline passes, do not share your terminal or screen.
