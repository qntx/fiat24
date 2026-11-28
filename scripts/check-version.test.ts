import { describe, expect, it } from "vite-plus/test";

import { checkDepSpecs, checkReleaseTag, checkVersion, checkViteAliases } from "./check-version.ts";

const manifest = (pkg: unknown): { path: string; pkg: unknown } => ({
  path: "package.json",
  pkg,
});

const FIAT24 = {
  path: "packages/fiat24/package.json",
  pkg: {
    name: "@qntx/fiat24",
    version: "0.9.0",
    repository: {
      type: "git",
      url: "git+https://github.com/qntx/fiat24.git",
      directory: "packages/fiat24",
    },
  },
};

const FIAT24_EXTRA = {
  path: "packages/fiat24-extra/package.json",
  pkg: {
    name: "@qntx/fiat24-extra",
    version: "0.9.0",
    private: true,
    peerDependencies: { "@qntx/fiat24": "^0.9.0" } as Record<string, string>,
    dependencies: { "@qntx/fiat24": "0.9.0" } as Record<string, string>,
    devDependencies: { "@qntx/fiat24": "0.9.0" } as Record<string, string>,
  },
};

const PACKAGES = [FIAT24, FIAT24_EXTRA];

const BUN_LOCK = {
  workspaces: {
    "": { name: "@qntx/fiat24-monorepo" },
    "packages/fiat24": { name: "@qntx/fiat24", version: "0.9.0" },
    "packages/fiat24-extra": { name: "@qntx/fiat24-extra", version: "0.9.0" },
  },
};

describe("checkVersion", () => {
  it("accepts synced versions and the published repository", () => {
    expect(checkVersion(PACKAGES, BUN_LOCK)).toStrictEqual([]);
  });

  it("rejects a missing version", () => {
    const errors = checkVersion(
      [FIAT24, { ...FIAT24_EXTRA, pkg: { name: "@qntx/fiat24-extra", private: true } }],
      BUN_LOCK,
    );
    expect(errors).toStrictEqual([
      'packages/fiat24-extra/package.json: missing string "version"',
      'bun.lock: workspaces["packages/fiat24-extra"] has version "0.9.0", expected undefined',
    ]);
  });

  it("rejects an internal peer range without a caret", () => {
    const pkg = structuredClone(FIAT24_EXTRA.pkg);
    pkg.peerDependencies["@qntx/fiat24"] = "0.9.0";
    const errors = checkVersion([FIAT24, { ...FIAT24_EXTRA, pkg }], BUN_LOCK);
    expect(errors).toStrictEqual([
      'packages/fiat24-extra/package.json: peerDependencies["@qntx/fiat24"] must be "^0.9.0", got "0.9.0"',
    ]);
  });

  it("rejects an internal dev range with a caret", () => {
    const pkg = structuredClone(FIAT24_EXTRA.pkg);
    pkg.devDependencies["@qntx/fiat24"] = "^0.9.0";
    const errors = checkVersion([FIAT24, { ...FIAT24_EXTRA, pkg }], BUN_LOCK);
    expect(errors).toStrictEqual([
      'packages/fiat24-extra/package.json: devDependencies["@qntx/fiat24"] must be "0.9.0", got "^0.9.0"',
    ]);
  });

  it("rejects a stale bun.lock workspace version", () => {
    const stale = {
      workspaces: {
        "packages/fiat24": { name: "@qntx/fiat24", version: "0.8.0" },
        "packages/fiat24-extra": { name: "@qntx/fiat24-extra", version: "0.8.0" },
      },
    };
    const errors = checkVersion(PACKAGES, stale);
    expect(errors).toStrictEqual([
      'bun.lock: workspaces["packages/fiat24"] has version "0.8.0", expected "0.9.0"',
      'bun.lock: workspaces["packages/fiat24-extra"] has version "0.8.0", expected "0.9.0"',
    ]);
  });

  it("rejects a bun.lock workspace entry that is missing", () => {
    const errors = checkVersion(PACKAGES, { workspaces: {} });
    expect(errors).toStrictEqual([
      'bun.lock: missing workspaces["packages/fiat24"] entry',
      'bun.lock: missing workspaces["packages/fiat24-extra"] entry',
    ]);
  });

  it("rejects a published package without the provenance repository", () => {
    const pkg = structuredClone(FIAT24.pkg);
    (pkg.repository as Record<string, string>)["directory"] = "packages/other";
    const errors = checkVersion([{ ...FIAT24, pkg }, FIAT24_EXTRA], BUN_LOCK);
    expect(errors).toStrictEqual([
      'packages/fiat24/package.json: repository must be { url: "git+https://github.com/qntx/fiat24.git", directory: "packages/fiat24" }',
    ]);
  });
});

