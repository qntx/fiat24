import { readFileSync } from "node:fs";

import { cast } from "./lib.ts";
import type { VectorSource } from "./lib.ts";

type RawLogEntry = {
  label: string;
  tx: string;
  source: string;
  log: {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
  };
};

type RawEvents = { endpoint: string; logs: RawLogEntry[] };
type AbiInput = { name: string; type: string; indexed?: boolean };
type AbiEventDef = { type: string; name: string; inputs: AbiInput[] };

const raw: RawEvents = JSON.parse(
  readFileSync(new URL("raw/events.json", import.meta.url), "utf8"),
) as RawEvents;

const deployments = JSON.parse(
  readFileSync(new URL("../../../../data/deployments.json", import.meta.url), "utf8"),
) as { proxies: Record<string, { proxy: string }> };

const CURRENCIES = ["USD24", "EUR24", "CHF24", "CNH24"] as const;
const TOKEN_PROXIES = new Map(
  CURRENCIES.map((name) => [deployments.proxies[name]?.proxy.toLowerCase(), name] as const),
);

const GROUP_ABI_FILE = {
  tokens: "Fiat24Token",
  deposit: "Fiat24CryptoDeposit",
  card: "Fiat24CardAuthorizationMarqeta",
  account: "Fiat24Account",
} as const;
type Group = keyof typeof GROUP_ABI_FILE;

const abiCache = new Map<Group, AbiEventDef[]>();
function abiOf(group: Group): AbiEventDef[] {
  let abi = abiCache.get(group);
  if (abi === undefined) {
    abi = JSON.parse(
      readFileSync(
        new URL(`../../../../data/abis/${GROUP_ABI_FILE[group]}.json`, import.meta.url),
        "utf8",
      ),
    ) as AbiEventDef[];
    abiCache.set(group, abi);
  }
  return abi;
}

/** Address -> §7.1 group, resolved from deployments.json (never via SDK code). */
function groupOf(address: string): Group | undefined {
  const lower = address.toLowerCase();
  if (TOKEN_PROXIES.has(lower)) {
    return "tokens";
  }
  for (const [name, group] of [
    ["deposit", "deposit"],
    ["card", "card"],
    ["account", "account"],
  ] as const) {
    if (deployments.proxies[name]?.proxy.toLowerCase() === lower) {
      return group;
    }
  }
  return undefined;
}

function eventOf(group: Group, name: string): AbiEventDef {
  const event = abiOf(group).find((entry) => entry.type === "event" && entry.name === name);
  if (event === undefined) {
    throw new Error(`no event ${name} in ${GROUP_ABI_FILE[group]}`);
  }
  return event;
}

/** `Name(type name,indexed type name,...)` for `cast decode-event --sig`. */
function eventSig(event: AbiEventDef): string {
  const params = event.inputs.map(
    (input) => `${input.type}${input.indexed === true ? " indexed" : ""} ${input.name}`,
  );
  return `${event.name}(${params.join(",")})`;
}

/**
 * `cast` prints strings Rust-debug style: wrapped in quotes with `\0`, `\n`, `\r`, `\t`, `\\`,
 * `\"`, `\xNN` and `\u{XXXX}` escapes; uints may carry a ` [2.235e5]` hint suffix.
 */
function unescapeCastString(quoted: string): string {
  if (!quoted.startsWith('"')) {
    throw new Error(`cast string expected, got ${quoted.slice(0, 40)}`);
  }
  let out = "";
  let index = 1;
  while (index < quoted.length && quoted[index] !== '"') {
    const ch = quoted[index];
    if (ch !== "\\") {
      out += ch;
      index += 1;
      continue;
    }
    const esc = quoted[index + 1];
    if (esc === "0") {
      out += "\u0000";
      index += 2;
    } else if (esc === "n") {
      out += "\n";
      index += 2;
    } else if (esc === "r") {
      out += "\r";
      index += 2;
    } else if (esc === "t") {
      out += "\t";
      index += 2;
    } else if (esc === "\\" || esc === '"') {
      out += esc;
      index += 2;
    } else if (esc === "x") {
      out += String.fromCodePoint(Number.parseInt(quoted.slice(index + 2, index + 4), 16));
      index += 4;
    } else if (esc === "u" && quoted[index + 2] === "{") {
      const end = quoted.indexOf("}", index + 3);
      out += String.fromCodePoint(Number.parseInt(quoted.slice(index + 3, end), 16));
      index = end + 1;
    } else {
      throw new Error(`unknown cast escape \\${esc ?? ""}`);
    }
  }
  return out;
}

