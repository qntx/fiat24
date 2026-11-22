import { bytesToString } from "viem";

import { Fiat24Error } from "../core/errors.ts";
import type { Fiat24ErrorCode, Fiat24ErrorDetail } from "../core/errors.ts";

export const API_BASE_URL = "https://api.fiat24.com";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB (§9.4); /banks passes 8 MiB.

export type RequestSpec = {
  readonly method: "GET" | "POST" | "PUT";
  // Path template without values ("/verify", "/banks/iban/{iban}") — goes in message/detail.
  readonly template: string;
  // Concrete path incl. query, starts with "/"; never surfaces in errors (§9.5).
  readonly path: string;
  // Secured requests don't get the public-500 -> rate-limited rule (§9.5).
  readonly secured: boolean;
  readonly headers?: Readonly<Record<string, string>>; // session headers
  readonly body?: unknown; // JSON body (writes)
  readonly maxBytes?: number;
};

/**
 * The single error factory of the api layer (§9.5): `message = "<endpoint> failed"`, `detail =
 * {endpoint, status?}` where `endpoint = "<METHOD> <template>"`. Never a `cause`, never the
 * concrete path/query, header, body text or zod issue — responses carry PII (I7).
 */
export function apiError(code: Fiat24ErrorCode, endpoint: string, status?: number): Fiat24Error {
  const detail: Fiat24ErrorDetail = status === undefined ? { endpoint } : { endpoint, status };
  return new Fiat24Error(code, `${endpoint} failed`, detail);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFetch(value: unknown): value is typeof fetch {
  return typeof value === "function";
}

/**
 * The response body capped while reading: chunks are summed as they arrive and the stream is
 * cancelled the moment the total crosses `maxBytes`, so an uncapped 2xx body is never buffered
 * whole (R-03). A reader rejection is a transport failure (network-error); a chunk that is not a
 * `Uint8Array` is a malformed body (invalid-response). The stream is cancelled on every refusal; a
 * cancel rejection is not the failure.
 */
async function readBody(
  reader: ReadableStreamDefaultReader<unknown>,
  maxBytes: number,
  endpoint: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let refused = false;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stream chunks are sequential
      const part: { done: boolean; value?: unknown } = await reader.read();
      if (part.done) {
        break;
      }
      const { value } = part;
      if (!(value instanceof Uint8Array)) {
        refused = true;
        break;
      }
      total += value.byteLength;
      chunks.push(value);
      if (total > maxBytes) {
        refused = true;
        break;
      }
    }
  } catch {
    throw apiError("network-error", endpoint);
  }
  if (refused) {
    await reader.cancel().catch(() => undefined);
    throw apiError("invalid-response", endpoint);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytesToString(bytes);
}

// UTF-8 byte length of a JS string, computed over UTF-16 code units (<0x80 -> 1, <0x800 -> 2,
// surrogate pair -> 4, else 3; a lone surrogate counts 3 like the U+FFFD it would encode to).
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.codePointAt(i) ?? 0;
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit > 0xffff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * §9.1/§9.5 transport: returns the parsed JSON of a 2xx. `fetch` resolves as `fetchOption ??
 * globalThis.fetch` at call time (missing => network-error). Headers are `network: 42161`,
 * `cache-control: no-store`, then session headers, then `content-type` on writes. Init keys are
 * `method`, `headers`, `body` on writes and `redirect: "error"` — a spec fetch rejects on any
 * redirect (network-error) so the bearer grant can never be forwarded to another origin. No
 * `cache`/`signal`/`credentials`/`mode` init keys — whatwg-fetch rewrites GET URLs when `cache:
 * "no-store"` is set (R/f10), and hosts own timeouts. A redirect-shaped response is refused
 * `invalid-response` before the status checks because an injected fetch may ignore the option and
 * React Native's XHR fetch follows redirects regardless. The body is never read on non-2xx.
 */
export async function request(
  fetchOption: typeof fetch | undefined,
  spec: RequestSpec,
): Promise<unknown> {
  const endpoint = `${spec.method} ${spec.template}`;
  // `typeof` keeps the guard honest for JS callers whose globalThis.fetch is a non-function.
  const resolved: unknown = fetchOption ?? globalThis.fetch;
  const fetchFn = isFetch(resolved) ? resolved : undefined;
  if (fetchFn === undefined) {
    throw apiError("network-error", endpoint);
  }
  const headers: Record<string, string> = {
    network: "42161",
    "cache-control": "no-store",
    ...spec.headers,
  };
  if (spec.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const init: RequestInit = { method: spec.method, headers, redirect: "error" };
  if (spec.body !== undefined) {
    init.body = JSON.stringify(spec.body);
  }
  let response: Response;
  try {
    response = await fetchFn(API_BASE_URL + spec.path, init);
  } catch {
    throw apiError("network-error", endpoint);
  }
  const { status } = response;
  // A fetch that ignored `redirect: "error"` surfaced a redirect: refuse it before any status or
  // body handling — the request may have carried the bearer grant to another origin's answer. The
  // url check is origin-level, not string equality: WHATWG parsing percent-encodes characters the
  // request path keeps literal (`'` becomes %27), so a no-redirect answer can differ in spelling.
  if (
    response.type === "opaqueredirect" ||
    (status >= 300 && status < 400) ||
    response.redirected ||
    (typeof response.url === "string" &&
      response.url !== "" &&
      !response.url.startsWith(`${API_BASE_URL}/`))
  ) {
    throw apiError("invalid-response", endpoint);
  }
  if (status === 401) {
    throw apiError("unauthorized", endpoint, status);
  }
  if (status === 429 || (status === 500 && !spec.secured)) {
    // The doc's public-abuse block answers 500; a secured 500 stays a plain http-error (§9.5).
    throw apiError("rate-limited", endpoint, status);
  }
  if (status < 200 || status >= 300) {
    throw apiError("http-error", endpoint, status);
  }
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw apiError("invalid-response", endpoint);
  }
  // When fetch exposes a response stream the cap is enforced while reading; a host fetch without
  // streams (React Native's XHR fetch) only offers text(), which buffers the body before the cap.
  const stream = response.body;
  let text: string;
  if (
    typeof stream === "object" &&
    stream !== null &&
    "getReader" in stream &&
    typeof stream.getReader === "function"
  ) {
    text = await readBody(stream.getReader(), maxBytes, endpoint);
  } else {
    try {
      text = await response.text();
    } catch {
      throw apiError("network-error", endpoint);
    }
    if (utf8Length(text) > maxBytes) {
      throw apiError("invalid-response", endpoint);
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw apiError("invalid-response", endpoint);
  }
  if (isRecord(body)) {
    // Generic rejections shared by every endpoint: `{error: string}` and the write envelope
    // `{status: <non-200>, data}` (§9.5). `{status: 200}` is a write ack, handled downstream.
    if (typeof body["error"] === "string") {
      throw apiError("api-rejected", endpoint, status);
    }
    const bodyStatus = body["status"];
    if (typeof bodyStatus === "number" && bodyStatus !== 200 && Object.hasOwn(body, "data")) {
      throw apiError(
        "api-rejected",
        endpoint,
        Number.isSafeInteger(bodyStatus) ? bodyStatus : status,
      );
    }
  }
  return body;
}
