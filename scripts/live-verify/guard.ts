import { API_BASE_URL } from "../../packages/fiat24/src/api/http.ts";

/**
 * The transport allow-list — the security core of live-verify. Every request the SDK issues for
 * this run is checked against the four read-only GETs before it reaches the real fetch. Anything
 * else — writes, /verify, other endpoints, other origins, bodies, redirects — is refused before
 * `inner` is called. Refusal messages name the class of the violation only: a URL, path, query or
 * header value can carry PII and must never appear in an error.
 */

const SESSION_HEADERS: ReadonlySet<string> = new Set(["tokenid", "hash", "deadline", "sign"]);
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "network",
  "cache-control",
  ...SESSION_HEADERS,
]);

// GET /transactions as issued by createSecured({ ... }).transactions({currency, recordsCount}):
// `currency` first, then `recordscount` (1-1000), nothing else.
const TRANSACTIONS_QUERY = /^currency=(EUR|USD|CHF|CNH|ALL)&recordscount=([1-9][0-9]{0,2}|1000)$/;

type Rule = {
  readonly path: string;
  readonly query: RegExp | undefined; // undefined = no query allowed
  readonly secured: boolean; // all four session headers required / none allowed
};

const RULES: ReadonlyArray<Rule> = [
  { path: "/timestamp", query: undefined, secured: false },
  { path: "/br", query: undefined, secured: true },
  { path: "/cards", query: undefined, secured: true },
  { path: "/transactions", query: TRANSACTIONS_QUERY, secured: true },
];

/**
 * Wraps `inner` so only the allow-listed requests pass. `onRefuse` is invoked with the violation
 * class before the refusal throws — callers use it to abort the whole run, since the SDK turns the
 * thrown error into a generic `network-error` that must not be silently swallowed.
 */
export function guardFetch(inner: typeof fetch, onRefuse?: (reason: string) => void): typeof fetch {
  const refuse = (reason: string): never => {
    onRefuse?.(reason);
    throw new Error(`live-verify transport guard: ${reason}`);
  };
  const guarded = async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (typeof input !== "string") {
      return refuse("non-string request input");
    }
    if (!input.startsWith(`${API_BASE_URL}/`)) {
      return refuse("request outside the API origin");
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return refuse("unparseable request URL");
    }
    if (
      url.origin !== API_BASE_URL ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return refuse("request outside the API origin");
    }
    const rule = RULES.find((candidate) => candidate.path === url.pathname);
    if (rule === undefined) {
      return refuse("path outside the allow-list");
    }
    const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    if (rule.query === undefined ? query !== "" : !rule.query.test(query)) {
      return refuse("unexpected query");
    }
    if (init === undefined || init.method !== "GET") {
      return refuse("method is not GET");
    }
    if (init.body !== undefined) {
      return refuse("request carries a body");
    }
    if (init.redirect !== "error") {
      return refuse("redirect mode is not error");
    }
    const names = new Set<string>();
    for (const [name] of new Headers(init.headers)) {
      names.add(name);
    }
    for (const name of names) {
      if (!ALLOWED_HEADERS.has(name)) {
        return refuse("header outside the allow-list");
      }
    }
    const sessionCount = [...SESSION_HEADERS].filter((name) => names.has(name)).length;
    if (rule.secured && sessionCount !== SESSION_HEADERS.size) {
      return refuse("missing session headers");
    }
    if (!rule.secured && sessionCount !== 0) {
      return refuse("session headers on a public endpoint");
    }
    return inner(input, init);
  };
  return guarded;
}
