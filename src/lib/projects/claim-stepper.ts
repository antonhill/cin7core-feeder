// Orientation strip for the claim preparation form (UX-006 PR f). Pure and display-only: it is derived from state the form already holds,
// never blocks or authorises anything, and a step is complete only because the data says so (never because it was visited).
import type { PreviewState } from "./preview-staleness";

export type ClaimStepKey = "select" | "preview" | "draft" | "submit";
export type ClaimStepStatus = "done" | "next" | "attention" | "todo";
export type ClaimStep = { key: ClaimStepKey; label: string; status: ClaimStepStatus; text: string };

export type ClaimStepperInput = {
  chosenCount: number;
  preview: PreviewState;
  /** The draft claim created by this form since the selection was last cleared (its CURRENT status), or null. */
  savedClaimStatus: string | null;
  /** The viewer has a Submit button on that draft (claim action plan); false = someone else must submit it. */
  canSubmit?: boolean;
};

/** Closed without anything being written: such a draft counts as no claim at all. */
const CLOSED_NO_WRITE = new Set(["CANCELLED_BEFORE_WRITE", "FAILED_CONFIRMED_NO_WRITE"]);
const SUBMITTED_OR_LATER = new Set(["READY_FOR_APPROVAL", "APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED", "FAILED_UNCERTAIN"]);

export function claimSteps(i: ClaimStepperInput): ClaimStep[] {
  const saved = i.savedClaimStatus !== null && !CLOSED_NO_WRITE.has(i.savedClaimStatus);
  const submitted = saved && SUBMITTED_OR_LATER.has(i.savedClaimStatus as string);
  const selected = i.chosenCount > 0 || saved;
  const previewed = saved || (i.preview === "CURRENT" && i.chosenCount > 0);
  const stale = !saved && i.preview === "STALE" && i.chosenCount > 0;
  const base: Array<[ClaimStepKey, string, boolean, string, string]> = [
    ["select", "Select stages", selected, saved ? "Done" : `${i.chosenCount} selected`, "Not yet"],
    ["preview", "Preview", previewed, "Done", stale ? "Out of date" : "Not yet"],
    ["draft", "Save as draft", saved, "Saved", "Not yet"],
    ["submit", "Submit for approval", submitted, "Submitted", saved ? "Not yet" : "After saving"],
  ];
  let nextTaken = false;
  return base.map(([key, label, done, doneText, todoText]) => {
    if (done) return { key, label, status: "done" as const, text: doneText };
    const isStale = key === "preview" && stale;
    const status: ClaimStepStatus = isStale ? "attention" : !nextTaken ? "next" : "todo";
    nextTaken = true;
    return { key, label, status, text: isStale ? todoText : status === "next" ? (key === "submit" ? (i.canSubmit === false ? "Needs someone with edit access" : "Next: use Submit on the draft") : "Next") : todoText };
  });
}
