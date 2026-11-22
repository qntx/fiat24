import { describe, expect, test } from "vite-plus/test";

import { syncInternalDeps } from "./sync-versions.ts";

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
