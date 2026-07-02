/**
 * Atlas Blueprint — app shell + auth gate + dashboard
 * ----------------------------------------------------------------------------
 * Phase 0 deliverable: a secure, authenticated shell. Three states:
 *   1. Signed out          -> Microsoft sign-in (shared Azure app).
 *   2. Signed in, no role  -> access denied (fail closed; allow-list said no).
 *   3. Signed in + staff   -> the dashboard with its six status columns.
 *
 * The dashboard renders the columns the team described; it's empty until the
 * submission features land in the next phases. The point of Phase 0 is that the
 * shell, auth, role gate, and API plumbing are all real and locked down.
 */

import { useEffect, useState } from "react";
import { supabase, currentRole, startLogin, listSubmissions, type SubmissionListItem } from "./lib/atlas";
import NewSubmission from "./pages/NewSubmission";
import SubmissionDetail from "./pages/SubmissionDetail";
import Insurers from "./pages/Insurers";
import InsurerDetail from "./pages/InsurerDetail";
import ManagerDashboard from "./pages/ManagerDashboard";
import "./atlas.css";

type AtlasUiRole = "underwriter" | "consultant" | "manager" | "admin" | "readonly";
const canManage = (role: AtlasUiRole) => role === "admin" || role === "manager";
const canWrite = (role: AtlasUiRole) => role !== "readonly";

type AuthState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "denied"; email: string | null }
  | { kind: "staff"; email: string | null; role: AtlasUiRole };

type View =
  | { name: "dashboard" }
  | { name: "new" }
  | { name: "detail"; id: string }
  | { name: "insurers" }
  | { name: "insurer"; id: string }
  | { name: "manager" };

const STATUS_COLUMNS: { key: string; title: string }[] = [
  { key: "new", title: "New submissions" },
  { key: "in_review", title: "In review" },
  { key: "missing_info_requested", title: "Missing info requested" },
  { key: "ready_for_quote", title: "Ready for quote" },
  { key: "referred_to_insurer", title: "Referred to insurer" },
  { key: "completed", title: "Completed / closed" },
];

