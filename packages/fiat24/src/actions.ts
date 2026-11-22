import type { Client } from "viem";

import { getAccount } from "./chain/account.ts";
import { getAvailability } from "./chain/availability.ts";
import { getAllowance, getAllowances, getBalances } from "./chain/balances.ts";
import { assertDeployment, verifyDeployment } from "./chain/deployment.ts";
import { getHistory } from "./chain/history.ts";
import { getMintQuote } from "./chain/mint.ts";
import { getPayoutMinimum, getPayoutSettlement } from "./chain/payout.ts";
import { getExchangeQuote, getTopUpQuote } from "./chain/quote.ts";
import { simulateCall } from "./chain/simulate.ts";
import { checkTransfer } from "./chain/transfer.ts";
import type { Deployment } from "./deployments/index.ts";

/** Bound deployment for every action bound by {@link fiat24PublicActions}. */
export type Fiat24ActionsOptions = { deployment?: Deployment | undefined };

type Bound<F> = F extends (client: Client, args: infer A) => infer R ? (args: A) => R : never;

/** The methods {@link fiat24PublicActions} binds to a client (SPEC §3.10). */
export type Fiat24PublicActionSet = {
  fiat24GetAccount: Bound<typeof getAccount>;
  fiat24GetBalances: Bound<typeof getBalances>;
  fiat24GetAllowance: Bound<typeof getAllowance>;
  fiat24GetAllowances: Bound<typeof getAllowances>;
  fiat24GetAvailability: Bound<typeof getAvailability>;
  fiat24VerifyDeployment: Bound<typeof verifyDeployment>;
  fiat24AssertDeployment: Bound<typeof assertDeployment>;
  fiat24GetExchangeQuote: Bound<typeof getExchangeQuote>;
  fiat24GetTopUpQuote: Bound<typeof getTopUpQuote>;
  fiat24CheckTransfer: Bound<typeof checkTransfer>;
  fiat24GetPayoutMinimum: Bound<typeof getPayoutMinimum>;
  fiat24GetPayoutSettlement: Bound<typeof getPayoutSettlement>;
  fiat24GetMintQuote: Bound<typeof getMintQuote>;
  fiat24GetHistory: Bound<typeof getHistory>;
  fiat24SimulateCall: Bound<typeof simulateCall>;
};

/**
 * Viem `extend` decorator binding every Fiat24 read action:
 * `publicClient.extend(fiat24PublicActions())`. `args.deployment` beats the option bound here
 * (§8.1); `simulateCall` takes no deployment and passes args through. Prefixed names never collide
 * with viem actions on `client.extend`.
 */
export function fiat24PublicActions(options: Fiat24ActionsOptions = {}) {
  return (client: Client): Fiat24PublicActionSet => ({
    fiat24GetAccount: async (args: Parameters<typeof getAccount>[1]) =>
      getAccount(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetBalances: async (args: Parameters<typeof getBalances>[1]) =>
      getBalances(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetAllowance: async (args: Parameters<typeof getAllowance>[1]) =>
      getAllowance(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetAllowances: async (args: Parameters<typeof getAllowances>[1]) =>
      getAllowances(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetAvailability: async (args: Parameters<typeof getAvailability>[1] = {}) =>
      getAvailability(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24VerifyDeployment: async (args: Parameters<typeof verifyDeployment>[1] = {}) =>
      verifyDeployment(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24AssertDeployment: async (args: Parameters<typeof assertDeployment>[1]) =>
      assertDeployment(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24GetExchangeQuote: async (args: Parameters<typeof getExchangeQuote>[1]) =>
      getExchangeQuote(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24GetTopUpQuote: async (args: Parameters<typeof getTopUpQuote>[1]) =>
      getTopUpQuote(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24CheckTransfer: async (args: Parameters<typeof checkTransfer>[1]) =>
      checkTransfer(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetPayoutMinimum: async (args: Parameters<typeof getPayoutMinimum>[1]) =>
      getPayoutMinimum(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24GetPayoutSettlement: async (args: Parameters<typeof getPayoutSettlement>[1]) =>
      getPayoutSettlement(client, {
        ...args,
        deployment: args.deployment ?? options.deployment,
      }),
    fiat24GetMintQuote: async (args: Parameters<typeof getMintQuote>[1]) =>
      getMintQuote(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24GetHistory: async (args: Parameters<typeof getHistory>[1]) =>
      getHistory(client, { ...args, deployment: args.deployment ?? options.deployment }),
    fiat24SimulateCall: async (args: Parameters<typeof simulateCall>[1]) =>
      simulateCall(client, args),
  });
}
