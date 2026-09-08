/**
 * Phase 19 (Phase 5A) — Graph client HTTP behaviour with mocked fetch
 * ---------------------------------------------------------------------------
 * Exercises token acquisition, delta pagination, deltaLink extraction,
 * @removed handling and every Graph error class. No real network traffic.
 */

import {
  acquireGraphToken,
  fetchDeltaPage,
  fetchInternetMessageHeaders,
  GraphError,
  initialDeltaUrl,
  isRemovedEvent,
  type GraphClientDeps,
} from "../worker/src/graph-client.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const FAKE_ENV = {
  ATLAS_GRAPH_TENANT_ID: "tenant-x",
  ATLAS_GRAPH_CLIENT_ID: "client-x",
  ATLAS_GRAPH_CLIENT_SECRET: "secret-x",
} as unknown as Parameters<typeof acquireGraphToken>[0];

type FetchImpl = NonNullable<GraphClientDeps["fetchImpl"]>;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchImpl {
  return async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Token acquisition
// ---------------------------------------------------------------------------

test("token: successful acquisition returns access_token + expiresAt", async () => {
  const fetchImpl = mockFetch((url, init) => {
    assert(url.includes("/tenant-x/oauth2/v2.0/token"), "token URL includes tenant");
    const body = String((init as { body?: unknown }).body ?? "");
    assert(body.includes("grant_type=client_credentials"), "grant_type");
    assert(body.includes("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default"), "scope");
    assert(body.includes("client_secret=secret-x"), "secret in body");
    return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
  });
  const now = () => 1_000_000;
  const tok = await acquireGraphToken(FAKE_ENV, { fetchImpl, now });
  eq(tok.token, "tok", "token");
  assert(tok.expiresAt > 1_000_000, "expiresAt in future");
  assert(tok.expiresAt <= 1_000_000 + 3600 * 1000, "expiresAt not past +expires_in");
});

test("token: missing config throws graph_config_missing", async () => {
  let threw = false;
  try {
    await acquireGraphToken({} as never, {});
  } catch (err) {
    threw = true;
    assert(err instanceof GraphError, "GraphError");
    if (err instanceof GraphError) eq(err.code, "graph_config_missing", "code");
  }
  assert(threw, "threw");
});

test("token: 401 => graph_unauthorized", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(401, { error: { code: "invalid_client" } }));
  let threw = false;
  try {
    await acquireGraphToken(FAKE_ENV, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) {
      eq(err.status, 401, "status");
      eq(err.code, "graph_unauthorized", "code");
    }
  }
  assert(threw, "threw");
});

test("token: malformed body throws graph_token_malformed", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, { expires_in: 60 }));
  let threw = false;
  try {
    await acquireGraphToken(FAKE_ENV, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) eq(err.code, "graph_token_malformed", "code");
  }
  assert(threw, "threw");
});

// ---------------------------------------------------------------------------
// Delta pagination
// ---------------------------------------------------------------------------

test("delta: initial URL is correctly encoded", () => {
  const url = initialDeltaUrl("intake@example.com");
  assert(url.includes("/users/intake%40example.com/mailFolders/Inbox/messages/delta"), "encoded mailbox");
  assert(url.includes("$select="), "$select present");
  assert(url.includes("internetMessageId"), "includes internetMessageId");
});

