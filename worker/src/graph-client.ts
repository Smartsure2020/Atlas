/**
 * Atlas Phase 5A — Microsoft Graph client (read-only, Worker-native)
 * ----------------------------------------------------------------------------
 * Standards-based fetch(). No @azure/msal-node, no @microsoft/microsoft-graph-
 * client dependency. Only Mail.Read application permission is expected — this
 * module never sends and never modifies mailbox state.
 *
 * Everything mutable is threaded through the `deps` argument so tests can
 * substitute an in-memory HTTP without going near the network.
 *
 * Security posture (Checkpoint 2 hardening)
 * -----------------------------------------
 *   * Every dynamic URL that carries the Graph bearer token is validated by
 *     `assertAllowedGraphUrl()` before fetch. Anything not on
 *     https://graph.microsoft.com is refused with a classified GraphError and
 *     the injected fetch is NEVER called.
 *   * Token-bearing requests use `redirect: "manual"` and reject non-2xx.
 *     A 3xx would otherwise permit Graph to bounce the token to a different
 *     origin.
 *   * Message-Id canonicalisation is exported so the orchestrator applies the
 *     same normalisation to internetMessageId, In-Reply-To, and References.
 */

import type { Env } from "./config.js";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_TOKEN_URL_FN = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

// Initial delta query. `$select` narrows the projection to the fields Phase 5A
// actually needs — attachment payloads are deliberately excluded.
const GRAPH_INITIAL_DELTA_URL_FN = (mailbox: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}` +
  `/mailFolders/Inbox/messages/delta` +
  `?$select=id,internetMessageId,conversationId,subject,bodyPreview,from,` +
  `toRecipients,ccRecipients,receivedDateTime,hasAttachments`;

const GRAPH_HEADERS_URL_FN = (mailbox: string, messageId: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}` +
  `?$select=internetMessageHeaders`;

// Phase 5B — metadata listing only. $select excludes `contentBytes` so this
// call is bounded, and `@odata.type` is included in the response envelope
// without needing to be listed here.
const GRAPH_ATTACHMENT_LIST_URL_FN = (mailbox: string, messageId: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments` +
  `?$select=id,name,contentType,size,isInline,contentId`;

// Phase 5B — raw byte fetch. /$value returns unstructured octet-stream.
const GRAPH_ATTACHMENT_VALUE_URL_FN = (
  mailbox: string,
  messageId: string,
  attachmentId: string,
) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}` +
  `/messages/${encodeURIComponent(messageId)}` +
  `/attachments/${encodeURIComponent(attachmentId)}/$value`;

/** Injection surface for tests. Kept minimal on purpose. */
export interface GraphClientDeps {
  /**
   * The transport. Defaults to the runtime's global fetch. Tests inject a
   * function that returns crafted Response objects.
   */
  fetchImpl?: typeof fetch;
  /** Provides Date.now() so token cache eviction can be tested. */
  now?: () => number;
}

export interface GraphAccessToken {
  token: string;
  expiresAt: number;
}

export interface GraphMessage {
  /** Microsoft Graph mailbox-scoped id. */
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: { emailAddress?: { name?: string | null; address?: string | null } | null } | null;
  toRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } | null }> | null;
  ccRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } | null }> | null;
  receivedDateTime?: string | null;
  hasAttachments?: boolean | null;
  /** Present on delete/move events — never treated as a new submission. */
  removed?: unknown;
  ["@removed"]?: unknown;
}

export interface GraphDeltaBatch {
  messages: GraphMessage[];
  /** Present when there are more pages to fetch. */
  nextLink: string | null;
  /** Present only after the final page. Persist verbatim. */
  deltaLink: string | null;
}

export class GraphError extends Error {
  status: number;
  code: string;
  retryAfterSeconds: number | null;
  /**
   * True when Microsoft Graph indicates the delta cursor is no longer valid
   * (410 Gone with syncStateNotFound). The caller must restart from the
   * initial delta URL for that mailbox.
   */
  deltaTokenExpired: boolean;
  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryAfterSeconds?: number | null;
    deltaTokenExpired?: boolean;
  }) {
    super(input.message);
    this.name = "GraphError";
    this.status = input.status;
    this.code = input.code;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.deltaTokenExpired = Boolean(input.deltaTokenExpired);
  }
}

