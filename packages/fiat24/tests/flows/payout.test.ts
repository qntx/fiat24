import { encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vite-plus/test";

import { tokenAbi } from "../../src/abi/index.ts";
import type {
  BankPaymentRequest,
  Fiat24Session,
  VerifiedPayout,
  VerifiedQrPayout,
} from "../../src/api/types.ts";
import { topic0Of } from "../../src/chain/context.ts";
import { Fiat24Error } from "../../src/core/errors.ts";
import { arbitrum as C } from "../../src/deployments/index.ts";
import {
  advancePayout,
  encodeFlowState,
  loadPayoutSettlement,
  startPayout,
} from "../../src/flows/index.ts";
import type { PayoutDraft, PayoutState } from "../../src/flows/index.ts";
import { DOC_QR } from "../api/stub.ts";
import type { CallEntry } from "../chain/stub.ts";
import { expectErrorAsync } from "../chain/stub.ts";
import { throwsCode } from "../helpers.ts";
import {
  accountEntries,
  addressTopic,
  availabilityEntries,
  B,
  flowDeps,
  honestStorage,
  logPayload,
  makeFlowStub,
  makeSigner,
  mergeCalls,
  OWNER,
  proxyAdminEntry,
  receiptPayload,
  txPayload,
  TXID_1,
  word,
} from "./stub.ts";

const TOKEN = C.tokens.EUR24.proxy;
const CHF24 = C.tokens.CHF24.proxy;
const ACCOUNT = C.account.proxy;
const OWNER_CS = getAddress(OWNER);
const DESK = "0x0000000000000000000000000000000000009102" as Address;
const OTHER_ID = 402001n;

const TOKEN_ID = 690333n;
const AMOUNT = 100n;
const MINIMUM = 5n;
const CONTACT_ID = "EA-123456";
const QRCH = "QRCH";
const PURPOSE_ID = 2n;
const QR_PURPOSE_ID = 101n;
const UUID_PART = "50fb0941-4f59-4a89-8735-dd78ba7d53a3";
// §6.2: the ref goes out verbatim, NUL padding included.
const REF = `${TOKEN_ID}-${UUID_PART}`;
const REF_PADDED = `${REF}\u0000\u0000`;
const QR_ACCOUNT = "LI7830174502999200012";
const QR_AMOUNT = 194975n;
const TXID = "pacs.008.001.01-abc";

const BANK_REQUEST: BankPaymentRequest = {
  account: QR_ACCOUNT,
  bankName: "Bank",
  bic: "SAHHCHZ2",
  purpose: PURPOSE_ID,
  creditor: "BR",
};

const CONTACT_DRAFT: PayoutDraft = {
  flow: "payout",
  step: "draft",
  owner: OWNER_CS,
  tokenId: TOKEN_ID,
  currency: "EUR24",
  amount: AMOUNT,
  target: { kind: "contact", contactId: CONTACT_ID },
};

const BANK_DRAFT: PayoutDraft = {
  ...CONTACT_DRAFT,
  target: { kind: "bank", request: BANK_REQUEST },
};

const QR_DRAFT: PayoutDraft = {
  ...CONTACT_DRAFT,
  currency: "CHF24",
  amount: QR_AMOUNT,
  target: { kind: "swiss-qr", qr: DOC_QR },
};

const VERIFIED: PayoutState = {
  flow: "payout",
  version: 1,
  owner: OWNER_CS,
  txs: [],
  step: "verified",
  tokenId: TOKEN_ID,
  currency: "EUR24",
  amount: AMOUNT,
  contactId: CONTACT_ID,
};

const VERIFIED_REF: PayoutState = {
  ...VERIFIED,
  currency: "CHF24",
  amount: QR_AMOUNT,
  contactId: QRCH,
  purposeId: QR_PURPOSE_ID,
  ref: REF_PADDED,
};

const SUBMITTED: PayoutState = {
  ...VERIFIED,
  step: "tx",
  txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

const SUBMITTED_REF: PayoutState = {
  ...VERIFIED_REF,
  step: "tx",
  txs: [{ purpose: "main", phase: "submitted", fromBlock: B, nonce: 5, hash: TXID_1 }],
};

function bankVerified(overrides: Partial<VerifiedPayout> = {}): VerifiedPayout {
  return { contactId: CONTACT_ID, purposeId: PURPOSE_ID, ref: REF_PADDED, ...overrides };
}

function qrVerified(overrides: Partial<VerifiedQrPayout> = {}): VerifiedQrPayout {
  return {
    contactId: QRCH,
    purposeId: QR_PURPOSE_ID,
    ref: REF_PADDED,
    currency: "CHF24",
    amount: QR_AMOUNT,
    account: QR_ACCOUNT,
    creditor: { name: "Payee" },
    ...overrides,
  };
}

type TableOpts = {
  readonly currency?: "EUR24" | "CHF24";
  readonly amount?: bigint;
  readonly contactId?: string;
  readonly purposeId?: bigint;
  readonly ref?: string;
  readonly balance?: bigint;
  readonly minimum?: bigint;
  readonly allowed?: boolean;
  readonly withinLimit?: boolean;
  readonly statusIndex?: number;
  readonly historic?: bigint;
  readonly tokenOwner?: Address;
  readonly paused?: Readonly<Record<string, boolean>>;
};

/** Every read the payout main guard + simulate consumes for one ready round. */
function payoutTable(opts: TableOpts = {}): Map<string, CallEntry[]> {
  const token = (opts.currency === "CHF24" ? CHF24 : TOKEN).toLowerCase();
  const amount = opts.amount ?? AMOUNT;
  const contactId = opts.contactId ?? CONTACT_ID;
  const readId = opts.historic ?? TOKEN_ID;
  const table = mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({ paused: opts.paused ?? false }),
    accountEntries(OWNER, {
      historic: readId,
      statusIndex: opts.statusIndex ?? 5,
      ...(opts.tokenOwner === undefined ? {} : { owner: opts.tokenOwner }),
    }),
    new Map<string, CallEntry[]>([
      [`${token}:minimalPayoutAmount`, [{ answer: { result: opts.minimum ?? MINIMUM } }]],
      [`${token}:balanceOf`, [{ args: [OWNER], answer: { result: opts.balance ?? 1000n } }]],
      [
        `${token}:tokenTransferAllowed`,
        [{ args: [OWNER, DESK, amount], answer: { result: opts.allowed ?? true } }],
      ],
      [`${token}:convertToChf`, [{ args: [amount], answer: { result: amount } }]],
      [
        `${ACCOUNT.toLowerCase()}:checkLimit`,
        [{ args: [TOKEN_ID, amount], answer: { result: opts.withinLimit ?? true } }],
      ],
      [`${token}:clientPayout`, [{ args: [amount, contactId], answer: { raw: "0x" } }]],
      [
        `${token}:clientPayoutRef`,
        [
          {
            args: [amount, contactId, opts.purposeId ?? PURPOSE_ID, opts.ref ?? REF_PADDED],
            answer: { raw: "0x" },
          },
        ],
      ],
    ]),
  );
  // ownerOf order per guard round: senderLive's readId first, then the 9102 desk.
  table.set(`${ACCOUNT.toLowerCase()}:ownerOf`, [
    { args: [readId], answer: { result: opts.tokenOwner ?? OWNER } },
    { args: [9102n], answer: { result: DESK } },
  ]);
  return table;
}

function sessionStub(tokenId: bigint, verified: VerifiedPayout | VerifiedQrPayout): Fiat24Session {
  return {
    tokenId,
    verifyBankPayment: async () => Promise.resolve(verified),
    verifySwissQr: async () => Promise.resolve(verified as VerifiedQrPayout),
  } as unknown as Fiat24Session;
}

function payoutData(amount: bigint, contactId: string): Hex {
  return encodeFunctionData({
    abi: tokenAbi,
    functionName: "clientPayout",
    args: [amount, contactId],
  });
}

function payoutRefData(amount: bigint, contactId: string, purposeId: bigint, ref: string): Hex {
  return encodeFunctionData({
    abi: tokenAbi,
    functionName: "clientPayoutRef",
    args: [amount, contactId, purposeId, ref],
  });
}

function payoutLog(opts: {
  readonly token: Address;
  readonly ref?: string;
  readonly tokenId?: bigint;
  readonly sender?: Address;
  readonly txid?: string;
}): Record<string, unknown> {
  const withRef = opts.ref !== undefined;
  return logPayload({
    address: opts.token,
    topics: [
      topic0Of(tokenAbi, withRef ? "ClientPayoutRef" : "ClientPayout"),
      word(opts.tokenId ?? TOKEN_ID),
      addressTopic(opts.sender ?? OWNER),
    ],
    data: encodeAbiParameters(
      withRef
        ? [
            { type: "uint256" },
            { type: "uint256" },
            { type: "string" },
            { type: "string" },
            { type: "uint256" },
            { type: "string" },
          ]
        : [{ type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "string" }],
      (withRef
        ? [9102n, QR_AMOUNT, QRCH, opts.txid ?? TXID, QR_PURPOSE_ID, opts.ref]
        : [9102n, AMOUNT, CONTACT_ID, opts.txid ?? TXID]) as never,
    ),
    blockNumber: B + 1n,
    transactionHash: TXID_1,
  });
}

describe("startPayout", () => {
  test("validates and returns an in-memory draft", () => {
    const draft = startPayout({
      owner: OWNER,
      tokenId: TOKEN_ID,
      currency: "EUR24",
      amount: AMOUNT,
      target: { kind: "contact", contactId: CONTACT_ID },
    });
    expect(draft.step).toBe("draft");
    expect(draft.owner).toBe(OWNER_CS);
    const swiss = startPayout({
      owner: OWNER,
      tokenId: TOKEN_ID,
      currency: "CHF24",
      amount: QR_AMOUNT,
      target: { kind: "swiss-qr", qr: DOC_QR },
    });
    expect(swiss.amount).toBe(QR_AMOUNT);
  });

  test("encodeFlowState refuses a draft (PII is memory-only)", () => {
    expect(() => encodeFlowState(BANK_DRAFT as never)).toThrow(Fiat24Error);
    expect(() => encodeFlowState(BANK_DRAFT as never)).toThrow(/invalid flow state/);
  });

  test("refuses bad fields: contactId, currency, amount, QR mismatch, internal id", () => {
    const attempts: ReadonlyArray<readonly [() => unknown, ReadonlySet<string>]> = [
      [
        () =>
          startPayout({
            owner: OWNER,
            tokenId: TOKEN_ID,
            currency: "EUR24",
            amount: AMOUNT,
            target: { kind: "contact", contactId: "ea-1" },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startPayout({
            owner: OWNER,
            tokenId: TOKEN_ID,
            currency: "USD24" as never,
            amount: AMOUNT,
            target: { kind: "contact", contactId: CONTACT_ID },
          }),
        new Set(["unsupported-currency", "invalid-argument"]),
      ],
      [
        () =>
          startPayout({
            owner: OWNER,
            tokenId: TOKEN_ID,
            currency: "EUR24",
            amount: 0n,
            target: { kind: "contact", contactId: CONTACT_ID },
          }),
        new Set(["invalid-amount", "invalid-argument"]),
      ],
      [
        () =>
          startPayout({
            owner: OWNER,
            tokenId: TOKEN_ID,
            currency: "EUR24",
            amount: QR_AMOUNT,
            target: { kind: "swiss-qr", qr: DOC_QR },
          }),
        new Set(["invalid-argument"]),
      ],
      [
        () =>
          startPayout({
            owner: OWNER,
            tokenId: 0n,
            currency: "EUR24",
            amount: AMOUNT,
            target: { kind: "contact", contactId: CONTACT_ID },
          }),
        new Set(["invalid-account-id", "invalid-argument"]),
      ],
    ];
    const results = attempts.map(([attempt, codes]) => throwsCode(attempt, codes));
    expect(results.every(Boolean)).toBe(true);
  });
});

describe("advancePayout draft → verified", () => {
  test("contact: verified with contactId only, persist once, no session needed", async () => {
    const stub = makeFlowStub({});
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advancePayout(deps, CONTACT_DRAFT);
    expect(next.step).toBe("verified");
    expect(next.contactId).toBe(CONTACT_ID);
    expect(next.purposeId).toBeUndefined();
    expect(next.ref).toBeUndefined();
    expect(persisted).toStrictEqual([next]);
  });

  test("bank: /verify values bound, ref persisted verbatim with NULs", async () => {
    const stub = makeFlowStub({});
    const { deps, persisted } = flowDeps(stub.client);
    const session = sessionStub(TOKEN_ID, bankVerified());
    const next = await advancePayout({ ...deps, session }, BANK_DRAFT);
    expect(next).toStrictEqual({
      flow: "payout",
      version: 1,
      owner: OWNER_CS,
      txs: [],
      step: "verified",
      tokenId: TOKEN_ID,
      currency: "EUR24",
      amount: AMOUNT,
      contactId: CONTACT_ID,
      purposeId: PURPOSE_ID,
      ref: REF_PADDED,
    });
    expect(persisted).toStrictEqual([next]);
  });

  test("swiss-qr: /verify values bound, QRCH contactId persisted", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const session = sessionStub(TOKEN_ID, qrVerified());
    const next = await advancePayout({ ...deps, session }, QR_DRAFT);
    expect(next.step).toBe("verified");
    expect(next.contactId).toBe(QRCH);
    expect(next.purposeId).toBe(QR_PURPOSE_ID);
    expect(next.ref).toBe(REF_PADDED);
  });

  test("session missing ⇒ session-required; tokenId mismatch ⇒ invalid-argument", async () => {
    const stub = makeFlowStub({});
    const { deps } = flowDeps(stub.client);
    const missing = await expectErrorAsync(
      async () => advancePayout(deps, BANK_DRAFT),
      "session-required",
    );
    expect(missing).toBeInstanceOf(Fiat24Error);
    const wrong = sessionStub(OTHER_ID, bankVerified());
    const mismatch = await expectErrorAsync(
      async () => advancePayout({ ...deps, session: wrong }, BANK_DRAFT),
      "invalid-argument",
    );
    expect(mismatch).toBeInstanceOf(Fiat24Error);
  });

  test("a tampered draft is re-validated with no I/O", async () => {
    const stub = makeFlowStub({});
    const { deps, persisted } = flowDeps(stub.client);
    const tampered = {
      ...CONTACT_DRAFT,
      target: { kind: "contact", contactId: "bad!" },
    } as never;
    await expectErrorAsync(async () => advancePayout(deps, tampered), "invalid-argument");
    expect(persisted).toStrictEqual([]);
  });
});

describe("api-mismatch", () => {
  test("bank: each broken binding ⇒ api-mismatch on GET /verify, nothing persisted", async () => {
    const hostile: ReadonlyArray<Partial<VerifiedPayout>> = [
      { purposeId: PURPOSE_ID + 1n },
      { contactId: "not-an-id" },
      { ref: `${OTHER_ID}-${UUID_PART}` }, // foreign payer prefix
      { ref: "no-prefix-here" },
      { ref: `${REF_PADDED}x` }, // over-length padding
    ];
    await Promise.all(
      hostile.map(async (overrides) => {
        const stub = makeFlowStub({});
        const { deps, persisted } = flowDeps(stub.client);
        const session = sessionStub(TOKEN_ID, bankVerified(overrides));
        const error = await expectErrorAsync(
          async () => advancePayout({ ...deps, session }, BANK_DRAFT),
          "api-mismatch",
        );
        expect(error.detail.endpoint).toBe("GET /verify");
        expect(persisted).toStrictEqual([]);
      }),
    );
  });

  test("swiss-qr: each broken binding ⇒ api-mismatch, nothing persisted", async () => {
    const hostile: ReadonlyArray<Partial<VerifiedQrPayout>> = [
      { currency: "EUR24" }, // ≠ scanned CHF
      { currency: "CHF24", amount: QR_AMOUNT + 1n }, // ≠ scanned amount
      { currency: "CHF24", amount: QR_AMOUNT, contactId: "EA-1" }, // ≠ QRCH
      { account: "LI0000000000000000000" }, // ≠ scanned account
      { ref: `${OTHER_ID}-${UUID_PART}` }, // foreign payer prefix
      { ref: "no-prefix-here" },
      // purposeId is not a QR binding — only the rebuild refuses it (> 10^6).
      { purposeId: 1_000_001n },
    ];
    await Promise.all(
      hostile.map(async (overrides) => {
        const stub = makeFlowStub({});
        const { deps, persisted } = flowDeps(stub.client);
        const session = sessionStub(TOKEN_ID, qrVerified(overrides));
        const error = await expectErrorAsync(
          async () => advancePayout({ ...deps, session }, QR_DRAFT),
          "api-mismatch",
        );
        expect(error.detail.endpoint).toBe("GET /verify");
        expect(persisted).toStrictEqual([]);
      }),
    );
  });

  test("swiss-qr: a draft whose amount no longer matches the scan ⇒ invalid-argument", async () => {
    const stub = makeFlowStub({});
    const { deps, persisted } = flowDeps(stub.client);
    const tampered = { ...QR_DRAFT, amount: QR_AMOUNT + 1n };
    const session = sessionStub(TOKEN_ID, qrVerified());
    await expectErrorAsync(
      async () => advancePayout({ ...deps, session }, tampered),
      "invalid-argument",
    );
    expect(persisted).toStrictEqual([]);
  });
});

describe("advancePayout verified → tx", () => {
  test("contact: payoutCall sent, signer sees the exact calldata", async () => {
    const stub = makeFlowStub({
      calls: payoutTable(),
      storage: honestStorage(),
      count: { pending: 5 },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advancePayout(deps, VERIFIED);
    expect(next.step).toBe("tx");
    const record = next.txs.at(-1);
    expect(record?.phase).toBe("submitted");
    expect(persisted).toHaveLength(2);
    expect(stub.requests.map((request) => request.method)).toContain("eth_call");
  });

  test("NUL-padded ref goes into clientPayoutRef calldata verbatim", async () => {
    const stub = makeFlowStub({
      calls: payoutTable({
        currency: "CHF24",
        amount: QR_AMOUNT,
        contactId: QRCH,
        purposeId: QR_PURPOSE_ID,
        ref: REF_PADDED,
        balance: QR_AMOUNT + 100n,
      }),
      storage: honestStorage(),
      count: { pending: 5 },
    });
    const { signer, requests } = makeSigner(OWNER);
    const { deps } = flowDeps(stub.client, { signer });
    const next = await advancePayout(deps, VERIFIED_REF);
    expect(next.step).toBe("tx");
    const request = requests.at(-1);
    expect(request?.data).toBe(payoutRefData(QR_AMOUNT, QRCH, QR_PURPOSE_ID, REF_PADDED));
    expect(request?.to).toBe(getAddress(CHF24));
  });

  test("guard failures: paused, not-live, wrong account, minimum, balance, leg", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly table: Map<string, CallEntry[]>;
      readonly code: string;
    }> = [
      {
        name: "account paused",
        table: payoutTable({ paused: { [ACCOUNT.toLowerCase()]: true } }),
        code: "unavailable",
      },
      {
        name: "token paused",
        table: payoutTable({ paused: { [TOKEN.toLowerCase()]: true } }),
        code: "unavailable",
      },
      {
        name: "not live",
        table: payoutTable({ statusIndex: 1 }),
        code: "not-live",
      },
      {
        name: "resolved account is not the stored tokenId",
        table: payoutTable({ historic: OTHER_ID }),
        code: "invalid-argument",
      },
      {
        name: "account no longer owned",
        table: payoutTable({ tokenOwner: DESK }),
        code: "invalid-argument",
      },
      {
        name: "below minimum",
        table: payoutTable({ minimum: AMOUNT + 1n }),
        code: "below-minimum",
      },
      {
        name: "insufficient balance",
        table: payoutTable({ balance: AMOUNT - 1n }),
        code: "insufficient-balance",
      },
      {
        name: "leg refused within limit",
        table: payoutTable({ allowed: false, withinLimit: true }),
        code: "transfer-not-allowed",
      },
      {
        name: "leg refused over limit",
        table: payoutTable({ allowed: false, withinLimit: false }),
        code: "limit-exceeded",
      },
    ];
    await Promise.all(
      cases.map(async ({ table, code }) => {
        const stub = makeFlowStub({ calls: table, storage: honestStorage() });
        const { deps, persisted } = flowDeps(stub.client);
        await expectErrorAsync(async () => advancePayout(deps, VERIFIED), code);
        expect(persisted).toStrictEqual([]);
      }),
    );
  });

  test("confirmed: txid extracted from the ClientPayout event", async () => {
    const stub = makeFlowStub({
      blockNumber: B + 10n,
      calls: proxyAdminEntry(),
      storage: honestStorage(),
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [payoutLog({ token: TOKEN, txid: "pacs.008-done" })],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
      logs: () => [],
    });
    const { deps } = flowDeps(stub.client);
    const next = await advancePayout(deps, SUBMITTED);
    expect(next.step).toBe("confirmed");
    // The txid is not persisted — loadPayoutSettlement re-derives it from the receipt.
    const settlement = await loadPayoutSettlement({ client: stub.client }, next);
    expect(settlement.txid).toBe("pacs.008-done");
  });

  test("confirmed: ClientPayoutRef receipt yields txid for a ref payout", async () => {
    const stub = makeFlowStub({
      blockNumber: B + 10n,
      calls: proxyAdminEntry(),
      storage: honestStorage(),
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [payoutLog({ token: CHF24, ref: REF_PADDED, txid: "pacs.008-ref" })],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: CHF24,
          input: payoutRefData(QR_AMOUNT, QRCH, QR_PURPOSE_ID, REF_PADDED),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
      logs: () => [],
    });
    const { deps } = flowDeps(stub.client);
    const next = await advancePayout(deps, SUBMITTED_REF);
    expect(next.step).toBe("confirmed");
    const settlement = await loadPayoutSettlement({ client: stub.client }, next);
    expect(settlement.txid).toBe("pacs.008-ref");
  });

  test("missing payout event ⇒ invalid-rpc-response, no transition", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client);
    const error = await expectErrorAsync(
      async () => advancePayout(deps, SUBMITTED),
      "invalid-rpc-response",
    );
    expect(error).toBeInstanceOf(Fiat24Error);
  });

  test("reverted receipt ⇒ failed{tx-reverted}", async () => {
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "reverted",
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps } = flowDeps(stub.client);
    const next = await advancePayout(deps, SUBMITTED);
    expect(next.step).toBe("failed");
    expect(next.txs.at(-1)?.error).toBe("tx-reverted");
  });

  test("confirmed re-checks the receipt — still there ⇒ the same state, persisted once", async () => {
    const confirmed: PayoutState = {
      ...VERIFIED,
      step: "confirmed",
      txs: [
        {
          purpose: "main",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 1n,
          status: "success",
          logs: [payoutLog({ token: TOKEN })],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 1n,
        }),
      },
    });
    const { deps, persisted } = flowDeps(stub.client);
    const next = await advancePayout(deps, confirmed);
    expect(next).toStrictEqual(confirmed);
    expect(persisted).toStrictEqual([next]);
  });

  test("confirmed re-check: receipt and tx gone, nonce consumed ⇒ back to tx{unknown}", async () => {
    const confirmed: PayoutState = {
      ...VERIFIED,
      step: "confirmed",
      txs: [
        {
          purpose: "main",
          phase: "confirmed",
          fromBlock: B,
          nonce: 5,
          hash: TXID_1,
        },
      ],
    };
    const stub = makeFlowStub({ count: { latest: 6 }, logs: () => [] });
    const { deps } = flowDeps(stub.client);
    const next = await advancePayout(deps, confirmed);
    expect(next.step).toBe("tx");
    expect(next.txs.at(-1)).toStrictEqual({
      purpose: "main",
      phase: "unknown",
      fromBlock: B,
      nonce: 5,
      hash: TXID_1,
      error: "unknown-outcome",
    });
  });
});

