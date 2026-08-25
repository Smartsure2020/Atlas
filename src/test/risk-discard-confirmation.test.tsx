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
import { render, screen, act, within } from "@testing-library/react";
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
    extraction?: ExtractionRecord;
  } = {}
) {
  const onSave = over.onSave ?? vi.fn().mockResolvedValue(undefined);
  const result = render(
    <RiskInformationPanel
      submissionId="sub_risk_discard"
      extraction={over.extraction ?? extractionRecord()}
      canWrite={over.canWrite ?? true}
      canManage={over.canManage ?? true}
      extracting={false}
      onExtract={() => {}}
      onSave={onSave}
    />
  );
  return { ...result, onSave };
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
});
