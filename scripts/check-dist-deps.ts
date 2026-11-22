/**
 * Guards on the published dist:
 *
 * 1. `vp pack` externals every import that is not in `deps.onlyBundle`, so a src import of a package
 *    missing from `dependencies`/`peerDependencies`/`optionalDependencies` would ship as a broken
 *    external. Scan dist/*.mjs imports and require each bare specifier to be declared.
 * 2. I13: the SDK is wallet-independent — no `@qntx/wallet*` package may appear in any dependency
 *    field (dependencies, peer, optional, dev) or in any dist import.
 * 3. I23: the root entry stays free of api/flows/zod. Follow `dist/index.mjs` relative imports
 *    transitively and fail if that closure imports `zod` or reaches an api/flows chunk. Chunks are
 *    identified by their sourcemap `sources` entries (`../src/api/…`, `../src/flows/…`) — the entry
 *    file itself has no map, so a relative import that resolves to the `api`/`flows` entry basename
 *    fails too.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

const specifier = (name: string): string =>
  name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name);

const IMPORT_RE = /from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    out.push(match[1] ?? match[2] ?? "");
  }
  return out;
}

/** Returns every problem found in `<dir>/package.json` + `<dir>/dist`, empty when clean. */
export function checkDistDeps(dir: string): string[] {
  const problems: string[] = [];
  const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const pkg = isRecord(raw) ? raw : {};
  const declared = new Set<string>(
    DEP_FIELDS.flatMap((key) => (isRecord(pkg[key]) ? Object.keys(pkg[key]) : [])),
  );

  for (const key of DEP_FIELDS) {
    if (isRecord(pkg[key])) {
      for (const name of Object.keys(pkg[key])) {
        if (name.startsWith("@qntx/wallet")) {
          problems.push(`wallet dependency ${name} in package.json ${key}`);
        }
      }
    }
  }

  const distDir = join(dir, "dist");
  const bad = new Set<string>();
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith(".mjs")) {
      continue;
    }
    const text = readFileSync(join(distDir, file), "utf8");
    for (const spec of importsOf(text)) {
      if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:")) {
        continue;
      }
      const name = specifier(spec);
      if (name.startsWith("@qntx/wallet")) {
        problems.push(`wallet import ${spec} in dist/${file}`);
        continue;
      }
      if (!declared.has(name)) {
        bad.add(`${name} (${spec} in ${file})`);
      }
    }
  }
  if (bad.size > 0) {
    problems.push(`undeclared imports in ${distDir}: ${[...bad].join(", ")}`);
  }

  // I23: transitive closure of the root entry.
  const rootEntry = join(distDir, "index.mjs");
  const seen = new Set<string>();
  const queue = [rootEntry];
  const FORBIDDEN_ENTRIES = new Set(["api.mjs", "flows.mjs"]);
  const FORBIDDEN_SOURCE = /src[/\\](api|flows)[/\\]/;
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!existsSync(file)) {
      continue;
    }
    const base = file.split(/[/\\]/).pop() ?? "";
    if (file !== rootEntry && FORBIDDEN_ENTRIES.has(base)) {
      problems.push(`root closure reaches forbidden entry dist/${base}`);
    }
    const text = readFileSync(file, "utf8");
    for (const spec of importsOf(text)) {
      if (!spec.startsWith(".")) {
        if (specifier(spec) === "zod") {
          problems.push(`root closure imports zod (${spec} in ${base})`);
        }
        continue;
      }
      const resolved = normalize(join(dirname(file), spec));
      queue.push(resolved.endsWith(".mjs") ? resolved : `${resolved}.mjs`);
    }
    const mapPath = `${file}.map`;
    if (existsSync(mapPath)) {
      const map: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
      const sources = isRecord(map) && Array.isArray(map["sources"]) ? map["sources"] : [];
      for (const source of sources) {
        if (typeof source === "string" && FORBIDDEN_SOURCE.test(source)) {
          problems.push(`root closure includes ${source} (chunk ${base})`);
        }
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? ".";
  const problems = checkDistDeps(dir);
  if (problems.length > 0) {
    throw new Error(`check-dist-deps ${dir}: ${problems.join("; ")}`);
  }
  const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const name = isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : dir;
  console.log(`check-dist-deps ${name}: all dist imports are declared, no wallet/zod/api/flows`);
}