describe("loadPayoutSettlement", () => {
  const CONFIRMED: PayoutState = {
    ...VERIFIED,
    step: "confirmed",
    txs: [
      {
        purpose: "main",
        phase: "confirmed",
        fromBlock: B,
        nonce: 5,
        hash: TXID_1,
      },
    ],
  };

  test("settled payout: txid from the fresh receipt, logs from its block", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const stub = makeFlowStub({
      blockNumber: B + 10n,
      calls: proxyAdminEntry(),
      storage: honestStorage(),
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 3n,
          status: "success",
          logs: [payoutLog({ token: TOKEN })],
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 3n,
        }),
      },
      logs: (filter) => {
        seen.push(filter);
        return [];
      },
    });
    const result = await loadPayoutSettlement({ client: stub.client }, CONFIRMED);
    // `pacs.008.001.01-abc` is the txid in payoutLog's ClientPayout event.
    expect(result).toStrictEqual({ status: "pending", blockNumber: B + 10n, txid: TXID });
    // The getLogs window starts at the FRESH receipt's block — nothing persisted.
    expect(seen).toStrictEqual([
      {
        address: TOKEN,
        topics: [topic0Of(tokenAbi, "CashPayout"), word(TOKEN_ID)],
        fromBlock: `0x${(B + 3n).toString(16)}`,
        toBlock: `0x${(B + 10n).toString(16)}`,
      },
    ]);
  });

  test("a matching CashPayout log settles (and 9103 rejects)", async () => {
    const cash = (payoutAccount: bigint) => ({
      address: TOKEN,
      topics: [topic0Of(tokenAbi, "CashPayout"), word(TOKEN_ID), addressTopic(DESK)],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "string" }, { type: "string" }],
        [payoutAccount, CONTACT_ID, TXID],
      ),
      blockNumber: `0x${(B + 5n).toString(16)}`,
      transactionHash: TXID_1,
      logIndex: "0x0",
    });
    await Promise.all(
      (
        [
          [9104n, "settled"],
          [9103n, "rejected"],
        ] as const
      ).map(async ([payoutAccount, status]) => {
        const stub = makeFlowStub({
          blockNumber: B + 10n,
          calls: proxyAdminEntry(),
          storage: honestStorage(),
          receipts: {
            [TXID_1]: receiptPayload({
              transactionHash: TXID_1,
              blockNumber: B + 3n,
              status: "success",
              logs: [payoutLog({ token: TOKEN })],
            }),
          },
          transactions: {
            [TXID_1]: txPayload({
              hash: TXID_1,
              from: OWNER,
              to: TOKEN,
              input: payoutData(AMOUNT, CONTACT_ID),
              value: 0n,
              nonce: 5,
              blockNumber: B + 3n,
            }),
          },
          logs: () => [cash(payoutAccount)],
        });
        const result = await loadPayoutSettlement({ client: stub.client }, CONFIRMED);
        expect(result.status).toBe(status);
        expect(result.txid).toBe(TXID);
      }),
    );
  });

  test("missing receipt ⇒ invalid-state (advance the flow to reconcile)", async () => {
    expect.hasAssertions();
    const stub = makeFlowStub({});
    await expectErrorAsync(
      async () => loadPayoutSettlement({ client: stub.client }, CONFIRMED),
      "invalid-state",
    );
  });

  test("mismatching transaction ⇒ invalid-state", async () => {
    expect.hasAssertions();
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 3n,
          status: "success",
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, "OTHER-CONTACT"),
          value: 0n,
          nonce: 5,
          blockNumber: B + 3n,
        }),
      },
    });
    await expectErrorAsync(
      async () => loadPayoutSettlement({ client: stub.client }, CONFIRMED),
      "invalid-state",
    );
  });

  test("reverted receipt ⇒ invalid-state", async () => {
    expect.hasAssertions();
    const stub = makeFlowStub({
      receipts: {
        [TXID_1]: receiptPayload({
          transactionHash: TXID_1,
          blockNumber: B + 3n,
          status: "reverted",
        }),
      },
      transactions: {
        [TXID_1]: txPayload({
          hash: TXID_1,
          from: OWNER,
          to: TOKEN,
          input: payoutData(AMOUNT, CONTACT_ID),
          value: 0n,
          nonce: 5,
          blockNumber: B + 3n,
        }),
      },
    });
    await expectErrorAsync(
      async () => loadPayoutSettlement({ client: stub.client }, CONFIRMED),
      "invalid-state",
    );
  });

  test("a non-confirmed state is invalid-state before I/O", async () => {
    const stub = makeFlowStub({});
    await expectErrorAsync(
      async () => loadPayoutSettlement({ client: stub.client }, VERIFIED),
      "invalid-state",
    );
    expect(stub.requests).toHaveLength(0);
  });
});
