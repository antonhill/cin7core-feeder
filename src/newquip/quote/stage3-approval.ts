import { checkApproval } from "./workflow";

// SOLUTION BUILDER STAGE 3 CHECKLIST (pure). The "before you decide" list shows the five conditions `checkApproval` (the server's final-approval check) enforces, each evaluated
// by calling that SAME function with only that condition real and every other input neutral, so the rules are never restated here. Nothing here authorises or blocks anything:
// the Approve button keeps its own gates and the server re-checks everything. No figure is shown, so a viewer who may not see commercials learns nothing extra.
// The inputs are the page's live figures (readiness, and the total in cents rounded exactly as the server rounds the saved quotation: Math.round(subtotalExTax * 100)); the server judges the SAVED
// quotation, so an unsaved edit is called out by its own "No unsaved edits" row.

export type ApprovalCheckId = "ready" | "total" | "confirmed" | "signoff" | "amount" | "manager" | "saved";
export interface ApprovalCheckItem {
  id: ApprovalCheckId;
  label: string;
  met: boolean;
  /** The server's own message for an unmet condition (checkApproval's), or the existing unsaved-edits text. Null when met. */
  detail: string | null;
  /** Where the user fixes an unmet condition (a stage number), or null when it is fixed here. */
  fixStage: 1 | 2 | null;
}

export interface ApprovalChecklistInput {
  readinessState: "DRAFT" | "BLOCKED" | "READY";
  readinessReasons: readonly string[];
  /** The quote total (ex VAT) in cents, null when it is not available. */
  totalExVatCents: number | null;
  customerConfirmedCents: number | null;
  signoffHash: string | null;
  currentDraftHash: string;
  /** The editor holds unsaved edits (approval applies to the saved quotation). */
  dirty: boolean;
  /** The viewer has the Manager role (the Approve button needs it too; the server enforces it). */
  isManager: boolean;
  /** The page already shows the sign-off explanation (its existing Alert, also Approve's aria-describedby target) right below: the row then points to it instead of repeating it. */
  signoffExplainedBelow?: boolean;
}

const NEUTRAL = "neutral-hash"; // neutral inputs agree with each other (total 1 = confirmed 1, sign-off = draft hash) so a check sees only the one condition under test
export const UNSAVED_EDITS_MESSAGE = "Approval applies to the saved quotation, so unsaved changes must be saved or discarded first (see the warning below).";

export function deriveApprovalChecklist(i: ApprovalChecklistInput): ApprovalCheckItem[] {
  const readiness = { state: i.readinessState, reasons: [...i.readinessReasons] } as Parameters<typeof checkApproval>[0]["readiness"];
  const ready = { state: "READY", reasons: [] } as unknown as Parameters<typeof checkApproval>[0]["readiness"];
  const one = (id: ApprovalCheckId, label: string, over: Partial<Parameters<typeof checkApproval>[0]>, fixStage: 1 | 2 | null): ApprovalCheckItem => {
    const r = checkApproval({ readiness: ready, totalExVatCents: 1, customerConfirmedCents: 1, signoffHash: NEUTRAL, currentDraftHash: NEUTRAL, costing: { complete: true, reasons: [] }, ...over });
    return { id, label, met: r.ok, detail: r.ok ? null : r.error, fixStage };
  };
  const totalOk = i.totalExVatCents != null && i.totalExVatCents > 0;
  const items: ApprovalCheckItem[] = [
    one("ready", "The quote is READY", { readiness }, 2),
    one("total", "The quote has a contract value", { totalExVatCents: i.totalExVatCents, customerConfirmedCents: i.totalExVatCents }, 2),
    one("confirmed", "The customer's confirmation is recorded", { customerConfirmedCents: i.customerConfirmedCents == null ? null : 1 }, 2),
    // The sign-off must be the Estimator's on THIS content: both the "never signed" and the "stale" messages come from checkApproval.
    one("signoff", "The Estimator's sign-off matches the current quotation", { signoffHash: i.signoffHash, currentDraftHash: i.currentDraftHash }, null),
    // The amount check only means something once there is a total and a confirmation to compare.
    totalOk && i.customerConfirmedCents != null
      ? one("amount", "The confirmed amount equals the quote total", { totalExVatCents: i.totalExVatCents, customerConfirmedCents: i.customerConfirmedCents }, 2)
      : { id: "amount", label: "The confirmed amount equals the quote total", met: false, detail: "Needs a contract value and the customer's recorded confirmation first.", fixStage: 2 },
  ];
  items.push({ id: "manager", label: "You have the Manager role", met: i.isManager, detail: i.isManager ? null : "Only a Manager can make the final decision.", fixStage: null });
  if (i.signoffExplainedBelow) { const so = items.find((x) => x.id === "signoff")!; if (!so.met) so.detail = "Explained in the note below."; }
  if (i.dirty) items.push({ id: "saved", label: "No unsaved edits", met: false, detail: UNSAVED_EDITS_MESSAGE, fixStage: null });
  return items;
}

export const approvalChecklistMet = (items: readonly ApprovalCheckItem[]) => items.every((x) => x.met);
