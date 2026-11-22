declare const key: `0x${string}`;
declare const rpcUrl: string;

// #region readme
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

import type { Fiat24Signer } from "@qntx/fiat24";

const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: arbitrum, transport: http(rpcUrl) });

const signer: Fiat24Signer = {
  address: account.address,
  // Sign and broadcast exactly these bytes with exactly this nonce, or throw before broadcasting.
  sendTransaction: async ({ to, data, value, nonce }) =>
    wallet.sendTransaction({ to, data, value, nonce }),
  // personal_sign of the grant message; the wallet should rebuild it from (chainId, tokenId, deadline).
  signSessionGrant: async ({ message }) => wallet.signMessage({ message }),
};
// #endregion readme
