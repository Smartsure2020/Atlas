/**
 * Atlas Blueprint — InsurerDetail patch for the refinement
 * ----------------------------------------------------------------------------
 * Documentation only. Adds an "+ Add rule" button to the Active tab on
 * src/pages/InsurerDetail.tsx, opening the AddRuleForm component.
 *
 * Four small changes:
 *   1. New import.
 *   2. An isAdding state in InsurerDetail.
 *   3. Pass isAdding state + handlers down to AppetitePanel.
 *   4. In AppetitePanel, render the form or an "Add rule" button (Active tab only).
 * ============================================================================
 */

// ----- 1. ADD this import near the existing page imports -----

// import { AddRuleForm } from "./AddRuleForm";


// ----- 2. INSIDE the existing InsurerDetail function, add:

/*

const [isAdding, setIsAdding] = useState(false);

*/


// ----- 3. WHERE the existing code renders the Active panel, pass two new props.
//
// Find this existing line (inside InsurerDetail's render):
//
//   {tab === "active" && (
//     <AppetitePanel rows={active} role={role} onChanged={load} />
//   )}
//
// Replace with:

/*

{tab === "active" && (
  <AppetitePanel
    rows={active}
    role={role}
    onChanged={() => { setIsAdding(false); load(); }}
    insurerId={insurerId}
    isAdding={isAdding}
    onStartAdd={() => setIsAdding(true)}
    onCancelAdd={() => setIsAdding(false)}
  />
)}

*/


// ----- 4. EXTEND AppetitePanel's props and render.
//
// In the existing AppetitePanel function inside InsurerDetail.tsx:
//
//   - Extend its props interface to include the four new optional props:
//
//       insurerId?: string;
//       isAdding?: boolean;
//       onStartAdd?: () => void;
//       onCancelAdd?: () => void;
//
//   - At the TOP of the rendered output (before the existing "if (rows.length === 0)" check),
//     render the add-rule UI for ACTIVE tab only:

/*

{props.insurerId && props.role === "admin" && !props.showConfirm && (
  props.isAdding ? (
    <AddRuleForm
      insurerId={props.insurerId}
      onAdded={() => props.onChanged()}
      onCancel={() => props.onCancelAdd?.()}
    />
  ) : (
    <div style={{ marginBottom: 12, textAlign: "right" }}>
      <button
        className="atlas-btn atlas-btn--small"
        onClick={() => props.onStartAdd?.()}
      >
        + Add rule
      </button>
    </div>
  )
)}

*/

// (showConfirm is the existing prop that distinguishes the Proposed tab from
// the Active tab — showConfirm=true means Proposed, so the negation means
// "we are on the Active tab", which is exactly where we want the Add button.)

export {}; // documentation file
