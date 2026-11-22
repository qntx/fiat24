import type { Client } from "viem";

import type { Fiat24Signer } from "@qntx/fiat24";

declare const client: Client;
declare const signer: Fiat24Signer;
declare const store: {
  get: (id: string) => Promise<string>;
  set: (id: string, value: string) => Promise<void>;
};
declare const id: string;
declare function sleep(ms: number): Promise<void>;

// #region readme
import {
  advanceTransfer,
  decodeFlowState,
  encodeFlowState,
  startTransfer,
} from "@qntx/fiat24/flows";
import type { FlowDeps, TransferState } from "@qntx/fiat24/flows";

const deps: FlowDeps = {
  client,
  signer,
  persist: async (state) => {
    await store.set(id, encodeFlowState(state));
  },
};

let state: TransferState = startTransfer({
  owner: signer.address,
  currency: "EUR24",
  amount: 1000n,
  to: { tokenId: 469709n },
});
while (state.step !== "confirmed" && state.step !== "failed" && state.step !== "not-sent") {
  state = await advanceTransfer(deps, state);
  if (state.txs.at(-1)?.error === "signer-rejected") {
    // The user declined the prompt: stop and show the rejection; the
    // persisted state reconciles on a later advance.
    break;
  }
  if (state.step === "tx") {
    await sleep(15_000);
  }
}

// After a restart: resume from what was persisted, narrowing the decoded union.
const resumed = decodeFlowState(await store.get(id));
if (resumed.flow === "transfer") {
  state = await advanceTransfer(deps, resumed);
}
// #endregion readme
