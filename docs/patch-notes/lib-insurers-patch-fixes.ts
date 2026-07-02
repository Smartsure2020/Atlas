/**
 * Atlas Blueprint — patch for src/lib/insurers.ts
 * ----------------------------------------------------------------------------
 * APPEND this to the bottom of src/lib/insurers.ts. Adds the API helper for
 * editing an insurer.
 * ============================================================================
 */

/*

// ---- Update an insurer's name / channel / notes ----

export function updateInsurer(
  insurerId: string,
  update: {
    name?: string;
    quote_channel?: string | null;
    active?: boolean;
    notes?: string | null;
  }
) {
  return api<{ ok: true }>(`/api/insurers/${insurerId}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

*/

export {}; // documentation file
