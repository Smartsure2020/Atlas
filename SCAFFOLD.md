# Atlas Blueprint — scaffold (Phase 0)

The secure, authenticated shell. Everything intelligent (extraction, matching,
recommendations, decisions, email drafts) comes in later phases and bolts onto
this without changing its shape.

## Shape

```
atlas/
  supabase/migrations/   # the Phase 0 schema (already reviewed)
  worker/                # Cloudflare Worker — the ONLY privileged path
    src/config.ts        #   env types, allow-list role resolution, retention
    src/auth.ts          #   authorise() staff gate + structural audit() writer
    src/oauth.ts         #   Microsoft sign-in callback -> allow-list -> role
    src/index.ts         #   router + first endpoints (create submission, sign upload)
  src/                   # Vite/React frontend — holds only a user session
    lib/atlas.ts         #   supabase client + authenticated Worker API helper
    components/GovernanceDisclaimer.tsx
    App.tsx              #   auth gate + dashboard shell (6 status columns)
    atlas.css            #   design system
```

## Security model (how the pieces enforce the rules)

**One privileged path.** The browser never holds the service-role key or the
Anthropic key, never talks to Claude, never computes a recommendation. It holds
a Supabase user session and calls the Worker. The Worker does everything
sensitive. Because of that, audit logging is structural — it happens on the only
path that exists.

**Authentication reuses Scout's Azure app.** Same tenant, same Microsoft
accounts, same login. Atlas only needed its redirect URI added to that
registration. No new Azure setup, no group-claim configuration.

**Authorisation is an allow-list the Worker controls.** On sign-in the Worker
resolves the user's email against `ATLAS_ALLOWLIST_JSON` to `underwriter` /
`admin` / denied, and writes the role into Supabase `app_metadata.atlas_role`.
That is the exact claim the database RLS trusts. Adding an underwriter is an env
edit, not an Azure/IT change. **It fails closed**: a malformed list, an unknown
email, or an auth failure all result in no access and nothing provisioned.

**Defence in depth.** The Worker re-checks staff status on every `/api/*` call
(`authorise()`), and the database independently enforces the same rule via RLS.
A bug in one layer doesn't open the other.

## What Phase 0 delivers

A signed-out user gets a Microsoft sign-in screen. An authenticated user who
isn't on the allow-list gets a clear, fail-closed "not authorised" screen. A
staff user gets the dashboard with the six status columns (empty for now) and
can — via the Worker — create a submission and request a signed upload URL into
the **private** client-docs bucket, with both actions audit-logged. Documents
are pre-registered with a configurable retention window. The governance
disclaimer component exists and is ready to render on every recommendation.

No extraction, matching, recommendations, decisions, or email drafts yet — those
are the next phases.

## Setup

**Worker secrets** (`wrangler secret put <NAME>`): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI`,
`ANTHROPIC_API_KEY`, `ATLAS_ALLOWLIST_JSON`. Retention days is a non-secret var
in `wrangler.toml` (default 7).

**Frontend env** (`.env`, see `.env.example`): `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_ATLAS_API_URL`. Nothing sensitive.

**Supabase one-time setup:** apply the migrations in `supabase/migrations`, and
create a **private** Storage bucket named `atlas-client-docs` (for transient
client documents) plus one for insurer guideline docs. Neither is public.

**Azure one-time setup:** add Atlas's callback URL (`AZURE_REDIRECT_URI`) to the
existing Scout app registration's allowed redirect URIs. Nothing else.

## Run

```
# Worker
cd worker && npm install && npm run dev

# Frontend (separate terminal)
npm install && npm run dev
```

## Allow-list example

```json
{ "jane@firm.co.za": "admin", "sam@firm.co.za": "underwriter" }
```

## Notes carried forward

* The OAuth callback's Microsoft token exchange and Supabase session mint are
  written as clear seams in `oauth.ts`; the security-critical logic (allow-list,
  fail-closed, role stamping, audit) is real. Wiring JWKS signature verification
  and the exact session-establishment call is the first hardening task when this
  goes live.
* Removing someone from the allow-list takes effect on their next login/token
  refresh. For immediate revocation, disable the Microsoft account.
* The document-expiry cron is stubbed in `wrangler.toml` and gets built in the
  retention phase.
```
