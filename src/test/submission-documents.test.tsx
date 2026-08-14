/**
 * Submission documents — page-level tests
 * ----------------------------------------------------------------------------
 * DocumentsTab is a presentational component: its parent supplies the
 * documents array and callbacks. There is no network call to mock. The
 * tests cover:
 *   - the four trust groups (quarantined, scan-in-progress, active, expired)
 *     render in the right order and only when they have contents;
 *   - the trust strip is silent on a clean submission;
 *   - "On file" is never claimed for a document that hasn't been scanned clean;
 *   - the "expired" wording does not guarantee the file was deleted;
 *   - the Run / Rerun Extraction button fires the callback exactly once
 *     and respects the read-only gate;
 *   - long filenames retain their extension via truncateMiddle;
 *   - an unknown scan status is displayed rather than hidden;
 *   - the surface is axe-clean in the mixed and empty states.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import DocumentsTab from "../pages/SubmissionDocuments";

type Doc = Record<string, unknown>;

function doc(over: Partial<Doc> = {}): Doc {
  return {
    id: `d_${Math.random().toString(36).slice(2, 8)}`,
    file_name: "proposal.pdf",
    document_type: "proposal_form",
    status: "active",
    scan_status: "clean",
    size_bytes: 12345,
    created_at: "2026-08-01T10:00:00Z",
    expires_at: null,
    uploaded_by_email: null,
    ...over,
  };
}

function renderTab(props: Partial<React.ComponentProps<typeof DocumentsTab>> = {}) {
  const onExtract = vi.fn();
  const utils = render(
    <DocumentsTab
      documents={props.documents ?? []}
      extraction={props.extraction ?? null}
      canManage={props.canManage ?? true}
      extracting={props.extracting ?? false}
      onExtract={props.onExtract ?? onExtract}
    />
  );
  return { ...utils, onExtract: props.onExtract ?? onExtract };
}

describe("Submission documents", () => {
  it("shows the empty state when nothing is attached", () => {
    renderTab({ documents: [] });
    expect(
      screen.getByText(/No documents are attached/i)
    ).toBeInTheDocument();
    // No trust strip on a truly empty submission.
    expect(screen.queryByText(/cannot be read yet/i)).not.toBeInTheDocument();
  });

  it("renders active-only documents without any trust strip", () => {
    renderTab({
      documents: [doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })],
    });
    expect(screen.getByText("clean.pdf")).toBeInTheDocument();
    expect(screen.getByText(/^On file$/i)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be read yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Quarantined/i })).not.toBeInTheDocument();
  });

  it("renders a quarantine-only submission with wording that never claims deletion", () => {
    renderTab({
      documents: [
        doc({ id: "q1", file_name: "infected.pdf", scan_status: "infected", status: "active" }),
      ],
    });
    expect(screen.getByRole("heading", { name: /Quarantined by malware scan/i })).toBeInTheDocument();
    const explainer = screen.getByText(
      /malware scan flagged/i,
      { selector: ".atlas-doc-groups__hint" }
    );
    // The file is isolated, not deleted — the copy must reflect that.
    expect(explainer.textContent).toMatch(/isolated/);
    expect(explainer.textContent).not.toMatch(/deleted/i);
  });

  it("renders an expired-only submission with retention wording (no deletion claim)", () => {
    renderTab({
      documents: [
        doc({
          id: "e1",
          file_name: "old.pdf",
          status: "expired",
          scan_status: "clean",
          expires_at: "2026-05-01T00:00:00Z",
        }),
      ],
    });
    expect(
      screen.getByRole("heading", { name: /Expired documents \(file removed under retention\)/i })
    ).toBeInTheDocument();
    const explainer = screen.getByText(
      /no longer available under the retention policy/i,
      { selector: ".atlas-doc-groups__hint" }
    );
    // The explainer never claims deletion is guaranteed.
    expect(explainer.textContent).not.toMatch(/has been deleted/i);
    // A missing expires_at falls back to "Retention date not recorded" — assert
    // the negative here (the row does carry a date).
    expect(screen.queryByText(/Retention date not recorded/i)).not.toBeInTheDocument();
  });

  it("labels an expired document with no expires_at as 'Retention date not recorded'", () => {
    renderTab({
      documents: [
        doc({ id: "e1", file_name: "old.pdf", status: "expired", scan_status: "clean", expires_at: null }),
      ],
    });
    expect(screen.getByText(/Retention date not recorded/i)).toBeInTheDocument();
  });

  it("does not render 'On file' for a pending scan", () => {
    renderTab({
      documents: [doc({ id: "p1", file_name: "still-scanning.pdf", scan_status: "pending" })],
    });
    expect(screen.getByRole("heading", { name: /Scan in progress/i })).toBeInTheDocument();
    expect(screen.queryByText(/^On file$/i)).not.toBeInTheDocument();
    // The trust strip surfaces the pending scan as informational, not blocking.
    expect(screen.getByText(/still being scanned/i)).toBeInTheDocument();
  });

  it("orders trust groups quarantined → pending → active → expired in a mixed submission", () => {
    renderTab({
      documents: [
        doc({ id: "a", file_name: "active.pdf", scan_status: "clean" }),
        doc({ id: "e", file_name: "old.pdf", status: "expired", scan_status: "clean" }),
        doc({ id: "p", file_name: "pending.pdf", scan_status: "pending" }),
        doc({ id: "q", file_name: "bad.pdf", scan_status: "infected" }),
      ],
    });
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      expect.stringMatching(/Quarantined/i),
      expect.stringMatching(/Scan in progress/i),
      expect.stringMatching(/Active documents/i),
      expect.stringMatching(/Expired documents/i),
    ]);
  });

  it("fires the extraction callback exactly once per click and disables during extraction", async () => {
    const user = userEvent.setup();
    const onExtract = vi.fn();
    const { rerender } = render(
      <DocumentsTab
        documents={[doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })]}
        extraction={null}
        canManage={true}
        extracting={false}
        onExtract={onExtract}
      />
    );
    const button = screen.getByRole("button", { name: /Run extraction/i });
    await user.click(button);
    expect(onExtract).toHaveBeenCalledTimes(1);

    rerender(
      <DocumentsTab
        documents={[doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })]}
        extraction={null}
        canManage={true}
        extracting={true}
        onExtract={onExtract}
      />
    );
    // Loading text replaces the button's label; clicking again is a no-op.
    const busy = screen.getByRole("button", { name: /Extracting/i });
    expect(busy).toBeDisabled();
  });

  it("labels the button 'Rerun extraction' when a prior extraction is on file", () => {
    renderTab({
      documents: [doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })],
      extraction: { id: "ex_1", reviewed_json: null },
    });
    expect(screen.getByRole("button", { name: /Rerun extraction/i })).toBeInTheDocument();
  });

  it("does not render the extract button in read-only mode", () => {
    renderTab({
      documents: [doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })],
      canManage: false,
    });
    expect(screen.queryByRole("button", { name: /extraction/i })).not.toBeInTheDocument();
  });

  it("preserves the extension of a long filename via truncateMiddle", () => {
    const longName = "a".repeat(60) + ".pdf";
    renderTab({
      documents: [doc({ id: "d1", file_name: longName, scan_status: "clean" })],
    });
    // Some part of the visible name must include ".pdf" — the truncateMiddle
    // helper keeps the tail intact so the extension stays visible.
    const nameNode = screen.getByText(/\.pdf$/);
    expect(nameNode.textContent?.endsWith(".pdf")).toBe(true);
    // The rendered text is shorter than the raw input.
    expect(nameNode.textContent!.length).toBeLessThan(longName.length);
  });

  it("does not expose unsupported download or open actions on a document row", () => {
    renderTab({
      documents: [doc({ id: "d1", file_name: "clean.pdf", scan_status: "clean" })],
    });
    // Only the extraction button is present as a document-related control.
    expect(screen.queryByRole("button", { name: /^Open$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Download$/i })).not.toBeInTheDocument();
  });

  it("keeps an unknown scan status visible rather than promoting it to On file", () => {
    renderTab({
      documents: [
        doc({ id: "u1", file_name: "unknown-scan.pdf", scan_status: "some_new_state" }),
      ],
    });
    // The unknown status is rendered via the shared scanStatus helper, which
    // humanises the enum. The safe green "On file" badge must NOT appear.
    expect(screen.queryByText(/^On file$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Some new state/i)).toBeInTheDocument();
  });

  it("is axe-clean in a mixed populated state", async () => {
    const { container } = renderTab({
      documents: [
        doc({ id: "a", file_name: "active.pdf", scan_status: "clean" }),
        doc({ id: "e", file_name: "old.pdf", status: "expired", scan_status: "clean" }),
        doc({ id: "p", file_name: "pending.pdf", scan_status: "pending" }),
        doc({ id: "q", file_name: "bad.pdf", scan_status: "infected" }),
      ],
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the empty state", async () => {
    const { container } = renderTab({ documents: [] });
    expect(await axe(container)).toHaveNoViolations();
  });
});
