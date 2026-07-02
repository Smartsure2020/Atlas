/**
 * Atlas Blueprint — patch for src/pages/RecommendationPanel.tsx
 * ----------------------------------------------------------------------------
 * Make the "extraction not reviewed" gate more obviously actionable. The
 * existing message says it once and quietly; the patch replaces it with a
 * clear numbered guide so the user knows exactly what to do, and a slight
 * visual emphasis (warning-tone box matching the disclaimer style) so it
 * doesn't get lost on the page.
 *
 * One small render change. No logic change.
 * ============================================================================
 */

// ----- FIND this block in RecommendationPanel.tsx (currently above the
//       {error && ...} line): -----
//
//   {!extractionReviewed && (
//     <p className="atlas-muted" style={{ marginTop: 0 }}>
//       Atlas runs the matcher against the reviewed risk summary. Open
//       “Correct” above, confirm the extracted fields, and save to enable this.
//     </p>
//   )}


// ----- REPLACE with: -----

/*

{!extractionReviewed && (
  <div
    className="atlas-disclaimer"
    role="note"
    style={{ marginTop: 0 }}
  >
    <span className="atlas-disclaimer__mark" aria-hidden="true">ⓘ</span>
    <div className="atlas-disclaimer__text">
      <strong>Review the extraction before running a recommendation.</strong>
      <ol style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13 }}>
        <li>Click <em>Correct</em> on the risk summary above.</li>
        <li>Edit anything Claude misread, then click <em>Save corrections</em>.</li>
        <li>The <em>Run recommendation</em> button below will enable.</li>
      </ol>
    </div>
  </div>
)}

*/

// (Reusing the existing .atlas-disclaimer class gives this the same warning-
// tone styling as the governance disclaimer at the top of the panel, which
// makes it instantly recognisable as "you need to act on this" rather than
// fading into general muted body text.)

export {}; // documentation file