// ---------------------------------------------------------------------------
// URL origin allowlist (checkpoint 2 blocker #5)
// ---------------------------------------------------------------------------

/**
 * Refuse any URL that would forward the Graph bearer token to a non-Graph
 * origin. Cases explicitly rejected:
 *   * anything but https:
 *   * hostname != graph.microsoft.com  (subdomains excluded — Microsoft
 *     never bounces delta URLs to a subdomain of graph.microsoft.com)
 *   * URL userinfo tricks (https://graph.microsoft.com@evil.example)
 *   * look-alike domains (graph.microsoft.com.evil.example)
 *
 * This function throws a classified GraphError. The caller's fetch is never
 * invoked when validation fails — see `fetchWithAllowlist` below.
 */
export function assertAllowedGraphUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GraphError({
      status: 0,
      code: "graph_url_invalid",
      message: "graph_url_invalid",
    });
  }
  // Userinfo is rejected explicitly. URL.origin already excludes userinfo, but
  // a rejection with the specific classifier is more useful to the caller than
  // a generic origin mismatch.
  if (parsed.username || parsed.password) {
    throw new GraphError({ status: 0, code: "graph_url_userinfo_disallowed", message: "graph_url_userinfo_disallowed" });
  }
  // Exact origin comparison. This is stricter than hostname/protocol split
  // because it rejects non-default ports (e.g. https://graph.microsoft.com:444),
  // wrong schemes (http://…), userinfo (already handled above but re-guarded),
  // and every look-alike hostname in one predicate. Allowed: only the exact
  // origin https://graph.microsoft.com (implicit :443).
  if (parsed.origin !== GRAPH_ORIGIN) {
    throw new GraphError({ status: 0, code: "graph_url_origin_disallowed", message: "graph_url_origin_disallowed" });
  }
}

async function fetchWithAllowlist(
  url: string,
  init: RequestInit,
  deps: GraphClientDeps,
): Promise<Response> {
  assertAllowedGraphUrl(url);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { ...init, redirect: "manual" });
  // A 3xx would take us off-origin with the bearer token still attached.
  // With redirect:"manual" the runtime returns the redirect itself; treat it
  // as a hard error rather than following.
  if (res.status >= 300 && res.status < 400) {
    throw new GraphError({
      status: res.status,
      code: "graph_unexpected_redirect",
      message: "graph_unexpected_redirect",
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Canonical message-id (checkpoint 2 blocker #6)
// ---------------------------------------------------------------------------

/**
 * Canonical form used everywhere Atlas compares an RFC 5322 Message-Id:
 *   * strip surrounding whitespace
 *   * if wrapped in angle brackets, return the inner value
 *   * empty / whitespace-only input becomes null
 *
 * Case is preserved: msg-id local-part is case-sensitive per RFC 5322 §3.6.4.
 * (Domain part is case-insensitive but we do not lowercase blindly because
 * that would misalign with senders that echo mixed case back verbatim; the
 * comparison space stays the value Graph and the header emitted.)
 */
export function canonicalMessageId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/<([^<>]+)>/);
  const inner = m ? m[1].trim() : trimmed;
  return inner.length > 0 ? inner : null;
}

function classifyGraphErrorCode(status: number): string {
  if (status === 401) return "graph_unauthorized";
  if (status === 403) return "graph_forbidden";
  if (status === 404) return "graph_not_found";
  if (status === 410) return "graph_delta_expired";
  if (status === 429) return "graph_throttled";
  if (status >= 500) return "graph_server_error";
  return "graph_error";
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return null;
}

async function graphErrorFromResponse(res: Response): Promise<GraphError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* body may not be JSON — safe to ignore */
  }
  const errorObj = (body as { error?: { code?: string; message?: string } } | null)?.error ?? null;
  const providerCode = errorObj?.code ?? "";
  const deltaTokenExpired = res.status === 410 ||
    providerCode === "syncStateNotFound" ||
    providerCode === "syncStateInvalid";
  return new GraphError({
    status: res.status,
    code: classifyGraphErrorCode(res.status),
    // Never surface Graph's message text upstream: it can contain mailbox
    // addresses and internal identifiers. Callers get the classified code and
    // a bland shape.
    message: `graph_status_${res.status}`,
    retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
    deltaTokenExpired,
  });
}

