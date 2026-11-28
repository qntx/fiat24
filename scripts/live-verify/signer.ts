import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { isAddressEqual, sha256, stringToBytes } from "viem";
import type { Address, Hex } from "viem";

/**
 * Signature acquisition without the script ever touching a key: shell out to Foundry `cast` (which
 * talks to the Ledger), or let the owner paste a signature produced by a wallet UI. `cast` and the
 * Ledger prompts go to the terminal (stderr + inherited stdin); only stdout — the signature — is
 * captured, and it is never printed.
 */

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const HD_PATH = /^m(\/[0-9]+'?){1,10}$/;
const CAST_ADDRESS_TIMEOUT_MS = 60_000;

export type SpawnResult = { readonly code: number; readonly stdout: string };

/** One child process: captured stdout, inherited stdin/stderr, killed after `timeoutMs`. */
export type Spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
) => Promise<SpawnResult>;

const defaultSpawn: Spawn = async (command, args, options) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...options.env },
    });
    const chunks: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve({ code: code ?? -1, stdout: new TextDecoder().decode(merged) });
    });
  });

/** `hdPath` (legacy-style) and `accountIndex` (Ledger Live) are mutually exclusive. */
export function ledgerPath(
  args: { hdPath?: string | undefined; accountIndex?: number | undefined } = {},
): string {
  const { hdPath, accountIndex } = args;
  if (hdPath !== undefined && accountIndex !== undefined) {
    throw new Error("--hd-path and --account-index are mutually exclusive");
  }
  if (hdPath !== undefined) {
    if (!HD_PATH.test(hdPath)) {
      throw new Error("invalid --hd-path");
    }
    return hdPath;
  }
  const index = accountIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) {
    throw new Error("invalid --account-index");
  }
  return `m/44'/60'/${index}'/0/0`;
}

// ETH_* / FOUNDRY_* must not reach cast: ETH_FROM, ETH_KEYSTORE and friends would silently pick a
// different signer than the Ledger.
export function cleanEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("ETH_") && !key.startsWith("FOUNDRY_")) {
      out[key] = value;
    }
  }
  return out;
}

const LEDGER_CHECKLIST: ReadonlyArray<string> = [
  "cast could not read the Ledger. Checklist:",
  "  - connect the Ledger and unlock it with the PIN",
  "  - open the Ethereum app until it says it is ready",
  "  - quit Ledger Live / Ledger Wallet and any browser wallet holding the device",
  "  - Ethereum app >= 1.9.19 shows the message text on the device",
  '  - "Blind signing" is not needed for a personal message',
  "  - on Linux the Ledger udev rules must be installed",
  "  - if `cast` is missing entirely, install Foundry: https://getfoundry.sh",
];

const lastNonEmptyLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0) ?? "";

/**
 * `cast wallet address --ledger` then `cast wallet sign --ledger <message>`. The message is plain
 * text starting "I agree…" so cast applies EIP-191 personal_sign (it must never start with 0x).
 * Aborts before spawning `sign` when the derived address is not the account owner. The sign child
 * is bounded by the time left until `deadline - 15 s`.
 */
export async function castSign(args: {
  path: string;
  message: string;
  deadline: bigint;
  nowSeconds: () => bigint;
  owner: Address;
  spawn?: Spawn;
  env?: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
}): Promise<Hex> {
  const run = args.spawn ?? defaultSpawn;
  const env = cleanEnv(args.env ?? process.env);
  const addressResult = await run(
    "cast",
    ["wallet", "address", "--ledger", "--mnemonic-derivation-path", args.path],
    { env, timeoutMs: CAST_ADDRESS_TIMEOUT_MS },
  );
  const address = ADDRESS.exec(addressResult.stdout)?.[0];
  if (addressResult.code !== 0 || address === undefined) {
    for (const line of LEDGER_CHECKLIST) {
      args.log(line);
    }
    throw new Error("could not read the Ledger address");
  }
  if (!isAddressEqual(address as Address, args.owner)) {
    throw new Error(
      "the Ledger address does not match the account owner — try --account-index N or --hd-path (legacy m/44'/60'/0'/N)",
    );
  }
  const secondsLeft = args.deadline - 15n - args.nowSeconds();
  if (secondsLeft <= 0n) {
    throw new Error("grant expires too soon; not signing");
  }
  const signResult = await run(
    "cast",
    ["wallet", "sign", "--ledger", "--mnemonic-derivation-path", args.path, args.message],
    { env, timeoutMs: Number(secondsLeft) * 1000 },
  );
  const signature = /0x[0-9a-fA-F]{130}/.exec(lastNonEmptyLine(signResult.stdout))?.[0];
  if (signResult.code !== 0 || signature === undefined) {
    throw new Error("cast produced no signature");
  }
  return signature as Hex;
}

const PASTE_STEPS: ReadonlyArray<string> = [
  "To produce the signature without this script touching any key:",
  "  1. connect the Ledger to Rabby or MetaMask (hardware-wallet import; Ethereum app open, Ledger Live closed)",
  '  2. open Etherscan "Verified Signatures" -> "Sign Message", connect the wallet, confirm the address is the owner',
  "  3. paste the exact message below and sign — the wallet, then the Ledger, shows the text",
  '  4. copy the "Signature Hash" and paste it here',
  '  NEVER click "Publish" — that makes the bearer credential public while it is valid.',
];

const defaultRead = async (timeoutMs: number): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("signature> ", { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("timed out waiting for the pasted signature", { cause: error });
    }
    throw error instanceof Error ? error : new Error("reading the signature failed");
  } finally {
    rl.close();
  }
};

/**
 * Prints the exact message and the wallet steps, then reads one pasted signature line, bounded by
 * `deadline - 15 s`. (`--signature 0x…` cannot exist as a flag: the signed message embeds this
 * run's deadline, so the signature can only be produced after the grant is built.)
 */
export async function pasteSign(args: {
  message: string;
  deadline: bigint;
  nowSeconds: () => bigint;
  read?: (timeoutMs: number) => Promise<string>;
  log: (line: string) => void;
}): Promise<Hex> {
  for (const line of PASTE_STEPS) {
    args.log(line);
  }
  args.log(`message to sign: ${args.message}`);
  const secondsLeft = args.deadline - 15n - args.nowSeconds();
  if (secondsLeft <= 0n) {
    throw new Error("grant expires too soon; not signing");
  }
  const line = await (args.read ?? defaultRead)(Number(secondsLeft) * 1000);
  const signature = line.trim();
  if (!SIGNATURE.test(signature)) {
    throw new Error("no 65-byte signature was pasted");
  }
  return signature as Hex;
}

/**
 * What the device should show, so the owner can compare before approving. Older Ethereum app
 * versions display "Message hash" (SHA-256 of the message) instead of the text — it is printed so
 * it can be compared character by character.
 */
export function ledgerDisplay(message: string): ReadonlyArray<string> {
  const digest = sha256(stringToBytes(message)).slice(2).toUpperCase();
  return [
    "Expected Ledger screens (wording varies by model and firmware):",
    '  Nano S Plus / X: "Sign message" -> message text pages "I agree to access my profile. 0x…" -> "Sign message" to approve or "Cancel" to reject',
    '  Stax / Flex: "Review message" -> the message text -> "Hold to sign"',
    '  Older Ethereum app versions show "Message hash" instead of the text — SHA-256(message):',
    `    ${digest}`,
    'Before approving, check: the text starts with "I agree to access my profile. 0x" and the 64-hex digest equals the one printed above.',
  ];
}
