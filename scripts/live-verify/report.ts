import type { DiffRow, PathStats, ShapeProfile } from "./shape.ts";
import { enumSummary } from "./shape.ts";

/** One endpoint's report section: transport facts, SDK outcome, shape and diffs — never values. */
export type EndpointReport = {
  readonly endpoint: string; // e.g. "GET /br" — the SDK template, a fixed vocabulary
  readonly sent: boolean;
  readonly httpStatus?: number;
  readonly contentType?: string; // a class: "json" | "text" | "other" | "none"
  readonly outcome: string; // "ok" or a Fiat24Error code
  readonly shape?: ShapeProfile;
  readonly schemaDiff: ReadonlyArray<DiffRow>;
  readonly fixtureDiff: ReadonlyArray<DiffRow>;
  readonly fixtureNote?: string; // e.g. fixture missing — the diff was skipped
};

export type PayoutRefSummary = {
  readonly candidates: number; // distinct own txIds pulled from /transactions
  readonly prefixedPadded45: number;
  readonly prefixedUnpadded: number;
  readonly invalid: number;
  readonly payoutNoRef: number;
  readonly unreadableReceipts: number;
};

export type Answer = "yes" | "no" | "inconclusive";

export type ReportData = {
  readonly generatedAt: string; // ISO timestamp
  readonly ttlSeconds: bigint;
  readonly signerMode: string;
  readonly dryRun: boolean;
  readonly account: {
    readonly status: string;
    readonly tokenIdDigits: number;
    readonly deploymentOk: boolean;
  };
  readonly skew: {
    readonly sign: "+" | "-";
    readonly bucket: string;
  };
  readonly o1: { readonly answer: Answer; readonly why?: string };
  readonly cardsBody: { readonly httpStatus?: number; readonly statusCodeClass?: string };
  readonly payoutRefs: PayoutRefSummary;
  readonly endpoints: ReadonlyArray<EndpointReport>;
};

const counts = (map: ReadonlyMap<string, number>): string =>
  [...map.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, n]) => `${bucket}×${n}`)
    .join(", ");

const kinds = (stats: PathStats): string => [...stats.kinds].toSorted().join("|");

function statsDetail(stats: PathStats): string {
  const parts: string[] = [];
  if (stats.stringClasses.size > 0) {
    parts.push(`class ${counts(stats.stringClasses)}`);
  }
  if (stats.stringLengths.size > 0) {
    parts.push(`len ${counts(stats.stringLengths)}`);
  }
  const summary = enumSummary(stats);
  if (summary !== undefined) {
    parts.push(summary);
  }
  if (stats.intDigits.size > 0) {
    parts.push(`digits ${counts(stats.intDigits)}`);
  }
  if (stats.fractionDecimals.size > 0) {
    parts.push(`dec ${counts(stats.fractionDecimals)}`);
  }
  if (stats.lossyFractions > 0) {
    parts.push(`lossy×${stats.lossyFractions}`);
  }
  if (stats.arrayLengths.size > 0) {
    parts.push(`len ${counts(stats.arrayLengths)}`);
  }
  if (stats.keyCountBuckets.size > 0) {
    parts.push(`keys ${counts(stats.keyCountBuckets)}`);
  }
  return parts.join("; ");
}

function shapeLines(profile: ShapeProfile): string[] {
  const lines = ["| path | kinds | n | details |", "| --- | --- | --- | --- |"];
  for (const [path, stats] of [...profile.entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`| ${path} | ${kinds(stats)} | ${stats.count} | ${statsDetail(stats)} |`);
  }
  return lines;
}

function diffLines(rows: ReadonlyArray<DiffRow>): string[] {
  if (rows.length === 0) {
    return ["no differences"];
  }
  return rows.map((row) => `- ${row.issue} \`${row.path}\` — ${row.detail}`);
}

/** Renders the Markdown report. Every field arrives pre-redacted by the caller/shape analysis. */
export function renderReport(data: ReportData): string {
  const lines: string[] = [
    "# live-verify report",
    "",
    `- generated: ${data.generatedAt}`,
    `- grant ttl: ${data.ttlSeconds} s`,
    `- signer mode: ${data.signerMode}`,
    `- dry-run: ${data.dryRun ? "yes" : "no"}`,
    "",
    "## Account (chain facts only)",
    "",
    `- status: ${data.account.status}`,
    `- tokenId digit count: ${data.account.tokenIdDigits}`,
    `- deployment pinned values: ${data.account.deploymentOk ? "ok" : "DRIFT"}`,
    "",
    "## Requests",
  ];
  for (const endpoint of data.endpoints) {
    lines.push(
      "",
      `### ${endpoint.endpoint}`,
      "",
      `- sent: ${endpoint.sent ? "yes" : "no"}`,
      `- HTTP status: ${endpoint.httpStatus ?? "none"}`,
      `- content-type: ${endpoint.contentType ?? "none"}`,
      `- SDK outcome: ${endpoint.outcome}`,
    );
    if (endpoint.shape === undefined) {
      lines.push("", "shape: no body captured");
    } else {
      lines.push("", "shape:", "", ...shapeLines(endpoint.shape));
    }
    lines.push("", "vs SDK schema:", "", ...diffLines(endpoint.schemaDiff));
    if (endpoint.fixtureNote === undefined) {
      lines.push("", "vs fixture:", "", ...diffLines(endpoint.fixtureDiff));
    } else {
      lines.push("", `vs fixture: ${endpoint.fixtureNote}`);
    }
  }
  lines.push(
    "",
    "## Clock",
    "",
    `- skew sign: ${data.skew.sign}`,
    `- skew bucket: ${data.skew.bucket}`,
    "- within 300 s: yes (the run aborts otherwise)",
  );
  const { payoutRefs } = data;
  lines.push(
    "",
    "## Open questions",
    "",
    `- O-1 session label accepted: ${data.o1.answer}${data.o1.why === undefined ? "" : ` (${data.o1.why})`}`,
    `- grant with ttl=${data.ttlSeconds}s accepted: ${data.o1.answer}${data.o1.why === undefined ? "" : ` (${data.o1.why})`}`,
    "- server 1200 s grant cap tested: no (by design — this script never signs a longer grant)",
    `- O-7 GET /cards: HTTP ${data.cardsBody.httpStatus ?? "none"}, body statusCode ${data.cardsBody.statusCodeClass ?? "none"}`,
    `- O-3/O-9 payout refs: ${payoutRefs.candidates} candidate tx; prefixed+padded-45: ${payoutRefs.prefixedPadded45}; prefixed-unpadded: ${payoutRefs.prefixedUnpadded}; invalid: ${payoutRefs.invalid}; payout (no ref): ${payoutRefs.payoutNoRef}; unreadable receipts: ${payoutRefs.unreadableReceipts}`,
    "",
    "Read this whole file before sharing it: it is designed to contain shapes and counts only, never values — check that nothing unexpected slipped through.",
  );
  return `${lines.join("\n")}\n`;
}
