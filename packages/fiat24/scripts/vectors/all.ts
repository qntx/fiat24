import { finish, vectorFile } from "./lib.ts";

// No generators yet: a producer is added together with the code whose
// constants it pins down. An entry is
// ["vectors/<area>/<name>.json", build, "packages/fiat24/scripts/vectors/<name>.ts"].
const GENERATORS: ReadonlyArray<
  readonly [path: string, build: () => { capability: string; cases: unknown[] }, generator: string]
> = [];

for (const [path, build, generator] of GENERATORS) {
  const { capability, cases } = build();
  vectorFile(path, capability, cases, generator);
}
finish();
