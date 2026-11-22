<!-- markdownlint-disable MD033 MD041 -->

# `@qntx/fiat24`

An unofficial TypeScript SDK for the Fiat24 protocol on Arbitrum One. Not affiliated with or endorsed by SR Saphirstein AG; "Fiat24" is used only to identify the protocol.

> **Status: pre-release (0.1.0, unreleased).** Nothing is published yet. All layers are implemented: `abi`, `core`, `deployments`, `calls`, `events`, `chain` (read actions and the `fiat24PublicActions` viem decorator), `api` (REST client with session grants) and `flows` (resumable user flows).

Platform-neutral (Node, browsers, Hermes): one subpath export per layer — `@qntx/fiat24` plus `/abi`, `/core`, `/deployments`, `/calls`, `/events`, `/chain`, `/api`, `/flows`. `viem` is a peer dependency. Only Arbitrum One (chain id 42161) is supported; Mantle and GBP24 are not.

## Usage

### Reads

<!-- example: tests/readme/reads.ts -->

```ts
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

import { fiat24PublicActions } from "@qntx/fiat24";

const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) }).extend(
  fiat24PublicActions(),
);
const account = await client.fiat24GetAccount({ owner });
const { balances } = await client.fiat24GetBalances({ owner });
```

Every read pins one block and returns it as `blockNumber`. Balances, status, limits, minimums, rates and ownership come only from the chain; numbers returned by the REST API are for display.

### The signer

The SDK holds no keys and never signs. Writes go through an injected `Fiat24Signer`:

<!-- example: tests/readme/signer.ts -->

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import type { Fiat24Signer } from "@qntx/fiat24";

const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(rpcUrl) });

const signer: Fiat24Signer = {
  address: account.address,
  // Sign and broadcast exactly these bytes with exactly this nonce, or throw before broadcasting.
  sendTransaction: async ({ to, data, value, nonce }) =>
    wallet.sendTransaction({ to, data, value, nonce }),
  // personal_sign of the grant message; the wallet should rebuild it from (chainId, tokenId, deadline).
  signSessionGrant: async ({ message }) => wallet.signMessage({ message }),
};
```

`sendTransaction` receives `{ chainId: 42161, from, to, data, value, nonce, intent }`. The signer must sign and broadcast exactly those bytes with exactly the given `nonce` (gas and fees are the signer's), resolve with the transaction hash once broadcast, throw `Fiat24Error("signer-rejected")` (or an EIP-1193 `4001` error) when the user declines, and throw before broadcasting when it cannot honour the nonce. A wallet that cannot honour a supplied nonce cannot implement this seam; viem local accounts can. `intent` is advisory display data: a wallet must derive its prompt from `data`. Flows refuse a signer whose `address` differs from the flow's `owner`.

### Flows

Each flow is a resumable state machine: `start*` returns a state, `advance*(deps, state)` performs one step and returns the next state, and the host stores every state through `persist`.

<!-- example: tests/readme/flows.ts -->

```ts
import {
  advanceTransfer,
  decodeFlowState,
  encodeFlowState,
  startTransfer,
} from "@qntx/fiat24/flows";
import type { FlowDeps, TransferState } from "@qntx/fiat24/flows";

const deps: FlowDeps = {
  client,
  signer,
  persist: async (state) => {
    await store.set(id, encodeFlowState(state));
  },
};

let state: TransferState = startTransfer({
  owner: signer.address,
  currency: "EUR24",
  amount: 1000n,
  to: { tokenId: 469709n },
});
while (state.step !== "confirmed" && state.step !== "failed" && state.step !== "not-sent") {
  state = await advanceTransfer(deps, state);
  if (state.txs.at(-1)?.error === "signer-rejected") {
    // The user declined the prompt: stop and show it; advancing again
    // prompts the signer again.
    break;
  }
  if (state.step === "tx") {
    await sleep(15_000);
  }
}

