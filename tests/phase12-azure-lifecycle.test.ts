/**
 * Phase 12 (pre-pilot hardening) — Azure Document Intelligence lifecycle tests
 * ---------------------------------------------------------------------------
 * Fully mocked. Exercises the async submit -> poll -> succeed / fail / cancel
 * lifecycle plus every documented failure mode. No live provider calls.
 */

import { AzureDocumentIntelligenceParser, redactAzureError, type AzureConfig } from "../worker/src/parser-azure.js";


const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`); }

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  jsonThrows?: boolean;
  networkError?: string;
}

function makeFetch(sequence: (url: string) => MockResponse | Promise<MockResponse>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = await sequence(url);
    if (r.networkError) throw new Error(r.networkError);
    const headers = new Headers(r.headers ?? {});
    const bodyText = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    const response = new Response(bodyText, { status: r.status, headers });
    if (r.jsonThrows) {
      // Override .json to throw so we can test malformed body handling
      (response as unknown as { json: () => Promise<unknown> }).json = async () => { throw new Error("bad json"); };
    }
    return response;
  }) as typeof fetch;
}

const OP_LOC = "https://example.cognitiveservices.azure.com/documentintelligence/analyzeResults/xyz";

function mkParser(fetchImpl: typeof fetch, extras: Partial<AzureConfig> = {}) {
  return new AzureDocumentIntelligenceParser({
    endpoint: "https://example.cognitiveservices.azure.com",
    apiKey: "test-key",
    fetchImpl,
    pollIntervalMs: 5,
    timeoutMs: 1000,
    ...extras,
  });
}

function mkInput() {
  return {
    documentId: "d1", fileName: "test.pdf", mimeType: null,
    bytes: new ArrayBuffer(16), documentType: null,
  };
}

// ---------------------------------------------------------------------------
// Happy path: submit -> running -> running -> succeeded
// ---------------------------------------------------------------------------

test("submit -> running -> running -> succeeded returns normalised result", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) {
      return { status: 202, headers: { "Operation-Location": OP_LOC } };
    }
    if (calls === 2 || calls === 3) {
      return { status: 200, body: { status: "running" } };
    }
    return {
      status: 200,
      body: {
        status: "succeeded",
        analyzeResult: {
          apiVersion: "2024-11-30",
          modelId: "prebuilt-layout",
          pages: [
            { pageNumber: 1, lines: [{ content: "Hello Atlas" }, { content: "Second line" }] },
          ],
          tables: [],
          keyValuePairs: [],
        },
      },
    };
  });

  const parser = mkParser(fetchImpl);
  const result = await parser.parse(mkInput());
  eq(result.pageCount, 1, "one page");
  eq(result.pages[0].text.includes("Hello Atlas"), true, "text present");
  eq(result.pages[0].charCount > 0, true, "char count > 0");
  eq(calls >= 4, true, `polled at least 4 times (was ${calls})`);
});

// ---------------------------------------------------------------------------
// Immediate 200 success (some Azure operations return synchronously)
// ---------------------------------------------------------------------------

test("immediate 200 success is honoured without polling", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    return {
      status: 200,
      body: {
        status: "succeeded",
        analyzeResult: {
          pages: [{ pageNumber: 1, lines: [{ content: "immediate" }] }],
          tables: [], keyValuePairs: [],
        },
      },
    };
  });
  const parser = mkParser(fetchImpl);
  const result = await parser.parse(mkInput());
  eq(calls, 1, "only submit was called");
  eq(result.pages[0].text, "immediate", "text");
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test("missing Operation-Location header is a clear error", async () => {
  const fetchImpl = makeFetch(() => ({ status: 202 })); // no header
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/no_operation_location/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("analysis reports failed status", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 200, body: { status: "failed", error: { code: "InvalidRequest", message: "bad" } } };
  });
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/InvalidRequest/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("analysis reports canceled status", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 200, body: { status: "canceled" } };
  });
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/canceled/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("401 on submit surfaces auth failure", async () => {
  const fetchImpl = makeFetch(() => ({ status: 401 }));
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/azure_auth_failed/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("403 on submit surfaces auth failure", async () => {
  const fetchImpl = makeFetch(() => ({ status: 403 }));
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/azure_auth_failed/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("429 on submit surfaces rate limit", async () => {
  const fetchImpl = makeFetch(() => ({ status: 429 }));
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/rate_limited/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("500 on submit surfaces generic submit failure", async () => {
  const fetchImpl = makeFetch(() => ({ status: 500 }));
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/submit_failed/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("429 on poll surfaces rate limit", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 429 };
  });
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/rate_limited/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("malformed poll body throws azure_malformed_response", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 200, body: "not json", jsonThrows: true };
  });
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/malformed_response/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("polling times out when status stays running", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 200, body: { status: "running" } };
  });
  try {
    await mkParser(fetchImpl, { timeoutMs: 30, pollIntervalMs: 10 }).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/timeout/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("cancellation during polling is honoured", async () => {
  let calls = 0;
  let cancelAfter = 2;
  let cancelled = false;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 200, body: { status: "running" } };
  });
  try {
    await mkParser(fetchImpl, {
      timeoutMs: 5000, pollIntervalMs: 5,
      isCancelled: () => { if (--cancelAfter <= 0) cancelled = true; return cancelled; },
    }).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/cancelled/.test((e as Error).message), `msg: ${(e as Error).message}`);
    assert(cancelled, "cancellation predicate was consulted");
  }
});

test("network failure on submit surfaces azure_network_failure", async () => {
  const fetchImpl = makeFetch(() => ({ status: 0, networkError: "ECONNRESET" }));
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/network_failure/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

test("network failure on poll surfaces azure_poll_network_failure", async () => {
  let calls = 0;
  const fetchImpl = makeFetch(() => {
    calls++;
    if (calls === 1) return { status: 202, headers: { "Operation-Location": OP_LOC } };
    return { status: 0, networkError: "socket hang up" };
  });
  try {
    await mkParser(fetchImpl).parse(mkInput());
    throw new Error("should have thrown");
  } catch (e) {
    assert(/poll_network_failure/.test((e as Error).message), `msg: ${(e as Error).message}`);
  }
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redactAzureError never leaks provider prose", () => {
  const out = redactAzureError({ code: "TooManyRequests", status: 429, message: "Please slow down. Detailed provider trace: xyz@abc.com internal_id_1234" });
  assert(out.length <= 120, "length capped");
  assert(!out.includes("xyz@abc.com"), "email not leaked");
  assert(!out.includes("internal_id_1234"), "provider id not leaked");
  assert(out.startsWith("TooManyRequests"), "starts with code");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPhase 12 azure lifecycle: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
