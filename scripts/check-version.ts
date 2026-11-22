/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  JSONC: { parse: (text: string) => unknown };
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

const REPOSITORY_URL = "git+https://github.com/qntx/fiat24.git";

export type PackageEntry = { path: string; pkg: unknown };

const scanDir = (dir: string): PackageEntry[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, pkg: JSON.parse(readFileSync(path, "utf8")) as unknown }));

/**
 * Consistency check: internal `@qntx/*` dependencies must be `^<version>` in peerDependencies and
 * `<version>` in dependencies and devDependencies (the sibling convention: a peer floats to the
 * consumer's compatible release, a build pin does not), every `workspaces` entry in bun.lock must
 * record the package.json version of its workspace directory, and every published package's
 * `repository` must name this repository and its own directory — npm provenance rejects a publish
 * whose repository does not match the building repository. The private workspace root is not passed
 * in.
 */
export function checkVersion(packages: PackageEntry[], bunLock: unknown): string[] {
  const errors: string[] = [];

  const internalVersions = new Map<string, string>();
  for (const { pkg } of packages) {
    const { name, version } = asRecord(pkg);
    if (typeof name === "string" && typeof version === "string") {
      internalVersions.set(name, version);
    }
  }

  for (const { path, pkg } of packages) {
    const manifest = asRecord(pkg);
    const { version } = manifest;
    if (typeof version !== "string") {
      errors.push(`${path}: missing string "version"`);
      continue;
    }
    for (const [section, prefix] of [
      ["peerDependencies", "^"],
      ["dependencies", ""],
      ["devDependencies", ""],
    ] as const) {
      const deps = asRecord(manifest[section]);
      for (const [name, spec] of Object.entries(deps)) {
        const depVersion = internalVersions.get(name);
        if (depVersion === undefined) {
          continue;
        }
        const expected = `${prefix}${depVersion}`;
        if (spec !== expected) {
          errors.push(
            `${path}: ${section}["${name}"] must be "${expected}", got ${JSON.stringify(spec)}`,
          );
        }
      }
    }
  }

  // bun.lock mirrors each workspace manifest's `version` under `workspaces`
  // keyed by directory; drift means the lockfile refresh was skipped.
  const workspaces = asRecord(asRecord(bunLock)["workspaces"]);
  for (const { path, pkg } of packages) {
    const dir = path.slice(0, -"/package.json".length);
    const { version } = asRecord(pkg);
    const entry = workspaces[dir];
    if (entry === undefined) {
      errors.push(`bun.lock: missing workspaces["${dir}"] entry`);
      continue;
    }
    const lockVersion = asRecord(entry)["version"];
    if (lockVersion !== version) {
      errors.push(
        `bun.lock: workspaces["${dir}"] has version ${JSON.stringify(lockVersion)}, expected ${JSON.stringify(version)}`,
      );
    }
  }

  // npm provenance rejects a publish whose repository does not match the building repository, so
  // every published package declares it, down to its own directory.
  for (const { path, pkg } of packages) {
    const manifest = asRecord(pkg);
    if (manifest["private"] === true) {
      continue;
    }
    const repository = asRecord(manifest["repository"]);
    const directory = path.replace(/\/package\.json$/, "");
    if (repository["url"] !== REPOSITORY_URL || repository["directory"] !== directory) {
      errors.push(
        `${path}: repository must be { url: "${REPOSITORY_URL}", directory: "${directory}" }`,
      );
    }
  }

  return errors;
}

/**
 * Every `vite` spec aliased to @voidzero-dev/vite-plus-core must match the manifest's own
 * `vite-plus` version: vp resolves its vite command through the alias, and drift between the two is
 * what broke CI on the vite-plus 1.4.0 bump.
 */