// After a restart: resume from what was persisted, narrowing the decoded union.
const resumed = decodeFlowState(await store.get(id));
if (resumed.flow === "transfer") {
  state = await advanceTransfer(deps, resumed);
}
```

| Flow                   | Start                                  | Steps                                                                                            |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Account (read model)   | `loadAccount(deps, { owner })`         | `no-account`, the account status, or `stale` (the account NFT moved away from this address)      |
| P2P transfer           | `startTransfer`                        | `draft → ready → tx → confirmed`                                                                 |
| FX exchange            | `startExchange`                        | `draft → quoted → tx (approve) → tx (main) → confirmed`                                          |
| Payout (EUR24 / CHF24) | `startPayout`                          | `draft` (memory only) `→ verified → tx → confirmed`; `loadPayoutSettlement` reads the settlement |
| Card                   | `startCardSetup`, `startCardOperation` | `ready → tx (approve) → tx (API write) → confirmed`                                              |
| Onboarding             | `startOnboarding`                      | `check → ready → tx (approve F24) → tx (mint) → tourist → kyc → live / rejected`                 |
| Top-up (USDC)          | `startTopUp`                           | `check → quoted → tx (approve USDC) → tx (main) → confirmed`, or `unavailable`                   |

While a transaction is in flight the step is `tx` and the last entry of `txs` carries its phase (`ready`, `sending`, `submitted`, `unknown`); every flow can also end in `failed` or `not-sent`. `advance*` throws a `Fiat24Error` only when no transition happened (a guard refused, the RPC or API failed); the state is then unchanged and nothing was sent. Every advance re-reads the chain at a fresh block, asserts the pinned deployment of every contract its reads touch before the first read, and re-runs its guards before any send; a persisted state is untrusted input and calls are always rebuilt from its fields.

Rules for hosts:

- Call `advance*` for one flow at a time, never concurrently, and always on the latest persisted state.
- Before a transaction is handed to the signer the flow persists phase `sending` with the nonce it chose. A flow in `sending` or `unknown` is never sent again; it is only reconciled. A record that carries a transaction hash is reconciled first by that hash's receipt: a mined transaction can never end in `not-sent`, and one whose sender, nonce, target, calldata or value differs from the rebuilt call stays `unknown` with that field as `mismatch`. `not-sent` is declared only from the account nonce: the confirmed transaction count read at two different blocks, and the pending count, are still at or below the recorded nonce. A consumed nonce that no receipt of ours explains stays `unknown`; event logs are only used to find a candidate transaction, which must match all five fields. This includes a wallet "cancel" at the recorded nonce, which the host resolves with the user. Do not start a replacement flow while one is `sending` or `unknown`, and pace `advance*` on such a flow (for example every 15 seconds) so a broadcast transaction has time to be sequenced. A lying RPC can still defeat reconciliation.
- `advance*` on a `confirmed` flow re-checks the receipt of its last transaction: still there ⇒ the same state; gone ⇒ back to `tx` for reconciliation. Payout settlement is read with `loadPayoutSettlement(deps, state)`, which derives the settlement key (`txid`, start block) from a fresh receipt each time; nothing persisted depends on the block a receipt was first seen in.
- Payout drafts hold payee data and are never persisted; only the verified state (contact id, purpose id and reference, which are public on chain once sent) is.
- Card API writes are issued once. On a network error or 5xx the SDK reads `GET /cards` once; if the target state is not observed the record becomes `unknown` and is never re-posted. `create` counts as already done only when an `Active` card exists — a `Blocked`, `Expired` or unrecognised card does not stop a `POST /card`.
- Store flow state as pseudonymous account data: `owner`, `tokenId` and recipient ids are public on chain, and a `tokenId` is equivalent to an IBAN (`ibanOf` is a bijection on `1 … 10^11 − 1`). Persisted state contains no names, IBANs, emails, payee addresses, card display tokens, signatures or session labels.

### Behaviour callers must state

- Exact-in FX and top-up have no on-chain minimum output: the rate is set by the issuer and the received amount may differ from the quote. The flow refuses to send if a fresh quote is below the quoted output, but the rate can still move between that check and inclusion.
- Exact-out FX is sent only while the allowance to the deposit contract equals the quoted input exactly; a higher standing allowance (for example an unlimited one) is first approved down, so the chain bounds the debit.
- Both legs of an FX exchange count against the sender's 30-day limit.
- Fiat24 may charge payout fees off chain. The payout recipient is resolved by Fiat24 from the contact id and reference; it is not bound by the signed transaction (intent `payee: "off-chain"`).
- Standing allowances: many accounts hold large allowances to the deposit and card contracts set outside this SDK. `loadAccount` returns all ten allowance pairs; revoke one with `approveCall({ asset, spender, amount: 0n })`. After top-ups become unavailable, a remaining USDC allowance to the deposit contract can still be spent by the account's wallet provider through `depositByWallet`; revoke it if it is not needed.
- Only `getApproved` is read for the account NFT; operator approvals (`isApprovedForAll`) cannot be enumerated without an `ApprovalForAll` log scan and are not reported.
- History (`getHistory`) is only as complete as the RPC. `arb1.arbitrum.io` refuses filter windows above 100,000 blocks for address or topic arrays; some public RPCs silently return incomplete results.

## API host obligations

The `api` layer is for React Native and server hosts.

- There is no CORS support: every request carries the non-safelisted `network` header and `OPTIONS` answers without `Access-Control-Allow-*`.
- The SDK sets no timeout; the host `fetch` must time out or abort. An aborted request becomes `network-error`.
- `/verify?sp=` and `/verify?qr=` carry the payee's name, address and account in the query string; `/banks/iban/{iban}` carries an IBAN in the path by Fiat24's design.
- `api.fiat24.com` must be excluded from network instrumentation such as Sentry, Flipper, proxies or logging interceptors, or an uninstrumented `fetch` must be injected. Request URLs and headers of secured calls must never be logged.
- Platform HTTP caches must be configured so `api.fiat24.com` responses are not stored (iOS `NSURLCache`, Android OkHttp cache).
- A session grant is a bearer credential: the server checks only that `sign` is the account owner's `personal_sign` of the grant message, so until `deadline` anyone holding the four grant header values (`tokenid`, `hash`, `deadline`, `sign`) can call every secured endpoint of that account: profile data, card display tokens, card creation/status/currency/device-token changes, payee creation via `/verify`, and `PUT /email`, which moves the one-time-password channel and which this SDK never calls. A wallet prompt must say what the grant permits.
- The server does not parse chain or account out of `hash` — per the docs it may be any text; the signed text is `keccak256(hash ‖ deadline)` of the separate headers. The SDK sends the label `fiat24-session-v1:<chainId>:<tokenId>:<deadline>;` whose `;` terminator guarantees the signed text cannot be re-split into a `(hash, deadline)` pair with a later deadline than the signer saw.
- Requests are sent with `redirect: "error"` and any redirect response is refused. React Native's `fetch` (XHR) follows redirects regardless of that option, so on React Native the grant headers can reach a redirect target before the SDK refuses the response — inject a `fetch` that does not follow redirects where that matters.
- The body cap (1 MiB; 8 MiB for `/banks`) is enforced while reading when `fetch` exposes a response stream. React Native's `fetch` exposes none, so there the body is buffered by `fetch` before the cap applies and the host `fetch` timeout is what bounds it.
- The SDK grants for 600 seconds and refuses a grant when the server clock differs from the local clock by more than 300 seconds.
- Owners that cannot produce an ECDSA `personal_sign` signature, including contract wallets, cannot open sessions.

## Platform requirements

`TextEncoder` and `TextDecoder` are host-provided globals (viem uses them for strings). Hermes ships them natively from React Native 0.88; older React Native hosts must install a shim. Nothing else beyond the injected `fetch`, clock, viem client and signer is used.

## Legal posture

This SDK is unofficial. It is not affiliated with or endorsed by SR Saphirstein AG, which operates Fiat24; "Fiat24" is used only to identify the protocol and no partnership is claimed.

## Residual risks

These facts hold for the pinned deployment (Arbitrum block 526365924) and are outside the SDK's control:

- A single externally owned account, `0x1272c99bEFa7a70f935Edca81BF9a6E85C6D9D59`, owns the ProxyAdmin of every Fiat24 proxy, so it can upgrade any implementation, including the price list. At block 526527688 it holds `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE` on the account contract, the four cash tokens, the deposit contract, the card contract, F24Sales and F24 (an admin can grant itself every other role); on the price list it holds no role. Through these powers it can pause any contract, change account status and limits, change rates, spreads and fees, maintain the sanctions list, and change the wiring pointers (price list, F24, F24 sales, USDC).
- Card authorisations are pulled by Fiat24's authoriser up to the allowance granted to the card contract.
- Cash tokens (USD24, EUR24, CHF24, CNH24) represent liabilities of the issuer; holding them is not self-custody of the underlying funds.
- Fiat24 currently states that it is in maintenance mode: new client onboarding and crypto top-ups are suspended. There is no on-chain signal for this; the SDK reports `unavailable` only from on-chain facts (for example the paused deposit contract) and onboarding surfaces the KYC states returned by the API.
- Every write first verifies the pinned implementation and admin slots and the wiring pointers on its call path. An upstream upgrade or re-wiring therefore makes every SDK write fail closed with `contract-changed` until a release with new pins. An upgrade between the verification block and the transaction's inclusion cannot be prevented.
- A session grant is a bearer credential (see above); the wallet prompt must state what it permits.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.
