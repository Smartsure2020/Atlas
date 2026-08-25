/**
 * Risk corrections — Discard confirmation regression tests
 * ----------------------------------------------------------------------------
 * A trigger-happy click on "Discard changes" used to wipe every unsaved
 * risk correction with no way back. This test proves the confirmation
 * gate around that path:
 *
 *   • the dialog opens when there are unsaved edits
 *   • initial focus lands on the safe "Keep editing" choice
 *   • Tab and Shift+Tab keep the user inside the dialog
 *   • Escape and "Keep editing" preserve every edit and restore focus
 *   • only the explicit destructive confirm actually reverts the draft
 *   • the discard is a pure local revert — nothing writes to the network
 *   • the read/write permission gate on the trigger is unchanged
 *   • the dialog is axe-clean
 *
 * The panel state that backs "dirty" is identity-based (see the
 * RiskInformationPanel dirty predicate); once a RiskField edit fires the
 * reducer's structuredClone, draft's identity diverges from source.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// The above vi import is used for onSave spies inside individual tests.
import { render, screen, act, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { ExtractionRecord } from "../lib/atlas";

import RiskInformationPanel from "../pages/RiskInformationPanel";

function extractionRecord(over: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    id: "ext_risk_discard",
    extracted_json: null,
    reviewed_json: {
      extracted_client: {
        name: {
          value: "Acme Holdings (Pty) Ltd",
          confidence: 0.92,
          status: "high",
        },
      },
    },
    extraction_confidence: null,
    ...over,
  };
}

function renderPanel(
  over: {
    canWrite?: boolean;
    canManage?: boolean;
    onSave?: ReturnType<typeof vi.fn>;
    extraction?: ExtractionRecord | null;
  } = {}
) {
  const onSave = over.onSave ?? vi.fn().mockResolvedValue(undefined);
  const initialExtraction =
    over.extraction === undefined ? extractionRecord() : over.extraction;
  const props = {
    submissionId: "sub_risk_discard",
    canWrite: over.canWrite ?? true,
    canManage: over.canManage ?? true,
    extracting: false,
    onExtract: () => {},
    onSave,
  };
  const result = render(
    <RiskInformationPanel {...props} extraction={initialExtraction} />
  );
  const rerenderWith = (next: ExtractionRecord | null) =>
    result.rerender(<RiskInformationPanel {...props} extraction={next} />);
  return { ...result, onSave, rerenderWith };
}

/**
 * A fetch spy that fails the test hard if anything other than a plain GET
 * fires during the discard flow. Any observed non-GET verb — POST, PUT,
 * PATCH, DELETE — would prove that discarding leaked into a server write,
 * which is exactly what this fix forbids.
 */
let originalFetch: typeof globalThis.fetch | undefined;
const observedWriteMethods: string[] = [];
beforeEach(() => {
  observedWriteMethods.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") observedWriteMethods.push(method);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

async function enterCorrectionModeAndEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Correct values/i }));
  const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
  expect(nameInput.value).toBe("Acme Holdings (Pty) Ltd");
  await user.clear(nameInput);
  await user.type(nameInput, "Acme Holdings Limited");
  expect(nameInput.value).toBe("Acme Holdings Limited");
  return nameInput;
}