// Statuses that share the final column.
const COMPLETED_GROUP = new Set(["completed", "closed"]);

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (!data.session) {
        setAuth({ kind: "signed_out" });
        return;
      }
      const role = await currentRole();
      const email = data.session.user.email ?? null;
      setAuth(role ? { kind: "staff", email, role } : { kind: "denied", email });
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      // Re-evaluate on any auth change (sign in/out, token refresh).
      currentRole().then(async (role) => {
        const { data } = await supabase.auth.getSession();
        const email = data.session?.user.email ?? null;
        if (!data.session) setAuth({ kind: "signed_out" });
        else setAuth(role ? { kind: "staff", email, role } : { kind: "denied", email });
      });
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (auth.kind === "loading") {
    return <div className="atlas-auth"><div className="atlas-auth__card"><p>Loading…</p></div></div>;
  }

  if (auth.kind === "signed_out") {
    const isDev = new URLSearchParams(window.location.search).get("dev") === "1";
    return isDev ? <DevSignIn /> : (
      <div className="atlas-auth">
        <div className="atlas-auth__card">
          <h1>Atlas</h1>
          <p>Underwriting decision-support</p>
          <button className="atlas-btn atlas-btn--primary" onClick={startLogin}>
            Sign in with Microsoft
          </button>
        </div>
      </div>
    );
  }

  if (auth.kind === "denied") {
    return (
      <div className="atlas-auth">
        <div className="atlas-auth__card">
          <h1>Atlas</h1>
          <p>Underwriting decision-support</p>
          <div className="atlas-auth__denied">
            This account isn’t authorised for Atlas. Contact an administrator to
            be added to the underwriting team.
          </div>
          <button
            className="atlas-btn"
            style={{ marginTop: 16 }}
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Staff app: dashboard / new submission / detail
  return (
    <div className="atlas-shell">
      <header className="atlas-topbar">
        <div className="atlas-brand">
          Atlas <span className="atlas-brand__tag">Blueprint</span>
        </div>
        <div className="atlas-user">
          <span>{auth.email}</span>
          <span className="atlas-role-pill">{auth.role}</span>
          <button className="atlas-btn" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="atlas-main">
        <StaffApp role={auth.role} />
      </main>
    </div>
  );
}

function DevSignIn() {
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerUrl = import.meta.env.VITE_ATLAS_API_URL as string;

  async function onSignIn() {
    if (!email.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(
        `${workerUrl}/dev/sign-in?email=${encodeURIComponent(email.trim())}`
      );
      const data = await res.json();
      if (!res.ok || !data.ok || !data.action_link) {
        setError(
          data.error === "not_authorised"
            ? "Email is not on the allow-list."
            : data.error === "not_found"
            ? "Dev sign-in is only available in local development."
            : "Sign-in failed."
        );
        setWorking(false);
        return;
      }
      window.location.href = data.action_link;
    } catch {
      setError("Could not reach the Worker. Is wrangler dev running?");
      setWorking(false);
    }
  }

  return (
    <div className="atlas-auth">
      <div className="atlas-auth__card">
        <h1>Atlas</h1>
        <p>Underwriting decision-support</p>
        <div
          style={{
            marginBottom: 14,
            padding: "8px 11px",
            borderRadius: 6,
            background: "var(--atlas-warn-bg)",
            color: "#5c4708",
            fontSize: 12,
            fontFamily: "var(--atlas-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          ⚠ Dev sign-in — local only
        </div>
        <input
          type="email"
          placeholder="your.email@firm.co.za"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{
            width: "100%",
            padding: "9px 11px",
            border: "1px solid var(--atlas-line)",
            borderRadius: 7,
            fontSize: 14,
            marginBottom: 12,
            fontFamily: "var(--atlas-body)",
          }}
        />
        {error && <div className="atlas-auth__denied">{error}</div>}
        <button
          className="atlas-btn atlas-btn--primary"
          onClick={onSignIn}
          disabled={working || !email.trim()}
          style={{ width: "100%", marginTop: error ? 12 : 0 }}
        >
          {working ? "Signing in…" : "Dev sign-in"}
        </button>
      </div>
    </div>
  );
}

function StaffApp({ role }: { role: AtlasUiRole }) {
  const [view, setView] = useState<View>({ name: "dashboard" });
  const [items, setItems] = useState<SubmissionListItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadBoard() {
    setLoading(true);
    try {
      const res = await listSubmissions();
      setItems(res.submissions);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.name === "dashboard") loadBoard();
  }, [view.name]);

  if (view.name === "insurers") {
    return (
      <Insurers
        role={role}
        onOpen={(id) => setView({ name: "insurer", id })}
        onBack={() => setView({ name: "dashboard" })}
      />
    );
  }

  if (view.name === "manager") {
    return <ManagerDashboard onBack={() => setView({ name: "dashboard" })} />;
  }

  if (view.name === "insurer") {
    return (
      <InsurerDetail
        insurerId={view.id}
        role={role}
        onBack={() => setView({ name: "insurers" })}
      />
    );
  }

  if (view.name === "new") {
    return (
      <NewSubmission
        onCancel={() => setView({ name: "dashboard" })}
        onCreated={(id) => setView({ name: "detail", id })}
      />
    );
  }

  if (view.name === "detail") {
    return (
      <SubmissionDetail
        submissionId={view.id}
        role={role}
        onBack={() => setView({ name: "dashboard" })}
      />
    );
  }

  // Dashboard
  const byColumn = (key: string) =>
    items.filter((s) =>
      key === "completed" ? COMPLETED_GROUP.has(s.status) : s.status === key
    );

  return (
    <div>
      <div className="atlas-page-head atlas-page-head--row">
        <div>
          <h1>Submissions</h1>
          <p>Decision-support intake, extraction, and insurer recommendation.</p>
        </div>
        <div className="atlas-page-head__actions">
          {canManage(role) && (
            <button
              className="atlas-btn"
              onClick={() => setView({ name: "manager" })}
            >
              Manager visibility
            </button>
          )}
          <button
            className="atlas-btn"
            onClick={() => setView({ name: "insurers" })}
          >
            Insurers
          </button>
          <button
            className="atlas-btn atlas-btn--primary"
            onClick={() => setView({ name: "new" })}
            disabled={!canWrite(role)}
          >
            + New submission
          </button>
        </div>
      </div>

      <div className="atlas-board">
        {STATUS_COLUMNS.map((col) => {
          const cards = byColumn(col.key);
          return (
            <section className="atlas-col" key={col.key}>
              <div className="atlas-col__head">
                <span className="atlas-col__title">{col.title}</span>
                <span className="atlas-col__count">{loading ? "·" : cards.length}</span>
              </div>
              <div className="atlas-col__body">
                {cards.length === 0 ? (
                  <div className="atlas-col__empty">
                    {loading ? "Loading…" : "Nothing here"}
                  </div>
                ) : (
                  cards.map((s) => (
                    <button
                      key={s.id}
                      className="atlas-subcard"
                      onClick={() => setView({ name: "detail", id: s.id })}
                    >
                      <div className="atlas-subcard__client">{s.client_name || "Untitled"}</div>
                      <div className="atlas-subcard__meta">
                        {s.request_type || "—"}
                        {s.broker_name ? ` · ${s.broker_name}` : ""}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
