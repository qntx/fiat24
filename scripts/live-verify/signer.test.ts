import { sha256, stringToBytes } from "viem";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { ANVIL_KEY } from "../../packages/fiat24/tests/api/stub.ts";
import type { Spawn, SpawnResult } from "./signer.ts";
import { castSign, cleanEnv, ledgerDisplay, ledgerPath, pasteSign } from "./signer.ts";

const OWNER = privateKeyToAccount(ANVIL_KEY).address;
const SIG = `0x${"ab".repeat(65)}`;
const MESSAGE = "I agree to access my profile. 0xdeadbeef";

type SpawnCall = {
  command: string;
  args: ReadonlyArray<string>;
  timeoutMs: number;
  env: Record<string, string | undefined>;
};

function fakeSpawn(results: SpawnResult[]): { spawn: Spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = async (command, args, options) => {
    calls.push({ command, args: [...args], timeoutMs: options.timeoutMs, env: { ...options.env } });
    const next = results.shift();
    return next === undefined
      ? Promise.reject(new Error("unexpected spawn"))
      : Promise.resolve(next);
  };
  return { spawn, calls };
}

const baseArgs = (spawn: Spawn, extra: Record<string, string | undefined> = {}) => ({
  path: "m/44'/60'/0'/0/0",
  message: MESSAGE,
  deadline: 2000n,
  nowSeconds: () => 1000n,
  owner: OWNER,
  spawn,
  env: { PATH: "/bin", ETH_FROM: "0x0", FOUNDRY_PROFILE: "x", ...extra },
  log: (_line: string) => {},
});

describe("ledgerPath", () => {
  it("builds Ledger Live paths and validates inputs", () => {
    expect(ledgerPath()).toBe("m/44'/60'/0'/0/0");
    expect(ledgerPath({ accountIndex: 5 })).toBe("m/44'/60'/5'/0/0");
    expect(ledgerPath({ hdPath: "m/44'/60'/0'/1" })).toBe("m/44'/60'/0'/1");
    expect(() => ledgerPath({ hdPath: "m/44'", accountIndex: 1 })).toThrow("mutually exclusive");
    expect(() => ledgerPath({ hdPath: "44'/60'" })).toThrow("--hd-path");
    expect(() => ledgerPath({ hdPath: "m/x/60'" })).toThrow("--hd-path");
    expect(() => ledgerPath({ accountIndex: -1 })).toThrow("--account-index");
    expect(() => ledgerPath({ accountIndex: 2 ** 31 })).toThrow("--account-index");
  });
});

