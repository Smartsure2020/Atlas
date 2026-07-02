/**
 * Atlas Blueprint — patch for src/pages/InsurerDetail.tsx
 * ----------------------------------------------------------------------------
 * Adds an inline rename affordance to the insurer name on the header. Plus the
 * DocumentsPanel reference change (it's now a separate file).
 *
 * Three small edits to InsurerDetail.tsx.
 * ============================================================================
 */

// ----- 1. UPDATE the imports at the top of InsurerDetail.tsx -----

// Remove uploadGuideline / processInsurerDocument from the existing
// "../lib/insurers" import line — they're now used only by DocumentsPanel.
// Add updateInsurer (and DocumentsPanel from its new file).

/*

import {
  getInsurer,
  updateInsurer,
  editAppetite,
  confirmAppetite,
  deactivateAppetite,
  type AppetiteRow,
  type InsurerDocument,
  type InsurerListItem,
} from "../lib/insurers";
import { DocumentsPanel } from "./DocumentsPanel";

*/


// ----- 2. ADD rename state inside the InsurerDetail() function, alongside the
//          existing useState declarations: -----

/*

const [renaming, setRenaming] = useState(false);
const [nameDraft, setNameDraft] = useState("");
const [renameWorking, setRenameWorking] = useState(false);

async function onSaveName() {
  if (!nameDraft.trim() || !insurer) return;
  setRenameWorking(true);
  try {
    await updateInsurer(insurer.id, { name: nameDraft.trim() });
    setRenaming(false);
    await load();
  } catch {
    setError("Could not rename the insurer.");
  } finally {
    setRenameWorking(false);
  }
}

*/


// ----- 3. REPLACE the existing <h1>{insurer.name}</h1> with the rename UI: -----
//
// Find the existing line in the page header:
//
//   <h1>{insurer.name}</h1>
//
// Replace with:

/*

{!renaming ? (
  <h1 style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
    {insurer.name}
    {role === "admin" && (
      <button
        className="atlas-btn atlas-btn--small atlas-btn--ghost"
        onClick={() => { setNameDraft(insurer.name); setRenaming(true); }}
      >
        Edit
      </button>
    )}
  </h1>
) : (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <input
      value={nameDraft}
      onChange={(e) => setNameDraft(e.target.value)}
      autoFocus
      style={{
        fontFamily: "var(--atlas-display)",
        fontWeight: 600,
        fontSize: 27,
        padding: "4px 8px",
        border: "1px solid var(--atlas-line)",
        borderRadius: 7,
      }}
    />
    <button className="atlas-btn atlas-btn--small" onClick={() => setRenaming(false)}>
      Cancel
    </button>
    <button
      className="atlas-btn atlas-btn--primary atlas-btn--small"
      onClick={onSaveName}
      disabled={renameWorking || !nameDraft.trim()}
    >
      {renameWorking ? "Saving…" : "Save"}
    </button>
  </div>
)}

*/

// ----- 4. The existing inline DocumentsPanel sub-component inside
//          InsurerDetail.tsx should be DELETED (it's now in its own file).
// ============================================================================

export {}; // documentation file
