import { describe, expect, test } from "vite-plus/test";

import { syncInternalDeps, syncLockVersions } from "./sync-versions.ts";

const INTERNAL = new Set(["@qntx/fiat24", "@qntx/fiat24-extra"]);

describe("syncInternalDeps", () => {
  test("rewrites peer ranges to ^<version> and dep/dev ranges to <version>", () => {
    const pkg = {
      name: "@qntx/fiat24-extra",
      peerDependencies: { "@qntx/fiat24": "^0.9.0" },
      dependencies: { "@qntx/fiat24": "0.9.0" },
      devDependencies: { "@qntx/fiat24": "0.9.0", typescript: "7.0.2" },
    };
    expect(syncInternalDeps(pkg, "0.9.1", INTERNAL)).toStrictEqual({
      name: "@qntx/fiat24-extra",
      peerDependencies: { "@qntx/fiat24": "^0.9.1" },
      dependencies: { "@qntx/fiat24": "0.9.1" },
      devDependencies: { "@qntx/fiat24": "0.9.1", typescript: "7.0.2" },
    });
  });

  test("leaves manifests without internal deps untouched", () => {
    const pkg = { name: "@qntx/fiat24", dependencies: { zod: "^4.6.7" } };
    expect(syncInternalDeps(pkg, "0.9.1", INTERNAL)).toStrictEqual(pkg);
  });
});

// Cut down from bun.lock: the root "" workspace, the packages/fiat24 entry and a slice of the
// packages section (trailing commas included, as JSONC).
const LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "@qntx/fiat24-monorepo",
      "devDependencies": {
        "typescript": "7.0.2",
        "vite-plus": "1.4.0",
      },
    },
    "packages/fiat24": {
      "name": "@qntx/fiat24",
      "version": "0.0.0",
      "dependencies": {
        "zod": "^4.6.7",
      },
      "devDependencies": {
        "typescript": "7.0.2",
        "viem": "2.57.12",
      },
      "peerDependencies": {
        "viem": "^2.57.12",
      },
    },
  },
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@1.4.0",
  },
  "packages": {
    "zod": ["zod@4.6.7", "", {}, "sha512-deadbeef"],
  },
}
`;

describe("syncLockVersions", () => {
  test("rewrites only the workspace version line, byte-identical elsewhere", () => {
    const synced = syncLockVersions(LOCK, new Map([["packages/fiat24", "0.1.0"]]));
    const expected = LOCK.replace(
      '"packages/fiat24": {\n      "name": "@qntx/fiat24",\n      "version": "0.0.0",',
      '"packages/fiat24": {\n      "name": "@qntx/fiat24",\n      "version": "0.1.0",',
    );
    expect(synced).toBe(expected);
    expect(synced).not.toBe(LOCK);
  });

  test("returns the input unchanged when the version already matches", () => {
    expect(syncLockVersions(LOCK, new Map([["packages/fiat24", "0.0.0"]]))).toBe(LOCK);
  });

  test("throws for a dir with no workspace entry", () => {
    expect(() => syncLockVersions(LOCK, new Map([["packages/missing", "0.1.0"]]))).toThrow(
      'bun.lock: no workspaces["packages/missing"] entry with a "version"',
    );
  });

  test("does not touch the root workspace or package versions elsewhere", () => {
    const synced = syncLockVersions(LOCK, new Map([["packages/fiat24", "9.9.9"]]));
    expect(synced).toContain('"": {\n      "name": "@qntx/fiat24-monorepo"');
    expect(synced).toContain('"zod": ["zod@4.6.7"');
    expect(synced).toContain('"viem": "^2.57.12"');
  });
});
