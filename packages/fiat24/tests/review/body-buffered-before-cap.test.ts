/**
 * R-03 — the 1 MiB body cap is enforced only after `response.text()` resolves, so an uncapped (no
 * content-length) 2xx body is buffered in full before `invalid-response` is thrown. This test
 * asserts the current defective behaviour; it is expected to fail once the finding is fixed.
 */
import { describe, expect, test } from "vite-plus/test";

import { createFiat24Api } from "../../src/api/index.ts";
import { expectCode } from "../api/stub.ts";

const MIB = 1024 * 1024;
const CHUNK = new Uint8Array(MIB).fill(49); // "1" — starts like a JSON digit stream.
CHUNK[0] = 91; // "["

/** A stream of `chunks` 1 MiB chunks that reports how many bytes were pulled from it. */
const mibStream = (chunks: number, onPull: (bytes: number) => void): ReadableStream<Uint8Array> => {
  let served = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (served < chunks) {
        served += 1;
        onPull(MIB);
        controller.enqueue(CHUNK);
      } else {
        controller.close();
      }
    },
  });
};

describe("body cap enforced only after full buffering (R-03)", () => {
  test("16 MiB stream without content-length is pulled whole", async () => {
    let pulled = 0;
    const stream = mibStream(16, (bytes) => {
      pulled += bytes;
    });
    const fetchFn = (async (): Promise<Response> => {
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const api = createFiat24Api({ fetch: fetchFn, now: () => 0 });

    await expectCode(async () => api.countries(), "invalid-response");
    expect(pulled).toBeGreaterThanOrEqual(16 * MIB);
  });
});
