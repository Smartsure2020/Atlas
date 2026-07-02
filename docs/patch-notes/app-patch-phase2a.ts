/**
 * Atlas Blueprint — App.tsx patch for Phase 2A
 * ----------------------------------------------------------------------------
 * Three small additions to src/App.tsx. This file is documentation only,
 * not imported anywhere. Each section is annotated with where to put it.
 * ============================================================================
 */

// ----- 1. ADD these imports alongside the existing page imports -----

// import Insurers from "./pages/Insurers";
// import InsurerDetail from "./pages/InsurerDetail";


// ----- 2. EXTEND the View type to include the two new screens -----

// type View =
//   | { name: "dashboard" }
//   | { name: "new" }
//   | { name: "detail"; id: string }
//   | { name: "insurers" }           // NEW
//   | { name: "insurer"; id: string }; // NEW


// ----- 3. INSIDE StaffApp, ADD these two branches BEFORE the dashboard return -----

/*

if (view.name === "insurers") {
  return (
    <Insurers
      role={role}
      onOpen={(id) => setView({ name: "insurer", id })}
      onBack={() => setView({ name: "dashboard" })}
    />
  );
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

*/


// ----- 4. ADD an "Insurers" button on the dashboard header row -----
//
// In the dashboard return, the existing page-head row has the title block on
// the left and a "+ New submission" primary button on the right. Add a second
// button next to it so the dashboard header looks like:
//
//   [Submissions]                            [Insurers]  [+ New submission]
//
// Replace the existing single-button render with this pair:

/*

<div className="atlas-page-head__actions">
  <button
    className="atlas-btn"
    onClick={() => setView({ name: "insurers" })}
  >
    Insurers
  </button>
  <button
    className="atlas-btn atlas-btn--primary"
    onClick={() => setView({ name: "new" })}
  >
    + New submission
  </button>
</div>

*/

export {}; // documentation file
