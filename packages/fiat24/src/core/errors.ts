// The codes are kebab-case strings (not an enum) so vector failure cases name
// them verbatim; the tuple is the closed set `Fiat24Error.code` may take.
export const fiat24ErrorCodes: readonly [
  "invalid-argument",
  "contract-changed",
  "unknown-outcome",
] = ["invalid-argument", "contract-changed", "unknown-outcome"];

export type Fiat24ErrorCode = (typeof fiat24ErrorCodes)[number];

/**
 * Single error type of the SDK; `code` is the closed discriminator shared with the failure cases in
 * vectors/.
 */
export class Fiat24Error extends Error {
  override readonly name = "Fiat24Error";
  readonly code: Fiat24ErrorCode;

  constructor(code: Fiat24ErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