describe("cleanEnv", () => {
  it("strips ETH_* and FOUNDRY_* keys", () => {
    const cleaned = cleanEnv({ PATH: "/bin", ETH_FROM: "0x0", FOUNDRY_PROFILE: "x", HOME: "/h" });
    expect(cleaned).toStrictEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("castSign", () => {
  it("runs the exact cast argv, strips env, and returns the signature", async () => {
    const { spawn, calls } = fakeSpawn([
      { code: 0, stdout: `${OWNER}\n` },
      { code: 0, stdout: `Signature: ${SIG}\n` },
    ]);
    const signature = await castSign(baseArgs(spawn));
    expect(signature).toBe(SIG);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("cast");
    expect(calls[0]?.args).toStrictEqual([
      "wallet",
      "address",
      "--ledger",
      "--mnemonic-derivation-path",
      "m/44'/60'/0'/0/0",
    ]);
    expect(calls[0]?.timeoutMs).toBe(60_000);
    expect(calls[1]?.args).toStrictEqual([
      "wallet",
      "sign",
      "--ledger",
      "--mnemonic-derivation-path",
      "m/44'/60'/0'/0/0",
      MESSAGE,
    ]);
    // deadline 2000 - 15 - now 1000 = 985 s
    expect(calls[1]?.timeoutMs).toBe(985_000);
    expect(calls[0]?.env["ETH_FROM"]).toBeUndefined();
    expect(calls[0]?.env["FOUNDRY_PROFILE"]).toBeUndefined();
    expect(calls[0]?.env["PATH"]).toBe("/bin");
  });

  it("aborts with the checklist when the address read fails, never spawning sign", async () => {
    const { spawn, calls } = fakeSpawn([{ code: 1, stdout: "" }]);
    const lines: string[] = [];
    await expect(
      castSign({
        ...baseArgs(spawn),
        log: (line) => {
          lines.push(line);
        },
      }),
    ).rejects.toThrow("Ledger address");
    expect(calls).toHaveLength(1);
    expect(lines.join("\n")).toContain("Ethereum app");
    expect(lines.join("\n")).toContain("Foundry");
  });

  it("aborts on owner mismatch before sign is ever spawned", async () => {
    const other: Address = "0x1111111111111111111111111111111111111111";
    const { spawn, calls } = fakeSpawn([{ code: 0, stdout: `${other}\n` }]);
    await expect(castSign(baseArgs(spawn))).rejects.toThrow("account owner");
    expect(calls).toHaveLength(1);
  });

  it("rejects garbage stdout and nonzero exits on sign", async () => {
    const garbage = fakeSpawn([
      { code: 0, stdout: `${OWNER}\n` },
      { code: 0, stdout: "something went wrong\n" },
    ]);
    await expect(castSign(baseArgs(garbage.spawn))).rejects.toThrow("no signature");
    const failed = fakeSpawn([
      { code: 0, stdout: `${OWNER}\n` },
      { code: 2, stdout: SIG },
    ]);
    await expect(castSign(baseArgs(failed.spawn))).rejects.toThrow("no signature");
  });

  it("refuses to sign when the deadline margin has passed", async () => {
    const { spawn, calls } = fakeSpawn([
      { code: 0, stdout: `${OWNER}\n` },
      { code: 0, stdout: SIG },
    ]);
    await expect(castSign({ ...baseArgs(spawn), nowSeconds: () => 1990n })).rejects.toThrow(
      "too soon",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("pasteSign", () => {
  it("prints the message and returns a pasted signature", async () => {
    const lines: string[] = [];
    let timeoutMs = -1;
    const signature = await pasteSign({
      message: MESSAGE,
      deadline: 2000n,
      nowSeconds: () => 1000n,
      read: async (ms) => {
        timeoutMs = ms;
        return Promise.resolve(` ${SIG}\n`);
      },
      log: (line) => {
        lines.push(line);
      },
    });
    expect(signature).toBe(SIG);
    // deadline - 15 s - now = 985 s left, passed to the reader in ms.
    expect(timeoutMs).toBe(985_000);
    const printed = lines.join("\n");
    expect(printed).toContain(MESSAGE);
    expect(printed).toContain("Publish");
  });

  it("rejects bad input and an expired window", async () => {
    await expect(
      pasteSign({
        message: MESSAGE,
        deadline: 2000n,
        nowSeconds: () => 1000n,
        read: async () => Promise.resolve("0xdead"),
        log: () => {},
      }),
    ).rejects.toThrow("65-byte");
    let asked = false;
    await expect(
      pasteSign({
        message: MESSAGE,
        deadline: 2000n,
        nowSeconds: () => 1990n,
        read: async () => {
          asked = true;
          return Promise.resolve(SIG);
        },
        log: () => {},
      }),
    ).rejects.toThrow("too soon");
    expect(asked).toBe(false);
  });
});

describe("ledgerDisplay", () => {
  it("prints the expected device screens and the message SHA-256", () => {
    const lines = ledgerDisplay(MESSAGE).join("\n");
    expect(lines).toContain(sha256(stringToBytes(MESSAGE)).slice(2).toUpperCase());
    expect(lines).toContain("Sign message");
    expect(lines).toContain("Hold to sign");
    expect(lines).toContain("I agree to access my profile. 0x");
  });
});