/**
 * Acquire a client-credentials access token for the Microsoft Graph API.
 *
 * Callers pass a token holder they can reuse across multiple mailbox polls in
 * a single scheduled tick — the module does not maintain any hidden state.
 */
export async function acquireGraphToken(
  env: Env,
  deps: GraphClientDeps = {},
): Promise<GraphAccessToken> {
  const tenant = env.ATLAS_GRAPH_TENANT_ID;
  const clientId = env.ATLAS_GRAPH_CLIENT_ID;
  const clientSecret = env.ATLAS_GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new GraphError({
      status: 0,
      code: "graph_config_missing",
      message: "graph_config_missing",
    });
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The token endpoint is a well-known static Microsoft URL. redirect:"manual"
  // matches the delta path: any 3xx here is a misconfiguration, not a normal
  // OAuth response.
  //
  // Any raw transport exception (fetch network failure, TypeError from the
  // runtime, etc.) is normalised to a classified GraphError so downstream
  // failJob/atlas_jobs.retry state never receives arbitrary runtime text
  // that could leak the token endpoint URL, tenant id, client id, or the
  // client secret embedded in the request body.
  let res: Response;
  try {
    res = await fetchImpl(GRAPH_TOKEN_URL_FN(tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
  } catch (err) {
    if (err instanceof GraphError) throw err;
    throw new GraphError({
      status: 0,
      code: "graph_token_failed",
      message: "graph_token_failed",
    });
  }
  if (res.status >= 300 && res.status < 400) {
    throw new GraphError({ status: res.status, code: "graph_unexpected_redirect", message: "graph_unexpected_redirect" });
  }
  if (!res.ok) throw await graphErrorFromResponse(res);
  const payload = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!payload || !payload.access_token) {
    throw new GraphError({
      status: 500,
      code: "graph_token_malformed",
      message: "graph_token_malformed",
    });
  }
  const now = (deps.now ?? Date.now)();
  // Refresh 60 s before real expiry.
  const expiresIn = Math.max(60, Number(payload.expires_in ?? 3600));
  return { token: payload.access_token, expiresAt: now + (expiresIn - 60) * 1000 };
}

/** Compose the initial delta URL for a mailbox (see spec sec. 12). */
export function initialDeltaUrl(mailbox: string): string {
  return GRAPH_INITIAL_DELTA_URL_FN(mailbox);
}

/**
 * Fetch a single Graph delta page (or the next link of a paginated set).
 * Callers loop until nextLink is null, at which point deltaLink is populated
 * and must be persisted atomically with the ingest work.
 */
export async function fetchDeltaPage(
  url: string,
  token: GraphAccessToken,
  deps: GraphClientDeps = {},
): Promise<GraphDeltaBatch> {
  const res = await fetchWithAllowlist(
    url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token.token}`, Accept: "application/json" },
    },
    deps,
  );
  if (!res.ok) throw await graphErrorFromResponse(res);
  const payload = (await res.json()) as {
    value?: GraphMessage[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };
  const nextLink = typeof payload["@odata.nextLink"] === "string" ? payload["@odata.nextLink"] : null;
  const deltaLink = typeof payload["@odata.deltaLink"] === "string" ? payload["@odata.deltaLink"] : null;
  // Server-returned continuation URLs are also validated so a poisoned Graph
  // response cannot redirect the next iteration off-origin.
  if (nextLink) assertAllowedGraphUrl(nextLink);
  if (deltaLink) assertAllowedGraphUrl(deltaLink);
  return {
    messages: Array.isArray(payload.value) ? payload.value : [],
    nextLink,
    deltaLink,
  };
}

/**
 * Fetch In-Reply-To / References headers for a single message. Microsoft Graph
 * does not expose these on the default projection, so reply correlation
 * requires this narrow extra request only when the caller has decided that
 * the reply-header rule will actually be attempted.
 */
export async function fetchInternetMessageHeaders(
  mailbox: string,
  messageId: string,
  token: GraphAccessToken,
  deps: GraphClientDeps = {},
): Promise<{ inReplyTo: string | null; references: string[] }> {
  const res = await fetchWithAllowlist(
    GRAPH_HEADERS_URL_FN(mailbox, messageId),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token.token}`, Accept: "application/json" },
    },
    deps,
  );
  if (!res.ok) throw await graphErrorFromResponse(res);
  const payload = (await res.json()) as {
    internetMessageHeaders?: Array<{ name?: string; value?: string }>;
  };
  const rows = Array.isArray(payload.internetMessageHeaders)
    ? payload.internetMessageHeaders
    : [];
  const rawInReplyTo = rows.find((h) => h.name?.toLowerCase() === "in-reply-to")?.value ?? null;
  const rawReferences = rows.find((h) => h.name?.toLowerCase() === "references")?.value ?? "";
  return {
    inReplyTo: canonicalMessageId(rawInReplyTo),
    references: parseMessageIdList(rawReferences),
  };
}

