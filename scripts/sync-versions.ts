/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

/**
 * Rewrites a manifest's internal dependency ranges to `version`: `^<v>` in peerDependencies, `<v>`
 * in dependencies and devDependencies. Returns the (possibly mutated) manifest; bumpp rewrites each
 * package's own `version` field, this covers the ranges bumpp cannot express in JSON.
 */
export function syncInternalDeps(
  pkg: JsonObject,
  version: string,
  internalNames: ReadonlySet<string>,
): JsonObject {
  for (const [section, prefix] of [
    ["peerDependencies", "^"],
    ["dependencies", ""],
    ["devDependencies", ""],
  ] as const) {
    const deps = asRecord(pkg[section]);
    for (const name of Object.keys(deps)) {
      if (internalNames.has(name)) {
        deps[name] = `${prefix}${version}`;
      }
    }
  }
  return pkg;
}

/**
 * Rewrites the `"version"` of each `workspaces["<dir>"]` entry in bun.lock text to the manifest
 * version, replacing only the quoted value inside the `"<dir>": { "name": …, "version": … }` entry
 * so every other byte is unchanged. bun does not rewrite a workspace `version` on its own: `bun
 * install --lockfile-only` reports "no changes" when nothing else in the lock differs, so a
 * version-only bump would leave the lock stale. Throws when a dir has no matching entry.
 */
export function syncLockVersions(lock: string, versions: ReadonlyMap<string, string>): string {
  let out = lock;
  for (const [dir, version] of versions) {
    const escaped = dir.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const entry = new RegExp(
      `("${escaped}"\\s*:\\s*\\{\\s*"name"\\s*:\\s*"[^"]*?"\\s*,\\s*"version"\\s*:\\s*)"[^"]*?"`,
    );
    let found = false;
    out = out.replace(entry, (_whole: string, prefix: string) => {
      found = true;
      return `${prefix}"${version}"`;
    });
    if (!found) {
      throw new Error(`bun.lock: no workspaces["${dir}"] entry with a "version"`);
    }
  }
  return out;
}

if (import.meta.main) {
  const dirs = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name));

  const manifests = new Map<string, JsonObject>();
  const internalNames = new Set<string>();
  for (const dir of dirs) {
    const path = join(dir, "package.json");
    const pkg: unknown = JSON.parse(readFileSync(path, "utf8"));
    manifests.set(path, asRecord(pkg));
    const { name } = asRecord(pkg);
    if (typeof name === "string") {
      internalNames.add(name);
    }
  }

  const version = manifests.get("packages/fiat24/package.json")?.["version"];
  if (typeof version === "string") {
    for (const [path, pkg] of manifests) {
      syncInternalDeps(pkg, version, internalNames);
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    }

    // bun.lock mirrors the workspace versions under `workspaces`; refresh
    // the lockfile without touching dependencies. bumpp runs the `execute`
    // hook without a shell — `&&` would reach bun as arguments — so the
    // refresh is spawned here instead of chained in bump.config.ts.
    const lock = spawnSync("bun", ["install", "--lockfile-only"], { stdio: "inherit" });
    if (lock.status === 0) {
      // bun does not rewrite a workspace `version` when nothing else in the lock
      // changes, so a version-only bump leaves `workspaces["<dir>"].version`
      // stale; patch it in place.
      try {
        const path = "bun.lock";
        const text = readFileSync(path, "utf8");
        const lockVersions = new Map<string, string>();
        for (const dir of dirs) {
          const manifest = manifests.get(join(dir, "package.json"));
          const dirVersion = manifest?.["version"];
          if (typeof dirVersion === "string") {
            lockVersions.set(dir, dirVersion);
          }
        }
        const synced = syncLockVersions(text, lockVersions);
        if (synced !== text) {
          writeFileSync(path, synced);
        }
      } catch (error) {
        console.error(`sync-versions: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    } else {
      const why =
        lock.error === undefined ? `exit code ${String(lock.status)}` : lock.error.message;
      console.error(`sync-versions: bun install --lockfile-only failed: ${why}`);
      process.exitCode = 1;
    }
  } else {
    console.error('sync-versions: packages/fiat24/package.json has no string "version"');
    process.exitCode = 1;
  }
}
