/**
 * Pure-JS UTF-8 `TextEncoder`/`TextDecoder` that REPLACE the Hermes natives for the shim smoke run
 * (I15): the src surface must work on a plain JS implementation, so this module installs its own
 * and counts every construction/encode/decode — `entry-shim.ts` asserts the shim was actually
 * exercised. Import order matters: this module must evaluate before viem/src so their module-level
 * `new TextEncoder()` singletons capture the shim.
 */

// A UTF-8 codec is bit-level work by definition; there is no bitwise-free way to write it.
/* oxlint-disable eslint/no-bitwise */

export const shimStats = {
  encoders: 0,
  decoders: 0,
  encodes: 0,
  decodes: 0,
};

class ShimTextEncoder {
  constructor() {
    shimStats.encoders += 1;
  }

  encode(input?: string): Uint8Array {
    shimStats.encodes += 1;
    const text = input ?? "";
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const cp = text.codePointAt(i) ?? 0;
      if (cp > 0xffff) {
        i += 1;
      }
      if (cp < 0x80) {
        bytes.push(cp);
      } else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
      }
    }
    return Uint8Array.from(bytes);
  }

  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;
    let written = 0;
    for (let i = 0; i < input.length; i += 1) {
      const cp = input.codePointAt(i) ?? 0;
      const units = cp > 0xffff ? 2 : 1;
      const cost = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + cost > destination.length) {
        break;
      }
      const encoded = this.encode(input.slice(i, i + units));
      destination.set(encoded, written);
      written += cost;
      read += units;
      i += units - 1;
    }
    return { read, written };
  }
}

const decodeFail = (): never => {
  throw new TypeError("The encoded data was not valid");
};

type DecodeOptions = { readonly stream?: boolean };

class ShimTextDecoder {
  readonly encoding = "utf8";
  readonly fatal: boolean;
  readonly ignoreBOM = false;

  constructor(_label?: string, options?: { readonly fatal?: boolean }) {
    shimStats.decoders += 1;
    this.fatal = options?.fatal === true;
  }

  // oxlint-disable-next-line typescript/no-restricted-types -- decode(null) is part of the WebIDL signature
  decode(input?: ArrayBuffer | ArrayBufferView | null, _options?: DecodeOptions): string {
    shimStats.decodes += 1;
    if (input === undefined || input === null) {
      return "";
    }
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const { fatal } = this;
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i];
      if (b0 === undefined) {
        break;
      }
      if (b0 < 0x80) {
        out += String.fromCodePoint(b0);
        i += 1;
        continue;
      }
      // Sequence length and valid range for the second byte (the range also
      // encodes overlong / surrogate / >U+10FFFF restrictions).
      let len: number;
      let lo = 0x80;
      let hi = 0xbf;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        len = 2;
      } else if (b0 === 0xe0) {
        len = 3;
        lo = 0xa0;
      } else if (b0 === 0xed) {
        len = 3;
        hi = 0x9f;
      } else if (b0 >= 0xe1 && b0 <= 0xef) {
        len = 3;
      } else if (b0 === 0xf0) {
        len = 4;
        lo = 0x90;
      } else if (b0 === 0xf4) {
        len = 4;
        hi = 0x8f;
      } else if (b0 >= 0xf1 && b0 <= 0xf3) {
        len = 4;
      } else {
        if (fatal) {
          decodeFail();
        }
        out += "�";
        i += 1;
        continue;
      }
      const b1 = bytes[i + 1];
      if (b1 === undefined || b1 < lo || b1 > hi) {
        if (fatal) {
          decodeFail();
        }
        out += "�";
        i += 1;
        continue;
      }
      let cp: number;
      if (len === 2) {
        cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      } else {
        const b2 = bytes[i + 2];
        if (b2 === undefined || b2 < 0x80 || b2 > 0xbf) {
          if (fatal) {
            decodeFail();
          }
          out += "�";
          i += 2;
          continue;
        }
        if (len === 3) {
          cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        } else {
          const b3 = bytes[i + 3];
          if (b3 === undefined || b3 < 0x80 || b3 > 0xbf) {
            if (fatal) {
              decodeFail();
            }
            out += "�";
            i += 3;
            continue;
          }
          cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        }
      }
      out += String.fromCodePoint(cp);
      i += len;
    }
    return out;
  }
}

// Install unconditionally: the shim run must prove src works without natives.
globalThis.TextEncoder = ShimTextEncoder as unknown as typeof TextEncoder;
globalThis.TextDecoder = ShimTextDecoder as unknown as typeof TextDecoder;

export const hermesShimInstalled = true;
