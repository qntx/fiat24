import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** `// #region readme` … `// #endregion readme` body of a tests/readme file. */
function region(relative: string): string {
  const source = readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
  const match = /\/\/ #region readme\n([\s\S]*?)\n\/\/ #endregion readme/.exec(source);
  if (match === null) {
    throw new Error(`no readme region in ${relative}`);
  }
  return match[1] ?? "";
}

const BLOCK_PATTERN = /```ts\n([\s\S]*?)\n```/g;
const MARKED_PATTERN = /<!-- example: (tests\/readme\/[a-z0-9.-]+) -->\n\n?```ts\n([\s\S]*?)\n```/g;

function markedBlocks(): ReadonlyArray<readonly [string, string]> {
  return [...README.matchAll(MARKED_PATTERN)].map((m) => [m[1] ?? "", m[2] ?? ""] as const);
}

describe("README examples", () => {
  test("every ```ts block is marked", () => {
    expect([...README.matchAll(BLOCK_PATTERN)]).toHaveLength(markedBlocks().length);
    expect(markedBlocks().length).toBeGreaterThan(0);
  });

  test.each(markedBlocks())("block %s equals its region", (relative, block) => {
    expect(block).toBe(region(relative));
  });
});