test("delta: parses value / nextLink / deltaLink", async () => {
  const fetchImpl = mockFetch((url, init) => {
    assert((init?.headers as Record<string, string>).Authorization === "Bearer TOK", "authorization header");
    if (url.endsWith("first")) {
      return jsonResponse(200, {
        value: [{ id: "m-1", internetMessageId: "im-1" }],
        "@odata.nextLink": "https://graph.microsoft.com/second",
      });
    }
    return jsonResponse(200, {
      value: [{ id: "m-2", internetMessageId: "im-2" }],
      "@odata.deltaLink": "https://graph.microsoft.com/delta-final",
    });
  });
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  const first = await fetchDeltaPage("https://graph.microsoft.com/first", token, { fetchImpl });
  eq(first.messages.length, 1, "first messages");
  eq(first.nextLink, "https://graph.microsoft.com/second", "nextLink");
  eq(first.deltaLink, null, "no delta yet");
  const second = await fetchDeltaPage(first.nextLink!, token, { fetchImpl });
  eq(second.messages.length, 1, "second messages");
  eq(second.nextLink, null, "no more pages");
  eq(second.deltaLink, "https://graph.microsoft.com/delta-final", "deltaLink");
});

test("delta: @removed entries are detected", () => {
  const m = { id: "m", removed: { reason: "changed" } } as never;
  eq(isRemovedEvent(m), true, "removed");
  const withOdata = { id: "m", "@removed": { reason: "deleted" } } as never;
  eq(isRemovedEvent(withOdata), true, "@removed");
  const normal = { id: "m" } as never;
  eq(isRemovedEvent(normal), false, "no removed marker");
});

test("delta: 401 => graph_unauthorized", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(401, {}));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) eq(err.code, "graph_unauthorized", "code");
  }
  assert(threw, "threw");
});

test("delta: 403 => graph_forbidden", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(403, {}));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) eq(err.code, "graph_forbidden", "code");
  }
  assert(threw, "threw");
});

test("delta: 404 => graph_not_found (missing mailbox)", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(404, {}));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) eq(err.code, "graph_not_found", "code");
  }
  assert(threw, "threw");
});

test("delta: 429 => graph_throttled with Retry-After", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(429, {}, { "Retry-After": "17" }));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) {
      eq(err.code, "graph_throttled", "code");
      eq(err.retryAfterSeconds, 17, "retry-after");
    }
  }
  assert(threw, "threw");
});

test("delta: 5xx => graph_server_error", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(503, {}));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) eq(err.code, "graph_server_error", "code");
  }
  assert(threw, "threw");
});

test("delta: 410 => graph_delta_expired flag set", async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse(410, { error: { code: "syncStateNotFound", message: "resync" } }),
  );
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    if (err instanceof GraphError) {
      eq(err.code, "graph_delta_expired", "code");
      eq(err.deltaTokenExpired, true, "expired flag");
    }
  }
  assert(threw, "threw");
});

test("delta: network failure surfaces as thrown Error (transport-level)", async () => {
  const fetchImpl: FetchImpl = async () => {
    throw new TypeError("network");
  };
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  let threw = false;
  try {
    await fetchDeltaPage("https://graph.microsoft.com/x", token, { fetchImpl });
  } catch (err) {
    threw = true;
    assert(err instanceof Error, "Error");
  }
  assert(threw, "threw");
});

// ---------------------------------------------------------------------------
// Internet message headers
// ---------------------------------------------------------------------------

test("headers: parses In-Reply-To + References with angle-bracket cleanup", async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse(200, {
      internetMessageHeaders: [
        { name: "In-Reply-To", value: "<parent-1@atlas>" },
        { name: "References", value: "<r1@a> <r2@b>" },
      ],
    }),
  );
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  const out = await fetchInternetMessageHeaders("mbx", "m-1", token, { fetchImpl });
  eq(out.inReplyTo, "parent-1@atlas", "inReplyTo cleaned");
  eq(out.references.length, 2, "two refs");
  eq(out.references[0], "r1@a", "ref 0");
  eq(out.references[1], "r2@b", "ref 1");
});

test("headers: absent headers yield null + empty", async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, {}));
  const token = { token: "TOK", expiresAt: Date.now() + 60_000 };
  const out = await fetchInternetMessageHeaders("mbx", "m-2", token, { fetchImpl });
  eq(out.inReplyTo, null, "inReplyTo null");
  eq(out.references.length, 0, "no refs");
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
  console.log(`\nPhase 19 graph: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
