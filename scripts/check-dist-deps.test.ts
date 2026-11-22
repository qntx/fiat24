import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { checkDistDeps } from "./check-dist-deps.ts";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dist-deps-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const CLEAN = {
  "package.json": JSON.stringify({
    name: "fixture",
    dependencies: { zod: "^4.0.0" },
    peerDependencies: { viem: "^2.0.0" },
  }),
  "dist/index.mjs": 'import { x } from "./chunk-abc.mjs";\nexport const y = x;\n',
  "dist/chunk-abc.mjs": 'import { isAddress } from "viem";\nexport const x = isAddress;\n',
  "dist/chunk-abc.mjs.map": JSON.stringify({ sources: ["../src/core/thing.ts"] }),
};

describe("checkDistDeps", () => {
  it("passes a clean fixture", () => {
    expect(checkDistDeps(fixture(CLEAN))).toStrictEqual([]);
  });

  it("fails when a @qntx/wallet* package is a dependency", () => {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      const root = fixture({
        ...CLEAN,
        "package.json": JSON.stringify({
          name: "fixture",
          [field]: { "@qntx/wallet-core": "1.0.0" },
        }),
      });
      expect(checkDistDeps(root).join("; ")).toContain("wallet dependency @qntx/wallet-core");
    }
  });

  it("fails when a dist file imports a @qntx/wallet* package", () => {
    const root = fixture({
      ...CLEAN,
      "dist/extra.mjs": 'import { w } from "@qntx/wallet-chains/sign";\nexport const z = w;\n',
    });
    expect(checkDistDeps(root).join("; ")).toContain(
      "wallet import @qntx/wallet-chains/sign in dist/extra.mjs",
    );
  });

  it("fails when a dist import is undeclared", () => {
    const root = fixture({
      ...CLEAN,
      "dist/extra.mjs": 'import { u } from "left-pad";\nexport const z = u;\n',
    });
    expect(checkDistDeps(root).join("; ")).toContain("undeclared imports");
  });

  it("fails when the root closure imports zod", () => {
    const root = fixture({
      ...CLEAN,
      "dist/chunk-abc.mjs": 'import { z } from "zod";\nexport const x = z;\n',
    });
    expect(checkDistDeps(root).join("; ")).toContain("root closure imports zod");
  });

  it("passes when a non-root chunk imports zod", () => {
    const root = fixture({
      ...CLEAN,
      "dist/api.mjs": 'import { z } from "zod";\nexport const api = z;\n',
    });
    expect(checkDistDeps(root)).toStrictEqual([]);
  });

  it("fails when the root closure reaches an api/flows chunk (sourcemap sources)", () => {
    const root = fixture({
      ...CLEAN,
      "dist/chunk-abc.mjs.map": JSON.stringify({ sources: ["../src/api/session.ts"] }),
    });
    expect(checkDistDeps(root).join("; ")).toContain("../src/api/session.ts");
  });

  it("fails when the root closure reaches the api entry directly", () => {
    const root = fixture({
      ...CLEAN,
      "dist/index.mjs": 'import { api } from "./api.mjs";\nexport const y = api;\n',
      "dist/api.mjs": "export const api = 1;\n",
    });
    expect(checkDistDeps(root).join("; ")).toContain("forbidden entry dist/api.mjs");
  });
});
