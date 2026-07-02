/**
 * Atlas Blueprint — App.tsx patch for the DEV SIGN-IN SHORTCUT
 * ----------------------------------------------------------------------------
 * Renders an alternate "dev sign-in" form when the URL has ?dev=1.
 *
 * Three additions to src/App.tsx:
 *   1. Import the DevSignIn component (defined inline below — paste it
 *      anywhere in App.tsx, or split to its own file if you prefer).
 *   2. Detect the ?dev=1 query param at the top of App() and render DevSignIn
 *      INSTEAD of the normal sign-in screen.
 *   3. (Nothing else.) Once dev sign-in completes, the existing auth state
 *      machine in App takes over — same as if you'd signed in via Microsoft.
 *
 * To revert when IT registers the redirect URI: delete the DevSignIn function,
 * delete the import, delete the `?dev=1` branch. Two-minute cleanup.
 * ============================================================================
 */

// ----- 1. DEV-ONLY COMPONENT — paste this anywhere in App.tsx (e.g. at the
//          very bottom, below the StaffApp function). -----

/*

function DevSignIn() {
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same env var the rest of the frontend uses to reach the Worker.
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
      // Follow the magic link to establish the Supabase session, then come
      // back to the app. The action_link redirects back to the configured
      // Supabase Site URL, which should be http://localhost:5173 in dev.
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

*/


// ----- 2. AT THE TOP of the App() function, BEFORE the existing useState
//          and useEffect calls, add the ?dev=1 detection: -----

/*

  // DEV SHORTCUT: ?dev=1 in the URL routes to the dev sign-in form
  // (only useful while waiting on IT to register the Microsoft redirect URI).
  const isDevSignIn = new URLSearchParams(window.location.search).get("dev") === "1";
  if (isDevSignIn) {
    // Check if we already have a session (e.g. we just came back from the
    // magic link). If yes, fall through to the normal auth state machine.
    // If no, show the dev form.
    const hasSession = !!supabase.auth.getSession;  // placeholder check
    // We actually want to let the existing useEffect run to decide; only
    // override the SIGNED-OUT render below.
  }

*/

// Cleaner: don't try to short-circuit at the top. Just override the
// "signed_out" branch in the existing render. Replace:
//
//   if (auth.kind === "signed_out") { return <normal sign-in screen>; }
//
// with:
//
//   if (auth.kind === "signed_out") {
//     const isDev = new URLSearchParams(window.location.search).get("dev") === "1";
//     return isDev ? <DevSignIn /> : <normal sign-in screen>;
//   }
//
// That's it. Everything else (auth state machine, dashboard, RLS) is unchanged.

export {}; // documentation file
