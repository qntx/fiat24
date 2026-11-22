import type { Address, Client, Hex } from "viem";

import { proxyAdminAbi } from "../abi/index.ts";
import { Fiat24Error } from "../core/errors.ts";
import type { DriftField } from "../core/errors.ts";
import type { ContractName } from "../core/types.ts";
import type { Deployment, PinnedProxy } from "../deployments/deployment.ts";
import type { ChainArgs } from "./context.ts";
import {
  ADMIN_SLOT,
  addressSlot,
  asAddress,
  F24_SLOT,
  F24SALES_SLOT,
  IMPL_SLOT,
  packedAddress,
  PRICELIST_SLOT,
  readAt,
  resolveDeployment,
  snapshot,
  storageAt,
  USDC_SLOT,
} from "./context.ts";

/** SPEC §3.6. */
export type Drift = {
  readonly contract: ContractName;
  readonly field: DriftField;
  readonly expected: Hex;
  readonly actual: Hex;
};

/** SPEC §3.6. */
export type DeploymentCheck = {
  readonly ok: boolean;
  readonly drift: ReadonlyArray<Drift>;
  readonly proxyAdminOwner: Address;
  readonly ownerChanged: boolean;
  readonly blockNumber: bigint;
};

// The deployments order of the ten contracts (SPEC §8.2 default list).
const ALL_CONTRACTS: ReadonlyArray<ContractName> = [
  "account",
  "USD24",
  "EUR24",
  "CHF24",
  "CNH24",
  "deposit",
  "card",
  "priceList",
  "f24Sales",
  "f24",
];

const CONTRACT_SET: ReadonlySet<string> = new Set(ALL_CONTRACTS);

const isContractName = (value: unknown): value is ContractName =>
  typeof value === "string" && CONTRACT_SET.has(value);

function proxyOf(deployment: Deployment, name: ContractName): PinnedProxy | undefined {
  switch (name) {
    case "account":
      return deployment.account;
    case "deposit":
      return deployment.deposit;
    case "card":
      return deployment.card;
    case "priceList":
      return deployment.priceList;
    case "f24Sales":
      return deployment.f24Sales;
    case "f24":
      return undefined;
    default:
      return deployment.tokens[name];
  }
}

/**
 * SPEC §8.2: per proxy `getStorageAt` on the EIP-1967 impl and admin slots; `account` also reads
 * the wiring pointers (slot 359 priceList, slot 358 f24, slot 364 F24SalesAddress); `deposit` reads
 * slot 208 usdc; `f24` reads nothing (not a proxy); `proxyAdmin.owner()` is always read. All reads
 * concurrently at B. Owner drift is reported, never counted. Wiring checks are storage reads, not
 * calls: a drifted implementation must never gate the verification itself.
 */
export async function verifyDeployment(
  client: Client,
  args: ChainArgs & { contracts?: ReadonlyArray<ContractName> } = {},
): Promise<DeploymentCheck> {
  resolveDeployment(client, args.deployment);
  const requested = args.contracts ?? ALL_CONTRACTS;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Fiat24Error("invalid-argument", "invalid argument");
  }
  const names: ContractName[] = [];
  for (const name of requested) {
    if (!isContractName(name)) {
      throw new Fiat24Error("invalid-argument", "invalid argument");
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  const { deployment, blockNumber: B } = await snapshot(client, args);

  type Job = {
    contract: ContractName;
    field: DriftField;
    expected: Hex;
    run: () => Promise<Hex>;
  };
  const jobs: Job[] = [];
  for (const name of names) {
    const pin = proxyOf(deployment, name);
    if (pin === undefined) {
      // f24 is immutable non-proxy code (I5): nothing to verify at run time.
      continue;
    }
    jobs.push(
      {
        contract: name,
        field: "implementation",
        expected: pin.implementation,
        run: async () => addressSlot(await storageAt(client, B, pin.proxy, IMPL_SLOT)),
      },
      {
        contract: name,
        field: "admin",
        expected: pin.admin,
        run: async () => addressSlot(await storageAt(client, B, pin.proxy, ADMIN_SLOT)),
      },
    );
    if (name === "account") {
      jobs.push(
        {
          contract: name,
          field: "priceList",
          expected: deployment.priceList.proxy,
          // Slot 359 bytes 0-19 hold the priceList address; byte 20 is
          // f24IsActive, so the strict addressSlot check must not run here.
          run: async () =>
            packedAddress(await storageAt(client, B, pin.proxy, PRICELIST_SLOT), 0, 19),
        },
        {
          contract: name,
          field: "f24",
          expected: deployment.f24.address,
          // Slot 358 bytes 2-21 hold the f24 address; bytes 0-1 are the
          // min/max digit flags.
          run: async () => packedAddress(await storageAt(client, B, pin.proxy, F24_SLOT), 2, 21),
        },
        {
          contract: name,
          field: "f24Sales",
          expected: deployment.f24Sales.proxy,
          run: async () => addressSlot(await storageAt(client, B, pin.proxy, F24SALES_SLOT)),
        },
      );
    }
    if (name === "deposit") {
      jobs.push({
        contract: name,
        field: "usdc",
        expected: deployment.usdc,
        run: async () => addressSlot(await storageAt(client, B, pin.proxy, USDC_SLOT)),
      });
    }
  }

  const [readings, proxyAdminOwner] = await Promise.all([
    Promise.all(jobs.map(async (job) => ({ job, actual: await job.run() }))),
    (async () =>
      asAddress(
        await readAt(client, B, {
          address: deployment.proxyAdmin.address,
          abi: proxyAdminAbi,
          functionName: "owner",
        }),
      ))(),
  ]);

  const drift: Drift[] = [];
  for (const { job, actual } of readings) {
    if (actual.toLowerCase() !== job.expected.toLowerCase()) {
      drift.push({
        contract: job.contract,
        field: job.field,
        expected: job.expected,
        actual,
      });
    }
  }
  // Contract order follows the requested list; fields order as in the §4.1 table.
  const order = names;
  drift.sort((a, b) => order.indexOf(a.contract) - order.indexOf(b.contract));
  return {
    ok: drift.length === 0,
    drift,
    proxyAdminOwner,
    ownerChanged: proxyAdminOwner.toLowerCase() !== deployment.proxyAdmin.owner.toLowerCase(),
    blockNumber: B,
  };
}

/**
 * SPEC §8.2: `verifyDeployment` for `contracts`; `!ok` ⇒ `contract-changed` with the first drift's
 * `{contract, field}`. Returns B on success.
 */
export async function assertDeployment(
  client: Client,
  args: ChainArgs & { contracts: ReadonlyArray<ContractName> },
): Promise<bigint> {
  const check = await verifyDeployment(client, args);
  for (const drift of check.drift) {
    throw new Fiat24Error("contract-changed", `${drift.contract} contract changed`, {
      contract: drift.contract,
      field: drift.field,
    });
  }
  return check.blockNumber;
}
