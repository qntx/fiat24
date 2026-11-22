/// <reference types="node" />
/**
 * Fetches the verified ABI and sources of every pinned contract from Sourcify (chain 42161) and
 * writes `data/abis/<Name>.json` (the Sourcify `abi` value, unchanged) and `data/SOURCE.md` (match
 * type, verification date, compiler, keccak256 + SPDX of every non-OpenZeppelin source file).
 * `--check` re-fetches and fails on any difference except the retrieval date. Addresses come from
 * `data/deployments.json`; this script touches the network and is not part of `lint`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { keccak256, stringToHex } from "viem";

const ROOT = join(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");
const SOURCIFY = "https://sourcify.dev/server/v2/contract/42161";

type Pin = { implementation: string };
type Deployments = {
  proxies: Record<string, Pin>;
  f24: { address: string };
  proxyAdmin: { address: string };
};

const deployments = JSON.parse(
  readFileSync(join(ROOT, "data", "deployments.json"), "utf8"),
) as Deployments;

function implementation(name: string): string {
  const pin = deployments.proxies[name];
  if (pin === undefined) {
    throw new Error(`data/deployments.json: no proxy ${name}`);
  }
  return pin.implementation;
}

// ABI file -> the deployments whose verified contract it is. The four cash tokens share one
// ABI: the script refuses to write it unless all four Sourcify ABIs are identical.
const CONTRACTS: ReadonlyArray<
  readonly [abi: string, members: ReadonlyArray<readonly [string, string]>]
> = [
  ["Fiat24Account", [["account", implementation("account")]]],
  [
    "Fiat24Token",
    ["USD24", "EUR24", "CHF24", "CNH24"].map((name) => [name, implementation(name)] as const),
  ],
  ["Fiat24CryptoDeposit", [["deposit", implementation("deposit")]]],
  ["Fiat24CardAuthorizationMarqeta", [["card", implementation("card")]]],
  ["Fiat24PriceList", [["priceList", implementation("priceList")]]],
  ["F24Sales", [["f24Sales", implementation("f24Sales")]]],
  ["F24", [["f24", deployments.f24.address]]],
  ["ProxyAdmin", [["proxyAdmin", deployments.proxyAdmin.address]]],
];

type Verified = {
  match: string;
  runtimeMatch: string;
  creationMatch: string;
  verifiedAt: string;
  compilation: { name: string; compilerVersion: string; fullyQualifiedName: string };
  abi: unknown[];
  sources: Record<string, { content: string }>;
};

async function fetchVerified(address: string): Promise<Verified> {
  const response = await fetch(`${SOURCIFY}/${address}?fields=abi,compilation,sources`);
  if (!response.ok) {
    throw new Error(`sourcify ${address}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as Verified;
  if (!Array.isArray(body.abi) || body.match === undefined) {
    throw new Error(`sourcify ${address}: unexpected body`);
  }
  return body;
}

const SPDX = /SPDX-License-Identifier:\s*([^\s*]+)/;

/** Drops the volatile retrieval date so `--check` can compare the rest of the file. */
function stripRetrieved(text: string): string {
  return text.replace(/^Retrieved: .*$/m, "");
}

function sourceRows(sources: Verified["sources"]): string[] {
  return Object.keys(sources)
    .filter((path) => !path.includes("@openzeppelin/"))
    .toSorted()
    .map((path) => {
      const content = sources[path]?.content ?? "";
      const spdx = SPDX.exec(content)?.[1] ?? "none";
      return `| \`${path}\` | ${spdx} | \`${keccak256(stringToHex(content))}\` |`;
    });
}

async function main(): Promise<number> {
  const retrieved = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  let drift = false;
  for (const [abiName, members] of CONTRACTS) {
    let abiText: string | undefined;
    for (const [member, address] of members) {
      const verified = await fetchVerified(address);
      const text = `${JSON.stringify(verified.abi, null, 2)}\n`;
      if (abiText !== undefined && abiText !== text) {
        throw new Error(`${abiName}: ${member} ABI differs from the other members`);
      }
      abiText = text;
      const url = `${SOURCIFY}/${address}`;
      sections.push(
        [
          `### ${member} — \`${abiName}\``,
          "",
          `- Address: \`${address}\` (${member === "f24" || member === "proxyAdmin" ? "not a proxy" : "implementation"})`,
          `- Sourcify: \`${verified.match}\` (runtime \`${verified.runtimeMatch}\`, creation \`${verified.creationMatch}\`), verified ${verified.verifiedAt}`,
          `- Contract: \`${verified.compilation.fullyQualifiedName}\`, compiler \`${verified.compilation.compilerVersion}\``,
          `- URL: <${url}>`,
          "",
          "| Source file (non-OpenZeppelin) | SPDX | keccak256 |",
          "| --- | --- | --- |",
          ...sourceRows(verified.sources),
          "",
        ].join("\n"),
      );
    }
    if (abiText === undefined) {
      throw new Error(`${abiName}: no members`);
    }
    const path = join(ROOT, "data", "abis", `${abiName}.json`);
    if (CHECK) {
      if (readFileSync(path, "utf8") === abiText) {
        console.log(`abi: data/abis/${abiName}.json == Sourcify (${members.length} address(es))`);
      } else {
        console.error(`abi: data/abis/${abiName}.json differs from Sourcify`);
        drift = true;
      }
    } else {
      writeFileSync(path, abiText);
      console.log(`abi: wrote data/abis/${abiName}.json`);
    }
  }
  const source = [
    "# Source data",
    "",
    "Generated by `bun scripts/abi.ts` from Sourcify (chain 42161); `bun scripts/abi.ts --check`",
    "re-fetches and compares everything below except the retrieval date. Never edit by hand.",
    "",
    "- `abis/*.json`: the Sourcify `abi` of the contract, unchanged (pretty-printed JSON). The four",
    "  cash tokens (USD24, EUR24, CHF24, CNH24) have byte-identical ABIs, stored once as",
    "  `Fiat24Token.json`.",
    "- `deployments.json`: addresses, EIP-1967 implementation and admin slots, `keccak256(eth_getCode)`",
    "  of every implementation, F24 and the ProxyAdmin, the ProxyAdmin owner and the `monitor` values,",
    "  read at `block`; `bun scripts/deployments/verify.ts` re-reads every value from chain.",
    "- No Solidity source is vendored: the verified bundles mix MIT files without a copyright line",
    "  with GPL-3.0 (`IF24TimeLock.sol`), GPL-2.0-or-later (Uniswap v3) and BUSL-1.1 (`ArbSys.sol`)",
    "  files (SPDX column below), so only hashes and URLs are recorded.",
    "",
    `Retrieved: ${retrieved}`,
    "",
    "## Contracts",
    "",
    ...sections,
  ].join("\n");
  const sourcePath = join(ROOT, "data", "SOURCE.md");
  if (CHECK) {
    if (stripRetrieved(readFileSync(sourcePath, "utf8")) === stripRetrieved(source)) {
      console.log("abi: data/SOURCE.md == Sourcify");
    } else {
      console.error("abi: data/SOURCE.md differs from Sourcify");
      drift = true;
    }
  } else {
    writeFileSync(sourcePath, source);
    console.log("abi: wrote data/SOURCE.md");
  }
  return drift ? 1 : 0;
}

process.exitCode = await main();