describe("checkViteAliases", () => {
  it("passes when the alias matches the vite-plus core pin", () => {
    const errors = checkViteAliases(
      [
        manifest({
          dependencies: { vite: "npm:@voidzero-dev/vite-plus-core@1.4.0" },
          devDependencies: { "vite-plus": "1.4.0" },
          overrides: { vite: "npm:@voidzero-dev/vite-plus-core@1.4.0" },
        }),
        manifest({
          devDependencies: {
            "vite-plus": "1.7.0",
            vite: "npm:@voidzero-dev/vite-plus-core@8.3.8000",
          },
        }),
      ],
      "1.4.0",
    );
    expect(errors).toStrictEqual([
      'package.json: devDependencies["vite"] resolves vite-plus-core 8.3.8000, expected 1.4.0 pinned by vite-plus',
    ]);
  });

  it("passes for the independently versioned core", () => {
    const errors = checkViteAliases(
      [
        manifest({
          devDependencies: {
            "vite-plus": "1.7.0",
            vite: "npm:@voidzero-dev/vite-plus-core@8.3.8000",
          },
          overrides: { vite: "npm:@voidzero-dev/vite-plus-core@8.3.8000" },
        }),
      ],
      "8.3.8000",
    );
    expect(errors).toStrictEqual([]);
  });

  const stale = "npm:@voidzero-dev/vite-plus-core@1.3.0";
  const devDeps = { "vite-plus": "1.4.0" };

  it.each([
    ["dependencies", { dependencies: { vite: stale }, devDependencies: devDeps }],
    ["devDependencies", { devDependencies: { ...devDeps, vite: stale } }],
    ["overrides", { overrides: { vite: stale }, devDependencies: devDeps }],
  ] as const)("fails on %s drift", (section, pkg) => {
    const errors = checkViteAliases([manifest(pkg)], "1.4.0");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${section}["vite"]`);
    expect(errors[0]).toContain("expected 1.4.0");
  });

  it("ignores manifests without vite-plus and non-alias vite specs", () => {
    const errors = checkViteAliases(
      [
        manifest({ dependencies: { vite: "npm:@voidzero-dev/vite-plus-core@9.9.9" } }),
        manifest({
          dependencies: { vite: "^7.0.0" },
          devDependencies: { "vite-plus": "1.4.0" },
        }),
      ],
      "1.4.0",
    );
    expect(errors).toStrictEqual([]);
  });
});

describe("checkDepSpecs", () => {
  it("accepts the forms the repo actually uses", () => {
    const errors = checkDepSpecs([
      manifest({
        dependencies: { exact: "4.6.7", caret: "^4.6.7" },
        peerDependencies: { viem: "^2.57.12" },
        devDependencies: {
          exact: "7.0.2",
          alias: "npm:@voidzero-dev/vite-plus-core@1.4.0",
          ws: "workspace:*",
          cat: "catalog:tools",
          file: "file:../x",
          link: "link:../../packages/fiat24",
        },
      }),
    ]);
    expect(errors).toStrictEqual([]);
  });

  it.each([
    ["a caret devDependency", { devDependencies: { dep: "^7.0.2" } }],
    ["a tilde devDependency", { devDependencies: { dep: "~1.0.0" } }],
    ["a tilde dependency", { dependencies: { dep: "~1.0.0" } }],
    ["a tilde peer", { peerDependencies: { dep: "~1.0.0" } }],
    ["a range peer", { peerDependencies: { dep: ">=1.0.0" } }],
    ["a bare major", { dependencies: { dep: "1" } }],
    ["a wildcard", { dependencies: { dep: "*" } }],
    ["a non-exact npm alias", { devDependencies: { dep: "npm:other@^1.0.0" } }],
  ] as const)("fails on %s", (_label, pkg) => {
    const errors = checkDepSpecs([manifest(pkg)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must be");
  });
});

describe("checkReleaseTag", () => {
  const pkg = (path: string, version: string, extra: Record<string, unknown> = {}) => ({
    path,
    pkg: { name: path, version, ...extra },
  });
  const helper = pkg("packages/fiat24-tools/package.json", "0.0.0", { private: true });
  const packages = [pkg("packages/fiat24/package.json", "0.9.0"), helper];

  it("accepts a tag naming the version of every published package", () => {
    expect(checkReleaseTag("v0.9.0", packages)).toStrictEqual([]);
    expect(
      checkReleaseTag("v1.0.0-rc.1", [pkg("packages/fiat24/package.json", "1.0.0-rc.1")]),
    ).toStrictEqual([]);
  });

  it("names every published package whose version disagrees with the tag", () => {
    const errors = checkReleaseTag("v0.9.1", packages);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packages/fiat24/package.json");
  });

  it.each(["0.9.0", "v0.9", "v0.9.0.1", "release-0.9.0", ""])(
    "rejects the malformed tag %j",
    (tag) => {
      const errors = checkReleaseTag(tag, packages);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("is not v<major>.<minor>.<patch>");
    },
  );

  it("fails when nothing would be published", () => {
    expect(checkReleaseTag("v0.0.0", [helper])).toStrictEqual(["no published package found"]);
  });
});
