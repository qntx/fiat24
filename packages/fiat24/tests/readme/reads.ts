import type { Address } from "viem";

declare const rpcUrl: string;
declare const owner: Address;

// #region readme
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";

import { fiat24PublicActions } from "@qntx/fiat24";

const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) }).extend(
  fiat24PublicActions(),
);
const account = await client.fiat24GetAccount({ owner });
const { balances } = await client.fiat24GetBalances({ owner });
// #endregion readme
