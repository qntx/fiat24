import { build as buildCalls } from "./calls.ts";
import { build as buildEvents } from "./events.ts";
import { build as buildIban } from "./iban.ts";
import { finish, vectorFile } from "./lib.ts";
import { build as buildMoney } from "./money.ts";
import { build as buildSession } from "./session.ts";

// An entry is ["vectors/<area>/<name>.json", build, "<generator script>"]; the
// generator name lands in the envelope's `source.generator`.
const GENERATORS = [
  ["vectors/core/amount.json", buildMoney, "packages/fiat24/scripts/vectors/money.ts"],
  ["vectors/core/iban.json", buildIban, "packages/fiat24/scripts/vectors/iban.ts"],
  ["vectors/calls/calldata.json", buildCalls, "packages/fiat24/scripts/vectors/calls.ts"],
  ["vectors/events/decode.json", buildEvents, "packages/fiat24/scripts/vectors/events.ts"],
  ["vectors/api/session.json", buildSession, "packages/fiat24/scripts/vectors/session.ts"],
] as const;

for (const [path, build, generator] of GENERATORS) {
  const { capability, source, cases } = build();
  vectorFile(path, capability, { ...source, generator }, cases);
}
finish();