export function checkViteAliases(manifests: PackageEntry[]): string[] {
  const errors: string[] = [];
  for (const { path, pkg } of manifests) {
    const manifest = asRecord(pkg);
    const vitePlus = asRecord(manifest["devDependencies"])["vite-plus"];
    if (typeof vitePlus !== "string") {
      continue;
    }
    for (const section of ["dependencies", "devDependencies", "overrides"] as const) {
      const spec = asRecord(manifest[section])["vite"];
      const core =
        typeof spec === "string"
          ? /^npm:@voidzero-dev\/vite-plus-core@(.+)$/.exec(spec)?.[1]
          : undefined;
      if (core !== undefined && core !== vitePlus) {
        errors.push(
          `${path}: ${section}["vite"] resolves vite-plus-core ${core}, expected ${vitePlus} to match vite-plus`,
        );
      }
    }
  }
  return errors;
}

const EXACT_SPEC = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const CARET_SPEC = /^\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const exactTarget = (spec: string): boolean => {
  if (spec.startsWith("npm:")) {
    const target = spec.slice("npm:".length);
    return EXACT_SPEC.test(target.slice(target.lastIndexOf("@") + 1));
  }
  return EXACT_SPEC.test(spec);
};

const isSpecForm = (spec: string): boolean =>
  spec.startsWith("workspace:") ||
  spec.startsWith("catalog:") ||
  spec.startsWith("file:") ||
  spec.startsWith("link:");

/**
 * DevDependencies are exact pins; internal `@qntx/*` specs are covered by `checkVersion`. Runtime
 * dependencies and peerDependencies of external packages may carry a caret range (consumers resolve
 * their own compatible minor — `zod`, `viem`), but never a tilde, `>=`, `*`, a bare major, or a
 * floating `npm:` alias. A caret is never allowed in devDependencies.
 */
export function checkDepSpecs(manifests: PackageEntry[]): string[] {
  const errors: string[] = [];
  for (const { path, pkg } of manifests) {
    const manifest = asRecord(pkg);
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const [name, spec] of Object.entries(asRecord(manifest[section]))) {
        if (typeof spec !== "string" || isSpecForm(spec)) {
          continue;
        }
        const allowed =
          section === "devDependencies"
            ? exactTarget(spec)
            : exactTarget(spec) || CARET_SPEC.test(spec);
        if (allowed) {
          continue;
        }
        const want = section === "devDependencies" ? "exact" : "exact or a caret range";
        errors.push(`${path}: ${section}["${name}"] must be ${want}, got ${JSON.stringify(spec)}`);
      }
    }
  }
  return errors;
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * A release tag names the version of every published package: the publish workflow skips a version
 * already on the registry, so a tag that disagrees with the manifests would publish nothing (or a
 * stale subset) while reporting success.
 */
export function checkReleaseTag(tag: string, packages: PackageEntry[]): string[] {
  const version = RELEASE_TAG.exec(tag)?.[1];
  if (version === undefined) {
    return [`release tag ${JSON.stringify(tag)} is not v<major>.<minor>.<patch>[-prerelease]`];
  }
  const published = packages.filter(({ pkg }) => asRecord(pkg)["private"] !== true);
  if (published.length === 0) {
    return ["no published package found"];
  }
  return published
    .filter(({ pkg }) => asRecord(pkg)["version"] !== version)
    .map(
      ({ path, pkg }) =>
        `${path}: version ${JSON.stringify(asRecord(pkg)["version"])} does not match release tag ${tag}`,
    );
}

if (import.meta.main) {
  // Only directories with a package.json are workspaces; bare leftovers may
  // exist under packages/.
  const packages = scanDir("packages");
  const errors = checkVersion(packages, Bun.JSONC.parse(readFileSync("bun.lock", "utf8")));
  const manifests: PackageEntry[] = [
    { path: "package.json", pkg: JSON.parse(readFileSync("package.json", "utf8")) as unknown },
    ...packages,
  ];
  errors.push(...checkViteAliases(manifests), ...checkDepSpecs(manifests));
  const tagFlag = process.argv.indexOf("--release-tag");
  if (tagFlag !== -1) {
    errors.push(...checkReleaseTag(process.argv[tagFlag + 1] ?? "", packages));
  }
  for (const error of errors) {
    console.error(`check-version: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
