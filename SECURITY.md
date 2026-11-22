# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.0.x   | Yes       |

## Reporting a vulnerability

Report security issues privately via GitHub Security Advisories on
[qntx/fiat24](https://github.com/qntx/fiat24/security/advisories/new), or
email `security@qntx.org` if that channel is unavailable.

Please include:

- Affected version and runtime (Node/Bun/browser)
- Minimal reproduction (transaction data, API payload, or flow state)
- Impact assessment

Do not open public issues for unfixed vulnerabilities.

## Threat model (summary)

This SDK is a protocol client: contract bindings, REST API handling, and
resumable flow state machines. It does not custody keys and never signs —
every signature is delegated to an injected signer. Security invariants
(pinned implementation + code-hash verification before every write, the
chain as the only source of balances/status/limits, no PII persisted or
logged, no retries on write endpoints, refusal of unlimited approvals and
of internal-account recipients) are enforced by the layers that implement them; none of that code exists yet.