/**
 * Detect a `@removed` (delete / move) event on a delta entry. Never ingest a
 * removed event as a new submission or update.
 */
export function isRemovedEvent(message: GraphMessage): boolean {
  return message?.removed != null || message?.["@removed"] != null;
}

function parseMessageIdList(raw: string): string[] {
  if (!raw) return [];
  const matches = raw.match(/<([^<>]+)>/g);
  if (!matches) return [];
  const out: string[] = [];
  for (const m of matches) {
    const canon = canonicalMessageId(m);
    if (canon) out.push(canon);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 5B — attachment metadata + raw-byte fetches
// ---------------------------------------------------------------------------

/**
 * One attachment metadata entry as returned by Graph's list endpoint.
 * `attachmentType` is derived from `@odata.type` and normalised to the three
 * supported forms plus `unknown` for anything else. Bytes are NEVER present
 * here — the metadata list uses `$select` that excludes `contentBytes`.
 */
export interface GraphAttachmentMetadata {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number | null;
  isInline: boolean;
  contentId: string | null;
  attachmentType: "fileAttachment" | "itemAttachment" | "referenceAttachment" | "unknown";
}

const ATTACHMENT_TYPE_MAP: Record<string, GraphAttachmentMetadata["attachmentType"]> = {
  "#microsoft.graph.fileAttachment": "fileAttachment",
  "#microsoft.graph.itemAttachment": "itemAttachment",
  "#microsoft.graph.referenceAttachment": "referenceAttachment",
};

function normaliseAttachmentType(raw: unknown): GraphAttachmentMetadata["attachmentType"] {
  if (typeof raw !== "string") return "unknown";
  return ATTACHMENT_TYPE_MAP[raw] ?? "unknown";
}

/**
 * Bounded page limits for attachment metadata listing. Conservative safety
 * bounds: a single message with more than a few dozen attachments already
 * exceeds normal Atlas underwriting; > 500 or > 20 pages is treated as a
 * pathological input that must fail closed rather than be silently
 * truncated.
 */
export const ATTACHMENT_LIST_MAX_PAGES = 20;
export const ATTACHMENT_LIST_MAX_ROWS  = 500;

/**
 * List attachment metadata for one message. Follows @odata.nextLink through
 * a bounded number of pages. Every nextLink is re-validated through the
 * exact-origin allowlist (so a poisoned Graph response cannot redirect the
 * bearer token off-domain). Bytes are NEVER fetched here.
 *
 * Fails closed on:
 *   * any non-2xx from Graph (rethrown with retryable/non-retryable
 *     classification from graphErrorFromResponse);
 *   * malformed payload;
 *   * more than ATTACHMENT_LIST_MAX_PAGES pages or ATTACHMENT_LIST_MAX_ROWS
 *     accumulated rows (throws graph_attachment_page_limit — non-retryable
 *     so the queue does not spin on the same pathological message);
 *   * a mid-list transport failure — the entire list fails atomically; the
 *     caller must NOT commit a partial enumeration.
 */
export async function listMessageAttachments(
  mailbox: string,
  messageId: string,
  token: GraphAccessToken,
  deps: GraphClientDeps = {},
): Promise<GraphAttachmentMetadata[]> {
  const out: GraphAttachmentMetadata[] = [];
  let url: string | null = GRAPH_ATTACHMENT_LIST_URL_FN(mailbox, messageId);
  let pageCount = 0;
  while (url) {
    if (pageCount >= ATTACHMENT_LIST_MAX_PAGES) {
      throw new GraphError({
        status: 0,
        code: "graph_attachment_page_limit",
        message: "graph_attachment_page_limit",
      });
    }
    // Every URL that carries the bearer token passes the exact-origin
    // allowlist — including server-returned nextLinks.
    const res = await fetchWithAllowlist(
      url,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token.token}`, Accept: "application/json" },
      },
      deps,
    );
    if (!res.ok) throw await graphErrorFromResponse(res);
    const payload = (await res.json().catch(() => null)) as {
      value?: Array<{
        id?: string;
        name?: string | null;
        contentType?: string | null;
        size?: number | null;
        isInline?: boolean | null;
        contentId?: string | null;
        "@odata.type"?: string;
      }>;
      "@odata.nextLink"?: string;
    } | null;
    if (!payload || !Array.isArray(payload.value)) {
      throw new GraphError({
        status: 0,
        code: "graph_attachment_list_malformed",
        message: "graph_attachment_list_malformed",
      });
    }
    for (const row of payload.value) {
      if (!row || typeof row.id !== "string" || row.id.length === 0) {
        throw new GraphError({
          status: 0,
          code: "graph_attachment_list_malformed",
          message: "graph_attachment_list_malformed",
        });
      }
      out.push({
        id: row.id,
        name: typeof row.name === "string" ? row.name : null,
        contentType: typeof row.contentType === "string" ? row.contentType : null,
        size: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : null,
        isInline: row.isInline === true,
        contentId: typeof row.contentId === "string" ? row.contentId : null,
        attachmentType: normaliseAttachmentType(row["@odata.type"]),
      });
      if (out.length > ATTACHMENT_LIST_MAX_ROWS) {
        throw new GraphError({
          status: 0,
          code: "graph_attachment_page_limit",
          message: "graph_attachment_page_limit",
        });
      }
    }
    pageCount += 1;
    const nextLink = typeof payload["@odata.nextLink"] === "string" ? payload["@odata.nextLink"] : null;
    if (!nextLink) {
      url = null;
    } else {
      // Validate BEFORE assigning: if the origin is off-Graph we throw
      // rather than issue a token-bearing request. assertAllowedGraphUrl
      // raises a classified GraphError; the whole listing then fails
      // atomically (no partial discovery commit).
      assertAllowedGraphUrl(nextLink);
      url = nextLink;
    }
  }
  return out;
}

/**
 * Fetch raw attachment bytes via `/attachments/{id}/$value`.
 *
 * If `maxBytes` is provided AND a valid Content-Length response header
 * exceeds it, the request is failed with `size_mismatch` BEFORE the body
 * is consumed — a malformed upstream response cannot force an unbounded
 * allocation. The caller must still re-validate the actual byte length
 * after reading, because Content-Length is advisory.
 *
 * Never used for `referenceAttachment` (would point off-Microsoft) and
 * never for `itemAttachment` (embedded item, not a byte payload).
 */
export async function fetchAttachmentBytes(
  mailbox: string,
  messageId: string,
  attachmentId: string,
  token: GraphAccessToken,
  deps: GraphClientDeps = {},
  maxBytes?: number,
): Promise<ArrayBuffer> {
  const res = await fetchWithAllowlist(
    GRAPH_ATTACHMENT_VALUE_URL_FN(mailbox, messageId, attachmentId),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/octet-stream",
      },
    },
    deps,
  );
  if (!res.ok) throw await graphErrorFromResponse(res);
  if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
    const rawLen = res.headers.get("Content-Length");
    if (rawLen) {
      const n = Number(rawLen);
      if (Number.isFinite(n) && n > maxBytes) {
        // Refuse the body up-front rather than allocating for a response
        // that will be rejected downstream anyway.
        throw new GraphError({
          status: res.status,
          code: "size_mismatch",
          message: "size_mismatch",
        });
      }
    }
  }
  return await res.arrayBuffer();
}

// Referenced for stable module-graph presence in checked builds; harmless.
export const GRAPH_ORIGIN_FOR_TESTS: string = GRAPH_ORIGIN;
