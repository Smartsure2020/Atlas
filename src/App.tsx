/**
 * Atlas — app root: auth gate and routing
 * ----------------------------------------------------------------------------
 * Three states, unchanged from Phase 0 because the security model is unchanged:
 *   1. Signed out          -> Microsoft sign-in (shared Azure app).
 *   2. Signed in, no role  -> access denied (fail closed; allow-list said no).
 *   3. Signed in + staff   -> the application shell.
 *
 * Role gating in the UI mirrors the Worker's own gates. It is a courtesy so
 * people are not shown controls that will fail; the server remains the
 * authoritative boundary.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase, currentRole, startLogin } from "./lib/atlas";
import { routeFromHash, routeToHash, type Route } from "./lib/router";
import { AppShell, type AtlasUiRole } from "./components/AppShell";
import { Button, Notice, TextField, ToastProvider } from "./components/ui";
import WorkQueue from "./pages/WorkQueue";
import NewSubmission from "./pages/NewSubmission";
import SubmissionDetail from "./pages/SubmissionDetail";
import Insurers from "./pages/Insurers";
import InsurerDetail from "./pages/InsurerDetail";
import ManagerDashboard from "./pages/ManagerDashboard";
import ProcessingJobs from "./pages/ProcessingJobs";
import "./styles/index.css";

type AuthState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "denied"; email: string | null }
  | { kind: "staff"; email: string | null; role: AtlasUiRole };

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
    return (
      <div className="atlas-auth">
        <div className="atlas-auth__card">
          <AuthBrand />
          <p className="atlas-text-dense atlas-text-muted">Checking your access…</p>
        </div>
      </div>
    );
  }

  if (auth.kind === "signed_out") {
    const isDev = new URLSearchParams(window.location.search).get("dev") === "1";
    return isDev ? <DevSignIn /> : <SignIn />;
  }

  if (auth.kind === "denied") {
    return (
      <div className="atlas-auth">
        <div className="atlas-auth__card">
          <AuthBrand />
          <div className="atlas-stack">
            <Notice tone="danger" title="This account is not authorised for Atlas">
              {auth.email ? `${auth.email} is not on the Atlas allow-list. ` : ""}
              Ask an administrator to add you to the underwriting team, then sign in again.
            </Notice>
            <Button onClick={() => supabase.auth.signOut()}>Sign out</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <StaffApp role={auth.role} email={auth.email} />
    </ToastProvider>
  );
}

function AuthBrand() {
  return (
    <div className="atlas-auth__brand">
      <span className="atlas-sidebar__mark" aria-hidden="true">
        A
      </span>
      <span>
        <span className="atlas-auth__title">Atlas</span>
        <span className="atlas-auth__subtitle" style={{ display: "block" }}>
          Underwriting decision-support
        </span>
      </span>
    </div>
  );
}

function SignIn() {
  return (
    <div className="atlas-auth">
      <div className="atlas-auth__card">
        <AuthBrand />
        <div className="atlas-stack">
          <p className="atlas-text-dense atlas-text-muted">
            Sign in with your work account to reach the underwriting queue, insurer appetite,
            and quote reviews.
          </p>
          <Button variant="primary" size="lg" block onClick={startLogin} iconAfter="arrow-right">
            Sign in with Microsoft
          </Button>
        </div>
      </div>
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
      const res = await fetch(`${workerUrl}/dev/sign-in?email=${encodeURIComponent(email.trim())}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.action_link) {
        setError(
          data.error === "not_authorised"
            ? "That email is not on the Atlas allow-list."
            : data.error === "not_found"
            ? "Dev sign-in is only available in local development."
            : "Sign-in failed. Check the Worker logs for the reason."
        );
        setWorking(false);
        return;
      }
      window.location.href = data.action_link;
    } catch {
      setError("Could not reach the Worker. Check that wrangler dev is running.");
      setWorking(false);
    }
  }

  return (
    <div className="atlas-auth">
      <div className="atlas-auth__card">
        <AuthBrand />
        <div className="atlas-auth__form">
          <Notice tone="warning" title="Development sign-in">
            This bypass exists only in local development and is not available in the pilot
            environment.
          </Notice>
          <TextField
            label="Work email"
            type="email"
            required
            value={email}
            placeholder="your.name@firm.co.za"
            error={error}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onSignIn();
            }}
          />
          <Button
            variant="primary"
            block
            loading={working}
            loadingLabel="Signing in…"
            disabled={!email.trim()}
            onClick={onSignIn}
          >
            Sign in
          </Button>
        </div>
      </div>
    </div>
  );
}

function StaffApp({ role, email }: { role: AtlasUiRole; email: string | null }) {
  const [route, setRoute] = useState<Route>(() => routeFromHash());
  // Search is shell-level so the global field can scope the queue from anywhere.
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onHistory = () => setRoute(routeFromHash());
    window.addEventListener("popstate", onHistory);
    window.addEventListener("hashchange", onHistory);
    if (!window.location.hash) window.history.replaceState({}, "", "#submissions");
    return () => {
      window.removeEventListener("popstate", onHistory);
      window.removeEventListener("hashchange", onHistory);
    };
  }, []);

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = routeToHash(next);
    setRoute(next);
    if (window.location.hash !== hash) {
      if (options.replace) window.history.replaceState({}, "", hash);
      else window.history.pushState({}, "", hash);
    }
    // A route change is a new reading context; start at the top of it.
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const onSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (value && route.name !== "queue") navigate({ name: "queue" });
    },
    [navigate, route.name]
  );

  return (
    <AppShell
      route={route}
      role={role}
      email={email}
      searchValue={search}
      onSearch={onSearch}
      onNavigate={(next) => navigate(next)}
      onSignOut={() => supabase.auth.signOut()}
    >
      <RouteView route={route} role={role} search={search} onSearchChange={setSearch} navigate={navigate} />
    </AppShell>
  );
}

function RouteView({
  route,
  role,
  search,
  onSearchChange,
  navigate,
}: {
  route: Route;
  role: AtlasUiRole;
  search: string;
  onSearchChange: (value: string) => void;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}) {
  switch (route.name) {
    case "new-submission":
      return (
        <NewSubmission
          onCancel={() => navigate({ name: "queue" })}
          onCreated={(id) => navigate({ name: "submission", id, tab: "overview" })}
        />
      );

    case "submission":
      return (
        <SubmissionDetail
          key={route.id}
          submissionId={route.id}
          tab={route.tab}
          role={role}
          onTabChange={(tab) => navigate({ name: "submission", id: route.id, tab }, { replace: true })}
          onBack={() => navigate({ name: "queue" })}
        />
      );

    case "insurers":
      return <Insurers role={role} onOpen={(id) => navigate({ name: "insurer", id })} />;

    case "insurer":
      return (
        <InsurerDetail
          key={route.id}
          insurerId={route.id}
          role={role}
          onBack={() => navigate({ name: "insurers" })}
        />
      );

    case "oversight":
      return <ManagerDashboard onOpenSubmission={(id) => navigate({ name: "submission", id, tab: "overview" })} />;

    case "jobs":
      return <ProcessingJobs onOpenSubmission={(id) => navigate({ name: "submission", id, tab: "overview" })} />;

    case "queue":
    default:
      return (
        <WorkQueue
          role={role}
          search={search}
          onSearchChange={onSearchChange}
          onNew={() => navigate({ name: "new-submission" })}
          onOpen={(id) => navigate({ name: "submission", id, tab: "overview" })}
        />
      );
  }
}