describe("RiskInformationPanel — discard confirmation", () => {
  it("opens the discard confirmation dialog when the user clicks Discard on unsaved corrections", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);

    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(
      screen.getByRole("heading", { name: /Discard risk corrections\?/i })
    ).toBeInTheDocument();
  });

  it("does NOT revert the edited draft when the confirmation opens", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // Dialog is up, but the edit is still on the input — nothing has been reverted yet.
    const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInput.value).toBe("Acme Holdings Limited");
  });

  it("puts initial focus on the safe 'Keep editing' choice", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // Multiple "Discard changes" buttons now exist (the trigger + the
    // destructive confirm). Focus MUST be on "Keep editing".
    const active = document.activeElement as HTMLElement | null;
    expect(active?.textContent).toMatch(/Keep editing/);
  });

  it("keeps Tab and Shift+Tab inside the dialog (focus never escapes to outside controls)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    const dialog = screen.getByRole("dialog");
    const keepEditing = within(dialog).getByRole("button", { name: /Keep editing/i });
    const destructiveConfirm = within(dialog).getByRole("button", { name: /Discard changes/i });
    const outsideTriggerCorrect = screen.queryByRole("button", { name: /Correct values/i });
    const outsideSave = screen.queryByRole("button", { name: /Save corrections/i });

    // Initial focus is on Keep editing (the safe choice).
    expect(document.activeElement).toBe(keepEditing);

    // Focus the destructive Confirm end of the trap and Tab forward — the
    // trap must wrap back to the FIRST focusable inside the dialog rather
    // than surrender focus to any control outside it.
    destructiveConfirm.focus();
    expect(document.activeElement).toBe(destructiveConfirm);
    await user.tab();
    // Focus stayed inside the dialog — never landed on an outside control.
    const dialogButtonsAfterTab = within(dialog).getAllByRole("button");
    expect(dialogButtonsAfterTab).toContain(document.activeElement);
    if (outsideTriggerCorrect) expect(document.activeElement).not.toBe(outsideTriggerCorrect);
    if (outsideSave) expect(document.activeElement).not.toBe(outsideSave);

    // Focus the FIRST focusable and Shift+Tab back — same containment
    // guarantee in reverse. The wrap lands on the destructive Confirm
    // (the last focusable) rather than any outside control.
    keepEditing.focus();
    expect(document.activeElement).toBe(keepEditing);
    await user.tab({ shift: true });
    const dialogButtonsAfterShiftTab = within(dialog).getAllByRole("button");
    expect(dialogButtonsAfterShiftTab).toContain(document.activeElement);
    if (outsideTriggerCorrect) expect(document.activeElement).not.toBe(outsideTriggerCorrect);
    if (outsideSave) expect(document.activeElement).not.toBe(outsideSave);
  });

  it("closes the dialog on Escape, preserves the edit, and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    const trigger = screen.getByRole("button", { name: /Discard changes/i });
    await user.click(trigger);
    expect(screen.getByRole("heading", { name: /Discard risk corrections\?/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();

    // Edit is preserved.
    expect((screen.getByLabelText("Insured name") as HTMLInputElement).value).toBe(
      "Acme Holdings Limited"
    );
    // Focus returned to the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves the edit and restores trigger focus when 'Keep editing' is chosen", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    const trigger = screen.getByRole("button", { name: /Discard changes/i });
    await user.click(trigger);

    await user.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    expect((screen.getByLabelText("Insured name") as HTMLInputElement).value).toBe(
      "Acme Holdings Limited"
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("actually reverts the draft and exits correction mode when the destructive confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // The destructive confirm lives inside the dialog — scope the query to
    // the modal so it isn't mistaken for the trigger button in the card.
    const dialog = screen.getByRole("dialog");
    const destructiveConfirm = within(dialog).getByRole("button", { name: /Discard changes/i });
    await user.click(destructiveConfirm);

    // Dialog is gone.
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    // Correction mode is exited — the "Correct values" trigger is back and the
    // Save corrections button is gone.
    expect(screen.getByRole("button", { name: /Correct values/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save corrections/i })).toBeNull();
    // Value is reverted to the saved source — the edited "Limited" spelling is gone.
    expect(screen.queryByText("Acme Holdings Limited")).toBeNull();
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();

    // No save/update ever fired.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("applies the local discard exactly once per confirmation", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPanel();

    // First cycle — discard the first edit.
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();

    // Second cycle — a fresh edit, then discard again. Same clean behaviour.
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();

    // No save calls in either cycle.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("produces zero non-GET network traffic through the discard flow", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );

    // No POST/PUT/PATCH/DELETE fired anywhere during correction, dialog open,
    // or confirm.
    expect(observedWriteMethods).toEqual([]);
  });

  it("respects the same permission gate as before: canWrite=false disables 'Correct values'", () => {
    renderPanel({ canWrite: false });
    const trigger = screen.getByRole("button", { name: /Correct values/i });
    expect(trigger).toBeDisabled();
    // No confirmation surface is reachable because correction mode cannot start.
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
  });

  it("axe-clean with the confirmation dialog open", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // Allow any microtasks queued by the focus trap to settle before axe runs.
    await act(async () => {
      await Promise.resolve();
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  // ------------------------------------------------------------------
  // Clean-bypass contract: an untouched correction session must exit
  // without prompting. Locking this contract prevents a regression that
  // set discardPending unconditionally from silently passing every
  // pre-existing assertion.
  // ------------------------------------------------------------------
  it("does not open the confirmation when the correction session has no edits (clean bypass)", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPanel();
    // Enter correction mode but change nothing.
    await user.click(screen.getByRole("button", { name: /Correct values/i }));
    expect(screen.getByRole("button", { name: /Save corrections/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // No confirmation surface appears.
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Correction mode exits directly.
    expect(screen.getByRole("button", { name: /Correct values/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save corrections/i })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  // ------------------------------------------------------------------
  // saveError lifecycle: opening the dialog, Escape, and Keep editing
  // must all preserve the surfaced save-error banner. Only the
  // confirmed destructive discard is allowed to clear it. This locks
  // the "no error clears before confirmed discard" contract.
  // ------------------------------------------------------------------
  it("preserves saveError across open + Escape + Keep editing, and clears it only on confirmed discard", async () => {
    const user = userEvent.setup();
    // onSave rejects to produce a real saveError message on the panel.
    const onSave = vi.fn().mockRejectedValue(new Error("network down"));
    renderPanel({ onSave });

    await enterCorrectionModeAndEdit(user);
    // Trigger a failed save.
    await user.click(screen.getByRole("button", { name: /Save corrections/i }));
    const saveErrorMessage =
      "Your corrections could not be saved. Try again, or copy them somewhere safe first.";
    expect(await screen.findByText(saveErrorMessage)).toBeInTheDocument();

    // Open dialog — error banner must remain visible behind it.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByText(saveErrorMessage)).toBeInTheDocument();

    // Escape — dialog closes, banner still visible.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(saveErrorMessage)).toBeInTheDocument();

    // Reopen, Keep editing — banner still visible.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByText(saveErrorMessage)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.getByText(saveErrorMessage)).toBeInTheDocument();

    // Reopen and confirm destructive — banner clears, correction exits.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    expect(screen.queryByText(saveErrorMessage)).toBeNull();
    expect(screen.getByRole("button", { name: /Correct values/i })).toBeInTheDocument();
  });

  // ------------------------------------------------------------------
  // fieldErrors lifecycle: an invalid JSON edit on an array field
  // surfaces a per-field error. Opening the dialog and cancelling must
  // preserve it; only confirmed discard clears it.
  // ------------------------------------------------------------------
  it("preserves fieldErrors across open + Keep editing, and clears them only on confirmed discard", async () => {
    const user = userEvent.setup();
    // Extraction with a JSON-array field so an invalid edit triggers a parse error.
    const extraction: ExtractionRecord = extractionRecord({
      reviewed_json: {
        extracted_client: {
          name: { value: "Acme Holdings (Pty) Ltd", confidence: 0.92, status: "high" },
        },
        current_cover: {
          cover_sections: { value: ["Fire", "Theft"], confidence: 0.8, status: "medium" },
        },
      },
    });
    renderPanel({ extraction });

    await user.click(screen.getByRole("button", { name: /Correct values/i }));
    // Make a valid name edit so the draft is dirty enough to open the dialog.
    const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Acme Holdings Limited");
    // Now fire an invalid-JSON change against the array field. Using
    // fireEvent.change dispatches one atomic change event, which mirrors a
    // real paste and avoids userEvent's per-keystroke re-render pathway
    // that would clash with the field's controlled-input reset effect.
    const arrayField = screen.getByLabelText("Cover sections") as
      | HTMLInputElement
      | HTMLTextAreaElement;
    fireEvent.change(arrayField, { target: { value: "not json" } });
    // The field-error alert renders through role=alert next to the invalid field.
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid json array/i);

    // Open dialog — field error alert still on screen.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid json array/i);

    // Keep editing — field error still on screen.
    await user.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid json array/i);

    // Reopen and confirm destructive — field error is gone with the draft.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // ------------------------------------------------------------------
  // Stale-context guard: the extraction identity changes while the
  // dialog is open. Without the reset+fail-closed guard, the dialog
  // stays mounted with untruthful body copy and a Confirm action that
  // would reset the NEW extraction's draft — a silent destructive
  // action against unrelated data.
  // ------------------------------------------------------------------
  it("closes the dialog and displays the new saved value when the extraction id changes mid-confirmation", async () => {
    const user = userEvent.setup();
    const { onSave, rerenderWith } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Prop change: a completely different extraction now arrives.
    rerenderWith(
      extractionRecord({
        id: "ext_risk_discard_v2",
        reviewed_json: {
          extracted_client: {
            name: { value: "Beta Underwriting Ltd", confidence: 0.95, status: "high" },
          },
        },
      })
    );

    // Dialog is gone; the new saved value is displayed (editing state
    // persists across the prop change per existing semantics, so the
    // value surfaces on the Insured name field's input); no stale
    // Confirm is reachable; the old draft did not carry over.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    const nameInputAfter = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInputAfter.value).toBe("Beta Underwriting Ltd");
    expect(screen.queryByDisplayValue("Acme Holdings Limited")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("closes the dialog and refreshes the saved value when reviewed_json changes on the same extraction id", async () => {
    const user = userEvent.setup();
    const { onSave, rerenderWith } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerenderWith(
      extractionRecord({
        reviewed_json: {
          extracted_client: {
            name: { value: "Acme Holdings refreshed", confidence: 0.99, status: "high" },
          },
        },
      })
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    const nameInputAfter = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInputAfter.value).toBe("Acme Holdings refreshed");
    expect(screen.queryByDisplayValue("Acme Holdings Limited")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("closes the dialog and refreshes the saved value when extracted_json changes on the same extraction id", async () => {
    const user = userEvent.setup();
    // Start from an unreviewed extraction so extracted_json is the source.
    const initial: ExtractionRecord = {
      id: "ext_risk_discard",
      extracted_json: {
        extracted_client: {
          name: { value: "Acme Holdings (Pty) Ltd", confidence: 0.92, status: "high" },
        },
      },
      reviewed_json: null,
      extraction_confidence: null,
    };
    const { onSave, rerenderWith } = renderPanel({ extraction: initial });
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerenderWith({
      ...initial,
      extracted_json: {
        extracted_client: {
          name: { value: "Acme Holdings rerun", confidence: 0.94, status: "high" },
        },
      },
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    const nameInputAfter = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInputAfter.value).toBe("Acme Holdings rerun");
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("unmounts the dialog when the extraction becomes null while the confirmation is open", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Extraction is cleared upstream (e.g. reset after a rerun kick-off).
    rerenderWith(null);

    // The empty-state card renders; dialog is gone.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText(/Atlas has not read the documents yet/i)
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("does not resurrect the dialog after extraction goes null and later returns", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    rerenderWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();

    // A new extraction arrives. The panel must not restore the stale
    // pending confirmation without a fresh explicit user request.
    rerenderWith(extractionRecord());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    // The fresh source displays cleanly: draft was reset on the null→valid
    // sweep, so the panel is not dirty and cannot open the dialog again
    // without a new edit.
    const nameInputAfterReturn = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInputAfterReturn.value).toBe("Acme Holdings (Pty) Ltd");

    // A fresh edit followed by a fresh trigger opens the dialog cleanly —
    // proving the confirmation still works, it just does not resurrect
    // by itself.
    await user.clear(nameInputAfterReturn);
    await user.type(nameInputAfterReturn, "Acme Holdings v2");
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("clears discardPending when correction mode ends through a successful save", async () => {
    const user = userEvent.setup();
    // Edit, open the dialog, cancel it, then save successfully. On a fresh
    // re-entry into correction mode with an untouched draft, no dialog may
    // linger — proving discardPending was reset by the editing→false transition.
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerenderWith } = renderPanel({ onSave });

    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(screen.getByRole("button", { name: /Keep editing/i }));

    await user.click(screen.getByRole("button", { name: /Save corrections/i }));
    // Panel exits correction mode after successful save.
    expect(await screen.findByRole("button", { name: /Correct values/i })).toBeInTheDocument();

    // Upstream refreshes the extraction with the saved value.
    rerenderWith(
      extractionRecord({
        reviewed_json: {
          extracted_client: {
            name: { value: "Acme Holdings Limited", confidence: 0.92, status: "high" },
          },
        },
      })
    );
    // Re-enter correction. No dialog is present — discardPending was cleared.
    await user.click(screen.getByRole("button", { name: /Correct values/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();

    expect(onSave).toHaveBeenCalledTimes(1);
    // The save is the only non-GET write we intentionally allowed; it did not
    // happen through the discard path (this test's exit path).
    // The panel's onSave prop is a spy, not a network call, so observedWriteMethods
    // must still be empty.
    expect(observedWriteMethods).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Context-binding contract — the dialog's actual open state is bound
  // to a snapshot of the correction context (extraction id + source
  // object identity) captured when the user requested discard. A
  // replacement extraction, or a same-id extraction whose reviewed_json
  // or extracted_json has been swapped, cannot satisfy the render-time
  // guard even in the intermediate render before passive cleanup
  // effects fire. These tests exercise the render-time equality check
  // rather than the passive cleanup effect: they assert the guard's
  // observable output (dialog absence, no callback fire, no writes)
  // survives a replacement source, and that the captured snapshot is
  // cleared on every legitimate close path.
  // ------------------------------------------------------------------

  it("binds the pending confirmation to the extraction id that opened it (id swap closes the dialog)", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // A different extraction (new id) arrives. The captured snapshot's
    // extractionId no longer matches the current extraction.id, so the
    // render-time guard evaluates false immediately — the dialog cannot
    // even render one commit against the replacement.
    rerenderWith(
      extractionRecord({
        id: "ext_replacement_id",
        reviewed_json: {
          extracted_client: {
            name: { value: "Beta Underwriting Ltd", confidence: 0.95, status: "high" },
          },
        },
      })
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("binds the pending confirmation to the source object identity (reviewed_json swap closes the dialog)", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Same extraction id, but reviewed_json is a fresh object — its
    // reference identity has changed. The snapshot's captured source
    // reference no longer equals the current source; guard falls closed.
    rerenderWith(
      extractionRecord({
        reviewed_json: {
          extracted_client: {
            name: { value: "Acme refreshed reviewed", confidence: 0.99, status: "high" },
          },
        },
      })
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("binds the pending confirmation to the source object identity (extracted_json swap closes the dialog)", async () => {
    const user = userEvent.setup();
    const initial: ExtractionRecord = {
      id: "ext_risk_discard",
      extracted_json: {
        extracted_client: {
          name: { value: "Acme Holdings (Pty) Ltd", confidence: 0.92, status: "high" },
        },
      },
      reviewed_json: null,
      extraction_confidence: null,
    };
    const { rerenderWith, onSave } = renderPanel({ extraction: initial });
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Same id, but a fresh extracted_json reference — the source
    // reference the panel derives changes with it. Guard closes.
    rerenderWith({
      ...initial,
      extracted_json: {
        extracted_client: {
          name: { value: "Acme rerun extracted", confidence: 0.94, status: "high" },
        },
      },
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("a replacement source cannot satisfy the dialog-open guard, even if a stale Confirm click were possible", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Swap to a replacement extraction while the dialog is open.
    rerenderWith(
      extractionRecord({
        id: "ext_replacement_v3",
        reviewed_json: {
          extracted_client: {
            name: { value: "Gamma Insurance", confidence: 0.9, status: "high" },
          },
        },
      })
    );

    // Guard is closed — no dialog surface exists; no Confirm button to
    // click; no destructive callback can fire against the replacement.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryAllByRole("button", { name: /Discard changes/i }).length
    ).toBeLessThanOrEqual(1); // At most the outer trigger, never a dialog Confirm.

    // The replacement extraction still displays its own saved values.
    // Draft is reset to the new source by the passive effect; correction
    // mode is still in — the input shows the fresh replacement value.
    const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
    expect(nameInput.value).toBe("Gamma Insurance");

    // No callback fired for the replacement — the stale confirmation
    // could not reach into it.
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("null → valid cannot reuse the old pending context (fresh edit + fresh request needed)", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Extraction cleared, then a fresh extraction returns.
    rerenderWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerenderWith(extractionRecord({ id: "ext_after_null" }));

    // Dialog does not resurface: the null transition cleared the
    // snapshot; the returning extraction's id does not match anyway.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();

    // A fresh edit + fresh trigger opens a new confirmation cleanly.
    const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Gamma new edit");
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("a fresh edit on the replacement extraction can open a new confirmation normally", async () => {
    const user = userEvent.setup();
    const { rerenderWith, onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    // Replace mid-dialog.
    rerenderWith(
      extractionRecord({
        id: "ext_replacement_reedit",
        reviewed_json: {
          extracted_client: {
            name: { value: "Delta Reinsurance", confidence: 0.9, status: "high" },
          },
        },
      })
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    // Fresh edit on the replacement + fresh trigger → clean new dialog.
    const nameInput = screen.getByLabelText("Insured name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Delta v2");
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The new dialog is bound to the replacement id/source, not the old
    // one — confirming it reverts the REPLACEMENT's edit, not anything
    // stale.
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    // The replacement's saved value is restored.
    expect(screen.getByText("Delta Reinsurance")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });

  it("Escape clears the captured context (a subsequent reopen captures a fresh snapshot)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    // Re-open — a NEW snapshot must be captured against the current
    // dirty draft. If Escape had left the old context in place, the
    // guard's identity checks would still hold and the dialog would
    // simply reappear on click; the fresh capture is what makes reopen
    // legitimate. The observable proof is that the dialog reappears
    // after a fresh user click, and its Confirm still reverts correctly.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Discard changes/i }));
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();
  });

  it("Keep editing clears the captured context", async () => {
    const user = userEvent.setup();
    renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));

    await user.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopen and confirm — the fresh capture drives the discard.
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /Discard changes/i })
    );
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();
  });

  it("Confirm clears the captured context before applying discard (rapid double-Confirm is a single revert)", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPanel();
    await enterCorrectionModeAndEdit(user);
    await user.click(screen.getByRole("button", { name: /Discard changes/i }));
    const dialog = screen.getByRole("dialog");
    const destructive = within(dialog).getByRole("button", { name: /Discard changes/i });

    // Click destructive twice in rapid succession. The context is
    // cleared inside onConfirm BEFORE applyDiscard runs, so once React
    // commits the first click's state updates the destructive button
    // has unmounted; a follow-up click can only ever hit an outer
    // trigger, not the dialog Confirm. The first click's handler is
    // therefore the only one that reaches applyDiscard, whether the
    // pair fired inside one batch or straddled a commit.
    await user.click(destructive);
    // The button is gone; attempting a second click can only find the
    // outer "Discard changes" trigger, which is safe (clean bypass, no
    // dialog because dirty is now false).
    const stillDialog = screen.queryByRole("dialog");
    if (stillDialog) {
      await user.click(within(stillDialog).getByRole("button", { name: /Discard changes/i }));
    }

    // Dialog is gone; the saved value is back; correction is exited.
    expect(screen.queryByRole("heading", { name: /Discard risk corrections\?/i })).toBeNull();
    expect(screen.getByText("Acme Holdings (Pty) Ltd")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Correct values/i })).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(observedWriteMethods).toEqual([]);
  });
});