/** One non-indexed arg value from a `cast decode-event` output line. */
function parseValue(type: string, line: string): string {
  if (type === "string") {
    return unescapeCastString(line.trimEnd());
  }
  const stripped = line.trim().replace(/ \[.*\]$/, "");
  if (type === "address") {
    return stripped;
  }
  if (type === "bool") {
    return stripped === "true" ? "true" : "false";
  }
  return stripped;
}

/** One indexed arg decoded from its 32-byte topic (returns normal form). */
function topicValue(type: string, topic: string): string {
  const line = cast(["decode-abi", `f()(${type})`, topic]);
  return parseValue(type, line.split("\n")[0] ?? "");
}

function checksum(address: string): string {
  return cast(["--to-checksum-address", address]);
}

function padTopic(hex: string): string {
  return `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
}

function decodeArgs(
  group: Group,
  eventName: string,
  log: RawLogEntry["log"],
): Record<string, string> {
  const event = eventOf(group, eventName);
  const dataLines = cast(["decode-event", "--sig", eventSig(event), log.data]).split("\n");
  const args: Record<string, string> = {};
  let dataIndex = 0;
  let topicIndex = 0;
  for (const input of event.inputs) {
    if (input.indexed === true) {
      const topic = log.topics[1 + topicIndex];
      if (topic === undefined) {
        throw new Error(`missing topic ${1 + topicIndex} for ${eventName}`);
      }
      args[input.name] = topicValue(input.type, topic);
      topicIndex += 1;
    } else {
      args[input.name] = parseValue(input.type, dataLines[dataIndex] ?? "");
      dataIndex += 1;
    }
  }
  return args;
}

function inputLog(log: RawLogEntry["log"], patch: Partial<RawLogEntry["log"]> = {}) {
  const merged = { ...log, ...patch };
  return {
    address: merged.address.startsWith("0x") ? checksum(merged.address) : merged.address,
    topics: merged.topics,
    data: merged.data,
    blockNumber: merged.blockNumber === null ? null : `${Number.parseInt(merged.blockNumber, 16)}`,
    transactionHash: merged.transactionHash,
    logIndex: merged.logIndex === null ? null : `${Number.parseInt(merged.logIndex, 16)}`,
  };
}

export function build(): {
  capability: string;
  source: Omit<VectorSource, "generator">;
  cases: unknown[];
} {
  const cases: unknown[] = [];
  const byLabel = new Map(raw.logs.map((entry) => [entry.label, entry]));

  // One recorded log per §7.1 kind; expected args decoded by cast (recorded raw
  // log + `cast decode-event`/`decode-abi`, never SDK code).
  for (const entry of raw.logs) {
    const eventName = entry.label.split(".").pop() ?? "";
    const group = groupOf(entry.log.address);
    if (group === undefined) {
      throw new Error(`unmapped address for ${entry.label}`);
    }
    if (eventName === "ExchangeRatesUpdatedByRobot") {
      cases.push({
        label: entry.label,
        input: inputLog(entry.log),
        output: null,
        note: "known address, unlisted topic0 (§7.1)",
      });
      continue;
    }
    const args = decodeArgs(group, eventName, entry.log);
    cases.push({
      label: entry.label,
      input: inputLog(entry.log),
      output: { kind: eventName, args },
    });
  }

  // ---- synthetic cases (cast abi-encode/sig-event; SPEC §7.1 names them).
  const eur24 = deployments.proxies["EUR24"]?.proxy ?? "";
  const card = deployments.proxies["card"]?.proxy ?? "";
  const txHash = `0x${"ab".repeat(32)}`;

  // Synthetic Adviced (none on chain in 80M blocks).
  {
    const event = eventOf("card", "Adviced");
    const sender = "0x1111111111111111111111111111111111111111";
    const data = cast([
      "abi-encode",
      "f(string,string,string,address,uint256)",
      "advice-42",
      "auth-41",
      "CARD-0042",
      eur24,
      "5000",
    ]);
    cases.push({
      label: "synthetic.Adviced",
      input: inputLog(
        {
          address: card,
          topics: [
            cast(["sig-event", "Adviced(string,string,uint256,address,string,address,uint256)"]),
            padTopic((123456).toString(16)),
            padTopic(sender),
          ],
          data,
          blockNumber: "0x1f5f0a4",
          transactionHash: txHash,
          logIndex: "0x0",
        },
        {},
      ),
      output: {
        kind: "Adviced",
        args: {
          adviceToken: "advice-42",
          originalAuthorizationToken: "auth-41",
          tokenId: "123456",
          sender: checksum(sender),
          cardId: "CARD-0042",
          cardCurrency: checksum(eur24),
          paidAmount: "5000",
        },
      },
    });
    void event;
  }

  // Synthetic CashDepositNOK (depositAccount 9103, Fiat24Token.sol:100-107).
  {
    const recipient = 987654;
    const data = cast([
      "abi-encode",
      "f(uint256,string,string,string)",
      "9103",
      "EXT-42",
      "BANK-9",
      "trx-1",
    ]);
    cases.push({
      label: "synthetic.CashDepositNOK",
      input: inputLog(
        {
          address: eur24,
          topics: [
            cast(["sig-event", "CashDepositNOK(uint256,uint256,string,string,string)"]),
            padTopic(recipient.toString(16)),
          ],
          data,
          blockNumber: "0x1f5f0a4",
          transactionHash: txHash,
          logIndex: "0x0",
        },
        {},
      ),
      output: {
        kind: "CashDepositNOK",
        args: {
          recipientAccountId: "987654",
          depositAccount: "9103",
          exaccId: "EXT-42",
          bankId: "BANK-9",
          trxId: "trx-1",
        },
      },
    });
  }

  // ---- malformed cases (each ⇒ malformed-log) built on the recorded
  // EUR24.ClientPayoutRef log, which has both string and uint fields.
  const ref = byLabel.get("EUR24.ClientPayoutRef");
  const transfer = byLabel.get("EUR24.Transfer");
  const payout = byLabel.get("EUR24.ClientPayout");
  if (ref === undefined || transfer === undefined || payout === undefined) {
    throw new Error("raw/events.json: missing recorded logs for malformed cases");
  }
  const truncated = ref.log.data.slice(0, -64);
  cases.push(
    {
      label: "malformed.truncated-data",
      input: inputLog(ref.log, { data: truncated }),
      error: "malformed-log",
    },
    {
      label: "malformed.trailing-data",
      input: inputLog(ref.log, { data: `${ref.log.data}${"0".repeat(64)}` }),
      error: "malformed-log",
    },
    {
      // non-canonical string offset: contactId head points one word too far
      label: "malformed.noncanonical-offset",
      input: inputLog(payout.log, {
        data: `${payout.log.data.slice(0, 2 + 64 * 2)}${(
          Number.parseInt(payout.log.data.slice(2 + 64 * 2, 2 + 64 * 3), 16) + 32
        )
          .toString(16)
          .padStart(64, "0")}${payout.log.data.slice(2 + 64 * 3)}`,
      }),
      error: "malformed-log",
    },
    {
      label: "malformed.extra-topic",
      input: inputLog(ref.log, { topics: [...ref.log.topics, `0x${"0".repeat(64)}`] }),
      error: "malformed-log",
    },
    {
      label: "malformed.missing-topic",
      input: inputLog(ref.log, { topics: ref.log.topics.slice(0, -1) }),
      error: "malformed-log",
    },
    {
      // dirty high bytes in the indexed address topic (topic1 of Transfer is `from`)
      label: "malformed.dirty-topic",
      input: inputLog(transfer.log, {
        topics: [
          transfer.log.topics[0] ?? "",
          `0xff${(transfer.log.topics[1] ?? "").slice(4)}`,
          transfer.log.topics[2] ?? "",
        ],
      }),
      error: "malformed-log",
    },
    {
      label: "malformed.null-block",
      input: { ...inputLog(ref.log), blockNumber: null },
      error: "malformed-log",
    },
  );

  // 1025-byte contactId in a ClientPayout-shaped log (string cap, §3.5).
  {
    const contactId = "A".repeat(1025);
    const data = cast([
      "abi-encode",
      "f(uint256,uint256,string,string)",
      "9102",
      "4000",
      contactId,
      "223531-526291731",
    ]);
    cases.push({
      label: "malformed.oversize-string",
      input: inputLog(payout.log, { data }),
      error: "malformed-log",
    });
  }

  // ---- `undefined` cases: unknown address; known address + `Paused` topic0.
  {
    cases.push(
      {
        label: "notours.unknown-address",
        input: inputLog(ref.log, {
          address: "0x000000000000000000000000000000000000beef",
        }),
        output: null,
      },
      {
        label: "notours.paused-topic0",
        input: inputLog(ref.log, {
          topics: [cast(["sig-event", "Paused(address)"]), ...ref.log.topics.slice(1)],
          data: cast(["abi-encode", "f(address)", ref.log.address]),
        }),
        output: null,
      },
      // An unknown address must stay "not ours" even when it carries a wanted
      // topic0 of the other §7.1 groups (the existing case above covers tokens).
      {
        label: "notours.unknown-address-deposit",
        input: inputLog({
          address: "0x000000000000000000000000000000000000beef",
          topics: [
            cast(["sig-event", "MoneyExchangedExactIn(address,address,address,uint256,uint256)"]),
            padTopic("1111111111111111111111111111111111111111"),
          ],
          data: cast([
            "abi-encode",
            "f(address,address,uint256,uint256)",
            eur24,
            deployments.proxies["CHF24"]?.proxy ?? "",
            "100",
            "99",
          ]),
          blockNumber: "0x1f5f0a4",
          transactionHash: txHash,
          logIndex: "0x0",
        }),
        output: null,
      },
      {
        label: "notours.unknown-address-card",
        input: inputLog({
          address: "0x000000000000000000000000000000000000beef",
          topics: [
            cast(["sig-event", "Authorized(string,uint256,address,string,address,uint256)"]),
            padTopic("7"),
            padTopic("1111111111111111111111111111111111111111"),
          ],
          data: cast([
            "abi-encode",
            "f(string,string,address,uint256)",
            "auth-1",
            "CARD-1",
            eur24,
            "100",
          ]),
          blockNumber: "0x1f5f0a4",
          transactionHash: txHash,
          logIndex: "0x0",
        }),
        output: null,
      },
      {
        label: "notours.unknown-address-account",
        input: inputLog({
          address: "0x000000000000000000000000000000000000beef",
          topics: [
            cast(["sig-event", "Transfer(address,address,uint256)"]),
            padTopic("1111111111111111111111111111111111111111"),
            padTopic("2222222222222222222222222222222222222222"),
            padTopic("7"),
          ],
          data: "0x",
          blockNumber: "0x1f5f0a4",
          transactionHash: txHash,
          logIndex: "0x0",
        }),
        output: null,
      },
    );
  }

  return {
    capability: "events.decode",
    source: {
      kind: "recorded",
      name: "cast",
      version: "1.10.0",
      evidence:
        "packages/fiat24/scripts/vectors/raw/events.json (eth_getTransactionReceipt recordings); expected args via `cast decode-event`/`decode-abi`; synthetic logs via `cast abi-encode`/`sig-event`",
    },
    cases,
  };
}
