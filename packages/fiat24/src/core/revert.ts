import { decodeAbiParameters, decodeErrorResult, slice } from "viem";
import type { Hex } from "viem";

import { fiat24ErrorsAbi } from "../abi/errors.ts";
import type { Fiat24ErrorCode } from "./errors.ts";

/**
 * Decoded form of a revert payload. `reason` is the raw `Error(string)` text (at most 200 printable
 * ASCII chars — arbitrary revert text is never carried further); `name` is the ABI name of a custom
 * error; `code` the panic code.
 */
export type RevertReason =
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "custom"; readonly name: string }
  | { readonly kind: "panic"; readonly code: bigint }
  | { readonly kind: "unknown" };

const MAX_REASON_LENGTH = 200;
const PRINTABLE_ASCII = /^[\u0020-\u007E]*$/;

/**
 * Decodes `Error(string)`, `Panic(uint256)` and every custom error of the pinned ABIs (viem
 * `decodeErrorResult` resolves the first two natively). Never throws: malformed hex, odd length,
 * truncated arguments, an over-long or non-printable reason string and unrecognised selectors all
 * decode to `unknown`.
 */
export function decodeFiat24Revert(data: Hex): RevertReason {
  try {
    // RPC transports do not promise lowercase hex; compare case-insensitively.
    const normalized: Hex = `0x${data.slice(2).toLowerCase()}`;
    const selector = slice(normalized, 0, 4);
    if (selector === "0x08c379a0") {
      const [reason] = decodeAbiParameters([{ type: "string" }], slice(normalized, 4));
      return reason.length <= MAX_REASON_LENGTH && PRINTABLE_ASCII.test(reason)
        ? { kind: "error", reason }
        : { kind: "unknown" };
    }
    if (selector === "0x4e487b71") {
      const [code] = decodeAbiParameters([{ type: "uint256" }], slice(normalized, 4));
      return { kind: "panic", code };
    }
    const decoded = decodeErrorResult({ abi: fiat24ErrorsAbi, data: normalized });
    // `Error` and `Panic` are the Solidity built-ins decoded natively by viem;
    // they were handled above and must never leak through as `custom`.
    const name: string = decoded.errorName;
    return name === "Error" || name === "Panic"
      ? { kind: "unknown" }
      : { kind: "custom", name: decoded.errorName };
  } catch {
    return { kind: "unknown" };
  }
}

// `Error(string)` reasons of the pinned implementations and their vendored
// dependencies -> §6.3 codes. A Map (not a record literal) because the reason
// is untrusted text: plain-object indexing would read prototype properties.
const ERROR_STRING_CODES: ReadonlyMap<string, Fiat24ErrorCode> = new Map([
  // @uniswap/v3-periphery/contracts/libraries/TransferHelper.sol:21,35,49 — a
  // failed leg of an exchange or top-up collapses into one of these.
  ["STF", "contract-revert"],
  ["ST", "contract-revert"],
  ["SA", "contract-revert"],
  // Fiat24Token.sol:423
  ["Fiat24Token: Transfer not allowed for various reason", "transfer-not-allowed"],
  // Fiat24Token.sol:133,141
  ["Fiat24Token: amount < minimal payout amount", "below-minimum"],
  // Fiat24Token.sol:157-158 (view, capital A) and :420-421 (transfer path, lowercase a).
  ["Fiat24Token: All account transfers are paused", "unavailable"],
  ["Fiat24Token: All account transfers of this currency are paused", "unavailable"],
  ["Fiat24Token: all account transfers are paused", "unavailable"],
  ["Fiat24Token: all account transfers of this currency are paused", "unavailable"],
  // Fiat24Token.sol:162,164
  ["Fiat24Token: Transfer to sanctioned address", "transfer-not-allowed"],
  ["Fiat24Token: Transfer from sanctioned address", "transfer-not-allowed"],
  // @openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol:238,287
  ["ERC20: transfer amount exceeds balance", "insufficient-balance"],
  ["ERC20: burn amount exceeds balance", "insufficient-balance"],
  // Fiat24Token.sol:83; @openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol:37
  ["ERC20: transfer amount exceeds allowance", "insufficient-allowance"],
  ["ERC20: burn amount exceeds allowance", "insufficient-allowance"],
  // @openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol:79,289
  ["ERC721: owner query for nonexistent token", "no-account"],
  ["ERC721: token already minted", "account-id-taken"],
  // @openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol:47
  // (payout without an account NFT — Fiat24Token.sol:134,142 calls tokenOfOwnerByIndex)
  ["ERC721Enumerable: owner index out of bounds", "no-account"],
  // Fiat24Account.sol:412 (mint while the account contract is paused)
  ["Account transfers suspended", "unavailable"],
  // Fiat24Account.sol:121
  ["Not allowed. The address has/had another NFT.", "address-ineligible"],
  // Fiat24Account.sol:118
  ["F24 is inactive", "unavailable"],
  // Fiat24Account.sol:120,119
  ["Number of digits of accountId > max. digits", "invalid-account-id"],
  ["9xx cannot be mint by client", "invalid-account-id"],
  // Fiat24Account.sol:108
  ["Not sufficient msg.value for F24 purchase", "quote-changed"],
]);

// Custom error names (full ABI names) -> §6.3 codes.
const CUSTOM_ERROR_CODES: ReadonlyMap<string, Fiat24ErrorCode> = new Map([
  // Fiat24CryptoDeposit.sol:21, F24Sales.sol:12
  ["Fiat24CryptoDeposit__Paused", "unavailable"],
  ["F24Sales__Paused", "unavailable"],
  // F24Sales.sol:14,69 (treasury balance below the buy amount), :15,66 (dust buy)
  ["F24Sales__NotEnoughF24", "unavailable"],
  ["F24Sales__F24AmountTooSmall", "below-minimum"],
  // Fiat24CryptoDeposit.sol:26, :30, :29
  ["Fiat24CryptoDeposit__ValueZero", "below-minimum"],
  ["Fiat24CryptoDeposit__UsdcAmountLowerMinDepositAmount", "below-minimum"],
  ["Fiat24CryptoDeposit__UsdcAmountHigherMaxDepositAmount", "above-maximum"],
  // Fiat24CryptoDeposit.sol:25
  ["Fiat24CryptoDeposit__AddressHasNoToken", "no-account"],
  // Fiat24CryptoDeposit.sol:23, :22, :24
  ["Fiat24CryptoDeposit__NotValidInputToken", "unsupported-currency"],
  ["Fiat24CryptoDeposit__NotValidOutputToken", "unsupported-currency"],
  ["Fiat24CryptoDeposit__InputTokenOutputTokenSame", "unsupported-currency"],
]);

/** Maps a decoded revert to a §6.3 code; every unlisted payload is `contract-revert`. */
export function revertCode(reason: RevertReason): Fiat24ErrorCode {
  if (reason.kind === "error") {
    return ERROR_STRING_CODES.get(reason.reason) ?? "contract-revert";
  }
  if (reason.kind === "custom") {
    return CUSTOM_ERROR_CODES.get(reason.name) ?? "contract-revert";
  }
  return "contract-revert";
}
