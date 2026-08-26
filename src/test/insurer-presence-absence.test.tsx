/**
 * Insurer channel presence/absence — visual distinction regression.
 * ----------------------------------------------------------------------------
 * The insurer index previously showed both "has a quote channel" and
 * "has no quote channel on file" using the same `atlas-badge--quiet`
 * tone with the same layout. That made the distinction depend on the
 * label text alone. The fix uses a dashed outline variant plus an
 * "Add" prefix for absence — the two states now differ in class, in
 * text, and in visual tone.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// ../lib/insurers imports `api` from ../lib/atlas, which initialises the
// real Supabase client at module load. Mock it before the production-page
// import below so collection never touches Supabase, in an environment
// with or without VITE_SUPABASE_* variables set.
vi.mock("../lib/atlas", () => ({
  api: vi.fn(async () => ({ ok: true })),
}));

import Insurers from "../pages/Insurers";
import * as insurersLib from "../lib/insurers";

const BASE = {
  id: "id",
  name: "Acme",
  active: true,
  active_appetite_count: 1,
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Insurers — quote-channel presence vs absence", () => {
  it("renders the channel value pill for insurers with a channel", async () => {
    vi.spyOn(insurersLib, "listInsurers").mockResolvedValue({
      insurers: [{ ...BASE, id: "1", quote_channel: "email_submission" }],
    } as Awaited<ReturnType<typeof insurersLib.listInsurers>>);
    render(<Insurers role="admin" onOpen={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    const pill = screen.getByText("Email submission");
    expect(pill).toBeInTheDocument();
    // The value pill uses the quiet tone, NOT the absence outline.
    const badge = pill.closest(".atlas-badge") as HTMLElement;
    expect(badge?.classList.contains("atlas-badge--quiet")).toBe(true);
    expect(badge?.classList.contains("atlas-badge--outline")).toBe(false);
  });

  it("renders the outlined 'Add submission channel' pill when absent", async () => {
    vi.spyOn(insurersLib, "listInsurers").mockResolvedValue({
      insurers: [{ ...BASE, id: "1", quote_channel: null }],
    } as Awaited<ReturnType<typeof insurersLib.listInsurers>>);
    render(<Insurers role="admin" onOpen={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    const absencePill = screen.getByText("Add submission channel");
    expect(absencePill).toBeInTheDocument();
    const badge = absencePill.closest(".atlas-badge") as HTMLElement;
    expect(badge?.classList.contains("atlas-badge--outline")).toBe(true);
    expect(badge?.classList.contains("atlas-badge--quiet")).toBe(false);
  });
});
