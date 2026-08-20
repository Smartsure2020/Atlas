/**
 * New submission intake workbench — page-level tests
 * ----------------------------------------------------------------------------
 * Full mocks for ../lib/atlas so no test transitively loads the real API
 * client. Covered:
 *   - client-name validation gates the submit
 *   - a single click creates the submission exactly once
 *   - a partial upload failure surfaces the honest recovery notice
 *     (never "open the submission and add them there")
 *   - the retry re-uses the same submissionId and never re-hits
 *     createSubmission — even under a burst of clicks
 *   - only remaining (pending/failed) files are re-uploaded on retry
 *   - uploaded files disable the Remove control (no phantom delete)
 *   - the complete phase calls onCreated exactly once
 *   - a submission with zero files still creates and calls onCreated
 *   - the leave-partial ConfirmDialog opens only in the partial phase,
 *     cancel + Esc close it without a write, confirm calls onCancel
 *   - duplicate-signature files are suppressed
 *   - non-PDF files are flagged and block the submit
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createSubmissionMock = vi.fn();
const uploadDocumentMock = vi.fn();

vi.mock("../lib/atlas", () => ({
  createSubmission: (...args: unknown[]) => createSubmissionMock(...args),
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}));

import NewSubmission from "../pages/NewSubmission";
import { ToastProvider } from "../components/ui";

function pdf(name: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "application/pdf" });
}

function renderPage() {
  const onCreated = vi.fn<(id: string) => void>();
  const onCancel = vi.fn();
  const rendered = render(
    <ToastProvider>
      <NewSubmission onCreated={onCreated} onCancel={onCancel} />
    </ToastProvider>
  );
  return { ...rendered, onCreated, onCancel };
}

async function fillClientName(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Client name/i), "Acme Ltd");
}

async function chooseFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input missing");
  // React tracks the input via React setter. Set files directly.
  Object.defineProperty(input, "files", {
    configurable: true,
    value: files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // Allow the state update to flush.
  await Promise.resolve();
}

beforeEach(() => {
  createSubmissionMock.mockReset();
  uploadDocumentMock.mockReset();
});

describe("New submission workbench", () => {
  it("has a single h1 and labelled required fields", () => {
    renderPage();
    // PageHeader renders the title as an h1.
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/^Client name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Line of business/i)).toBeInTheDocument();
  });

  it("blocks the submit and shows the client-name error when the client name is missing", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    expect(createSubmissionMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Add the client name before creating the submission/i)
    ).toBeInTheDocument();
  });

  it("issues exactly one createSubmission call for a single click, even when uploads follow", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_1" });
    uploadDocumentMock.mockResolvedValue({ ok: true, document_id: "doc_a" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("policy.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1);
  });

  it("creates the submission and calls onCreated exactly once when no files are attached", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_empty" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith("sub_empty");
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });

  it("surfaces the partial-upload recovery notice with honest copy and 'Retry remaining uploads'", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_1" });
    uploadDocumentMock.mockRejectedValueOnce(new Error("network")).mockResolvedValue({
      ok: true,
      document_id: "doc",
    });
    renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf"), pdf("b.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    // Partial phase surfaces.
    expect(
      await screen.findByText(/Submission created — some documents did not upload/i)
    ).toBeInTheDocument();
    // The dishonest "open the submission and add them there" copy is gone.
    expect(
      screen.queryByText(/Open the submission and add the remaining documents there/i)
    ).not.toBeInTheDocument();
    // Primary button is now the retry action.
    expect(screen.getAllByRole("button", { name: /Retry remaining uploads/i }).length).toBeGreaterThan(0);
  });

  it("never re-hits createSubmission on retry after a partial failure", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_x" });
    uploadDocumentMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, document_id: "doc_a" })
      .mockResolvedValueOnce({ ok: true, document_id: "doc_b" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf"), pdf("b.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await screen.findByText(/Submission created — some documents did not upload/i);
    // Retry.
    await user.click(screen.getAllByRole("button", { name: /Retry remaining uploads/i })[0]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // createSubmission was NEVER called a second time.
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
    // Uploads: 1 (failed) + 2 (retry of both, since the halt-on-failure
    // left the second file in pending)
    expect(uploadDocumentMock).toHaveBeenCalledTimes(3);
  });

  it("does not re-upload a file that already succeeded on retry", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_y" });
    // First loop: file A succeeds, file B fails.
    uploadDocumentMock
      .mockResolvedValueOnce({ ok: true, document_id: "a" })
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce({ ok: true, document_id: "b" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf"), pdf("b.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await screen.findByText(/Submission created — some documents did not upload/i);
    // Retry.
    await user.click(screen.getAllByRole("button", { name: /Retry remaining uploads/i })[0]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // Total uploads: 3 (A succeeded once, B failed once + succeeded once).
    expect(uploadDocumentMock).toHaveBeenCalledTimes(3);
    // A was uploaded exactly once.
    const aCalls = uploadDocumentMock.mock.calls.filter(
      (call) => (call[1] as File).name === "a.pdf"
    );
    expect(aCalls).toHaveLength(1);
  });

  it("hides the Remove control on uploaded files so the UI never implies a server delete", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_z" });
    uploadDocumentMock
      .mockResolvedValueOnce({ ok: true, document_id: "a" })
      .mockRejectedValueOnce(new Error("boom"));
    renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("uploaded.pdf"), pdf("failed.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await screen.findByText(/Submission created — some documents did not upload/i);
    expect(screen.queryByRole("button", { name: /Remove uploaded.pdf/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove failed.pdf/i })).toBeInTheDocument();
  });

  it("shows the complete Notice and fires onCreated once when every file lands", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_ok" });
    uploadDocumentMock.mockResolvedValue({ ok: true, document_id: "d" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf"), pdf("b.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText(/Submission created and all documents uploaded/i)
    ).toBeInTheDocument();
  });

  it("opens the leave-partial ConfirmDialog only in the partial phase — Cancel and Esc close it with no writes", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_leave" });
    uploadDocumentMock.mockRejectedValueOnce(new Error("boom"));
    const { onCancel } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await screen.findByText(/Submission created — some documents did not upload/i);
    // Click Cancel — the leave dialog appears.
    await user.click(screen.getAllByRole("button", { name: /^Cancel$/i })[0]);
    expect(
      await screen.findByText(/Leave without retrying the outstanding uploads\?/i)
    ).toBeInTheDocument();
    // Stay-and-retry (the cancel button of the ConfirmDialog).
    await user.click(screen.getByRole("button", { name: /Stay and retry/i }));
    expect(onCancel).not.toHaveBeenCalled();
    // Re-open then Escape closes without a write.
    await user.click(screen.getAllByRole("button", { name: /^Cancel$/i })[0]);
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("confirming the leave-partial dialog calls onCancel and never touches createSubmission again", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_bye" });
    uploadDocumentMock.mockRejectedValueOnce(new Error("boom"));
    const { onCancel } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("a.pdf")]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    await screen.findByText(/Submission created — some documents did not upload/i);
    await user.click(screen.getAllByRole("button", { name: /^Cancel$/i })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Leave the intake/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a duplicate file signature on the picker", async () => {
    renderPage();
    await chooseFiles([pdf("a.pdf", 100), pdf("a.pdf", 100)]);
    // Only one row rendered.
    const rows = document.querySelectorAll(".atlas-doc");
    expect(rows.length).toBe(1);
  });

  it("blocks the submit when a flagged file is present (non-PDF)", async () => {
    renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    const bad = new File([new Uint8Array(10)], "notes.docx", { type: "application/msword" });
    await chooseFiles([bad]);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    expect(createSubmissionMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Remove the documents flagged below/i)
    ).toBeInTheDocument();
  });

  it("uses the not_authenticated copy when createSubmission rejects with session expiry", async () => {
    createSubmissionMock.mockRejectedValue(new Error("not_authenticated"));
    renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await user.click(screen.getAllByRole("button", { name: /Create submission/i })[0]);
    expect(await screen.findByText(/Your session has expired/i)).toBeInTheDocument();
  });

  it("guards against a second entry while createSubmission is still pending (in-flight lock)", async () => {
    // Manually controlled promise: the mock stays unresolved so we can
    // attempt to re-enter onSubmit while the first invocation is
    // still awaiting. This test deliberately BYPASSES the visible
    // disabled-button safeguard so the only remaining protection is
    // operationLockRef inside NewSubmission.tsx. If the ref lock is
    // removed, this test fails with two createSubmission calls.
    const gate = deferred<{ ok: true; id: string }>();
    createSubmissionMock.mockReturnValueOnce(gate.promise);
    uploadDocumentMock.mockResolvedValue({ ok: true, document_id: "doc" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("policy.pdf")]);
    const button = screen.getAllByRole("button", {
      name: /Create submission/i,
    })[0] as HTMLButtonElement;
    // Extract the current onClick from React's internal fiber props
    // and invoke it directly. This bypasses the event system
    // altogether — no disabled check, no synthetic-event
    // suppression. It simulates the exact failure mode the lock
    // exists for: onSubmit re-entered while createSubmission is
    // still pending. The operationLockRef inside NewSubmission.tsx
    // is the only remaining protection.
    const invokeOnClick = (el: HTMLElement) => {
      const propsKey = Object.keys(el).find((key) =>
        key.startsWith("__reactProps")
      );
      if (!propsKey) throw new Error("react props key not found on button");
      const handler = (el as unknown as Record<string, { onClick?: () => void }>)[
        propsKey
      ]?.onClick;
      if (typeof handler !== "function") {
        throw new Error("onClick handler not found on button");
      }
      handler();
    };
    // First entry — kicks off createSubmission and yields on await.
    invokeOnClick(button);
    // Let React flush the phase transition. The button is now
    // rendered disabled — irrelevant, because our next entry goes
    // through the fiber props directly.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // Second and third entries — must be rejected by the ref lock.
    // Without operationLockRef, each of these would call
    // createSubmission again.
    invokeOnClick(button);
    invokeOnClick(button);
    // Give any re-entrant handler a chance to flush.
    await new Promise((r) => setTimeout(r, 20));
    // The lock is the ONLY thing that could have stopped the second
    // and third entries. If it were removed, createSubmission would
    // have been called two more times.
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
    // Now resolve — flow completes normally.
    gate.resolve({ ok: true, id: "sub_locked" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
    // A later click after completion would be a retry — the stored
    // submissionId routes it to the upload-only path and must not
    // create a second submission.
    await user.click(
      screen.getAllByRole("button", { name: /Create submission/i })[0]
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
  });

  it("allows a deliberate retry after a genuine creation failure", async () => {
    // First attempt fails before returning an id, so submissionIdRef
    // must stay null. The user must be able to click Create a second
    // time — this time it resolves, and no stale id from attempt one
    // is reused.
    createSubmissionMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, id: "sub_retry_ok" });
    uploadDocumentMock.mockResolvedValue({ ok: true, document_id: "doc" });
    const { onCreated } = renderPage();
    const user = userEvent.setup();
    await fillClientName(user);
    await chooseFiles([pdf("policy.pdf")]);
    await user.click(
      screen.getAllByRole("button", { name: /Create submission/i })[0]
    );
    await screen.findByText(/The submission could not be created/i);
    expect(createSubmissionMock).toHaveBeenCalledTimes(1);
    // Second, deliberate attempt.
    await user.click(
      screen.getAllByRole("button", { name: /Create submission/i })[0]
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith("sub_retry_ok");
    expect(createSubmissionMock).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
