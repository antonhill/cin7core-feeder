import type { StepStatus } from "@/components/ui/step-rail-model";
import { formatZarCents } from "@/lib/format-money";
import type { Wizard, WizardRole, WizardStep } from "./wizard-contract";

// STAGE 2 (ESTIMATOR REVIEW) AND STAGE 3 (MANAGER APPROVAL) ON THE WIZARD CONTRACT (pure). Same step shape as Stage 1 (wizard-contract.ts: {id,label,owner,status,access,blockedBy,blockKind}),
// same helpers (isPermitted, resolveEntryStep, currentStepId, toRailSteps). It imports no server action, no store and no React: it only CONSUMES facts the page already holds. It introduces NO
// business gate and changes no role check: the server still authorises every action. What it adds is who the work belongs to, what the viewer may open, and why a step is locked.
//
// STAGE 2 is the ESTIMATOR's: 1 Product lines & mapping review  2 Costs, margins & pricing exceptions  3 Final review  4 Sign-off or return. The Rep's submitted information is a read-only summary above
// the steps (not a step). A Rep draft can still be worked on by an Estimator for the mapping step only (the server already lets an Estimator edit mappings and price resolutions on a Rep draft);
// steps 2-4 are LOCKED until the Rep has submitted (a real state gate: sign-off needs ESTIMATOR_REVIEW). A Rep, a Manager and an Administrator observer inspect Stage 2 read-only.
// STAGE 3 is the MANAGER's: a signed-off summary and the decision. Nothing in it is editable; the Manager does not walk through editable steps.
//
// A step that does not exist for a viewer (the cost steps for someone without cost visibility) is access "hidden": absent, never disabled, and nothing about cost is derived for them.

export type Stage2WizardId = "mapping" | "costs" | "final" | "signoff";
export const STAGE2_WIZARD_IDS: readonly Stage2WizardId[] = ["mapping", "costs", "final", "signoff"];
export const STAGE2_WIZARD_LABEL: Record<Stage2WizardId, string> = { mapping: "Product lines & mapping review", costs: "Costs, margins & pricing exceptions", final: "Final review", signoff: "Sign-off or return" };
const OWNER2: Record<Stage2WizardId, WizardRole> = { mapping: "Estimator", costs: "Estimator", final: "Estimator", signoff: "Estimator" };
export const NOT_SUBMITTED_REASON = "The Rep has not submitted yet. Rep: submit the quotation to the Estimator (Stage 1, step 5) first.";

type QuoteStateName = "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";
export interface Stage2WizardInput {
  state: QuoteStateName;
  revision: number;
  roles: { rep: boolean; estimator: boolean; manager: boolean };
  canViewCommercials: boolean;
  signoff: "none" | "current" | "stale";
  /** The page has unsaved edits (saving them would make a current sign-off stale; approval and sign-off apply to the saved quotation). */
  dirty: boolean;
  /** The live calculation accepted the Stage 1 inputs (without it there are no lines to map). */
  calcValid: boolean;
  readiness: { state: "DRAFT" | "BLOCKED" | "READY"; reasons: readonly string[] };
  /** Open items only an Estimator/Manager can resolve (product mapping, package confirmation, a manual quotation price or its reason), already phrased. */
  mappingOpen: readonly string[];
  /** How many Rep-owned items are still open in Stage 1 (decides who is next while the quotation is a Rep draft). */
  repOpenCount: number;
  /** The cost step of deriveStage2Steps WITHOUT any acknowledgement (null when the viewer has no cost visibility). Its status is the data-derived one. */
  cost: { status: StepStatus; note?: string } | null;
  /** The viewer has marked the costing reviewed for THIS version (client-local; the page invalidates it on any change). */
  costAcknowledged: boolean;
  confirmedCents: number | null;
  totalCents: number | null;
  /** Costed lines with no cost (cost-visible viewers only; 0 or absent = the project cost is complete). */
  costMissingLines?: number;
  /** The SERVER's costing verdict (QuoteView.costing, cost-entitled callers only): when not complete the Costs step needs attention with its reason and sign-off is refused. */
  costingIncomplete?: boolean;
  costingReason?: string | null;
  /** Optional one-line summary of the open Estimator items by kind ("3 lines unmapped · 2 supplier quotes required"), used as the mapping step note. */
  mappingSummary?: string;
}

export type Stage2WizardStep = WizardStep<Stage2WizardId>;
export interface StageWizard<I extends string> extends Omit<Wizard<I>, "nextOwner"> {
  /** Who is responsible for the next action on the quotation right now (null when nothing is left to do). */
  nextOwner: WizardRole | null;
  /** One sentence for the viewer: what is happening and who has the next action. */
  statusLine: string;
}

export interface FinalReviewItem { id: "mapping" | "ready" | "costing" | "amount" | "saved"; label: string; met: boolean; detail: string | null }

/** The compact readiness checklist of the Final review step. Facts only; the buttons keep their own gates. */
export function deriveFinalReviewChecklist(i: Pick<Stage2WizardInput, "mappingOpen" | "readiness" | "cost" | "confirmedCents" | "totalCents" | "dirty" | "calcValid" | "costMissingLines" | "costingIncomplete" | "costingReason">): FinalReviewItem[] {
  const items: FinalReviewItem[] = [
    { id: "mapping", label: "Product lines are mapped and priced", met: i.calcValid && i.mappingOpen.length === 0, detail: !i.calcValid ? "The Rep's configuration is not complete yet." : i.mappingOpen.length === 0 ? null : `${i.mappingOpen[0]}${i.mappingOpen.length > 1 ? ` (+${i.mappingOpen.length - 1} more)` : ""}. Step 1.` },
    { id: "ready", label: "The quotation is READY", met: i.readiness.state === "READY", detail: i.readiness.state === "READY" ? null : (i.readiness.reasons[0] ?? "The quote must be READY (nothing outstanding) before it can be signed off.") },
  ];
  if (i.cost) {
    const ok = i.cost.status === "review" || i.cost.status === "complete";
    const missing = i.costMissingLines ?? 0;
    // ONE margin story: with incomplete project costs the check says so (attention), never "Met".
    if (missing > 0 || i.costingIncomplete) items.push({ id: "costing", label: missing > 0 ? `Costing figures: incomplete (${missing} line${missing === 1 ? " has" : "s have"} no cost)` : "Costing figures: incomplete", met: false, detail: `${i.costingReason ?? "Supplier costs are unresolved."} The margin shown is indicative (price-list basis). Sign-off and approval need costing complete.` });
    else items.push({ id: "costing", label: "Costing figures are available", met: ok, detail: ok ? "Check the Cin7 cost capture in step 2: it may still show incomplete, so review with care." : (i.cost.note ?? "The costing needs attention.") });
  }
  const both = i.confirmedCents != null && i.totalCents != null;
  items.push({ id: "amount", label: "The confirmed amount equals the quote total", met: both && i.confirmedCents === i.totalCents, detail: i.confirmedCents == null ? "No customer price confirmation is recorded." : i.totalCents == null ? "The quote total is not available yet." : i.confirmedCents === i.totalCents ? null : "The total changed after the customer confirmed it. Return it to the Rep to reconfirm." });
  if (i.dirty) items.push({ id: "saved", label: "No unsaved edits", met: false, detail: "Save or discard your edits first: the review applies to the saved quotation." });
  return items;
}

/** Why "Mark reviewed & continue" cannot be offered, in words (null when it can). Pure, so the page and the tests share the wording. */
export function finalReviewBlockText(i: { state: QuoteStateName; isEstimator: boolean; canViewCommercials: boolean; costStatus: StepStatus | null; costNote?: string; dirty: boolean }): string | null {
  if (!i.canViewCommercials) return null;
  if (!i.isEstimator) return "You can view the costing and margin, but only the Estimator can mark it reviewed.";
  if (i.state !== "ESTIMATOR_REVIEW") return "Marking the costing reviewed is available once the quote is in Estimator review.";
  if (i.costStatus === "attention") return `Resolve the costing items before marking reviewed. ${i.costNote ?? ""}`.trim();
  if (i.dirty) return "Save or discard your unsaved edits before marking the costing reviewed.";
  if (i.costStatus !== "review") return `The costing cannot be marked reviewed yet. ${i.costNote ?? ""}`.trim();
  return null;
}

export function deriveStage2Wizard(i: Stage2WizardInput): StageWizard<Stage2WizardId> {
  const final = i.state === "MANAGER_APPROVED_FINAL";
  const inReview = i.state === "ESTIMATOR_REVIEW";
  const repDraft = i.state === "REP_DRAFT";
  const returned = repDraft && i.revision > 1;
  const submitted = inReview || final;
  const estimator = i.roles.estimator;
  // Only an Estimator edits Stage 2, and only while the quotation is not final. Everyone else (Rep, Manager, Administrator observer) inspects it.
  const canEdit = estimator && !final;
  const signedCurrent = inReview && i.signoff === "current" && !i.dirty;

  const mapping: { status: StepStatus; note?: string } = !i.calcValid ? { status: "incomplete", note: "Waiting for the Rep's configuration" }
    : i.mappingOpen.length > 0 ? { status: canEdit ? "attention" : "incomplete", note: i.mappingSummary ?? `${i.mappingOpen[0]}${i.mappingOpen.length > 1 ? ` (+${i.mappingOpen.length - 1} more)` : ""}` }
    : { status: "complete" };

  const costNeeds = i.cost?.status === "attention" ? i.cost.note : undefined;
  const costs: { status: StepStatus; note?: string; counted?: boolean; statusLabel?: string } = !i.cost ? { status: "unavailable" }
    : final || signedCurrent ? { status: "complete" }
    : i.cost.status === "attention" ? { status: canEdit ? "attention" : "incomplete", note: costNeeds }
    : i.cost.status === "complete" ? { status: "complete" }
    // The figures are looked at here and the review is recorded in Final review: before the mark the label says "To review"; after it, "Reviewed" (counted with the Final review, never a check).
    : inReview && i.costAcknowledged && !i.dirty && i.cost.status === "review" ? { status: "review", counted: true, statusLabel: "Reviewed", note: `Reviewed in Final review (session only, not saved)${(i.costMissingLines ?? 0) > 0 ? `; ${n1(i.costMissingLines!, "line still has", "lines still have")} no cost` : ""}` }
    : (i.costMissingLines ?? 0) > 0 || i.costingIncomplete ? { status: canEdit ? "attention" : "incomplete", note: (i.costMissingLines ?? 0) > 0 ? `${n1(i.costMissingLines!, "line has", "lines have")} no cost` : (i.costingReason ?? "Costing is incomplete") }
    : { status: i.cost.status, ...(i.cost.status === "review" ? { statusLabel: "To review in Final review" } : {}), ...(i.cost.note ? { note: i.cost.note } : {}) };

  const blockers = deriveFinalReviewChecklist(i).filter((x) => x.id !== "saved" && !x.met);
  let finalStep: { status: StepStatus; note?: string; counted?: boolean; statusLabel?: string };
  if (final || signedCurrent) finalStep = { status: "complete" };
  else if (inReview && i.costAcknowledged && !i.dirty) finalStep = { status: "review", counted: true, statusLabel: "Reviewed", note: "Marked reviewed for this session only - not saved and not a sign-off" };
  else if (!repDraft && blockers.length > 0 && canEdit) finalStep = { status: "attention", note: blockers[0].detail ?? blockers[0].label };
  else finalStep = { status: "incomplete", ...(repDraft ? { note: "Waiting for the Rep to submit" } : {}) };

  let signoff: { status: StepStatus; note?: string };
  if (final) signoff = { status: "complete", note: "Approved" };
  else if (repDraft) signoff = { status: "incomplete", note: returned ? `Returned to the Rep (revision ${i.revision})` : "Waiting for the Rep to submit" };
  else if (i.signoff === "current" && i.dirty) signoff = { status: canEdit ? "attention" : "incomplete", note: "Unsaved edits: saving makes the sign-off stale" };
  else if (i.signoff === "current") signoff = { status: "complete", note: "Estimator sign-off is current" };
  else if (i.signoff === "stale") signoff = { status: canEdit ? "attention" : "incomplete", note: "The sign-off no longer matches the quotation" };
  else if (i.readiness.state !== "READY") signoff = { status: canEdit ? "attention" : "incomplete", note: "The quote must be READY before it can be signed off" };
  else signoff = { status: "incomplete", note: estimator ? "Awaiting your review" : "Awaiting Estimator review" };

  const content: Record<Stage2WizardId, { status: StepStatus; note?: string; counted?: boolean; statusLabel?: string }> = { mapping, costs, final: finalStep, signoff };
  const hiddenFor = (id: Stage2WizardId) => (id === "costs" || id === "final") && !i.canViewCommercials;

  const steps: Stage2WizardStep[] = STAGE2_WIZARD_IDS.map((id): Stage2WizardStep => {
    const c = content[id];
    const base = { id, label: STAGE2_WIZARD_LABEL[id], owner: OWNER2[id], status: c.status, ...(c.counted ? { counted: true } : {}), ...(c.statusLabel ? { statusLabel: c.statusLabel } : {}), ...(c.note ? { note: c.note } : {}) };
    if (hiddenFor(id)) return { ...base, status: "unavailable", access: "hidden", blockedBy: [] };
    if (!canEdit) return { ...base, access: "readonly", blockedBy: [] };
    // An Estimator on a Rep draft: only the mapping step is theirs yet. The rest wait for the Rep (a REAL gate: sign-off needs the quotation in Estimator review).
    if (repDraft && id !== "mapping") return { ...base, access: "locked", blockedBy: [NOT_SUBMITTED_REASON], blockKind: "server" };
    return { ...base, access: "edit", blockedBy: [] };
  });

  // Entry: the first incomplete step the viewer may act on; with a current sign-off the sign-off step (it shows the next-stage action); with nothing to act on, the first step they can open.
  const editable = steps.filter((s) => s.access === "edit");
  const entry = ((): Stage2WizardId => {
    if (editable.length === 0) return (steps.find((s) => s.access === "readonly") ?? steps[0]).id;
    if (signedCurrent) return "signoff";
    const open = editable.find((s) => s.status !== "complete" && s.counted !== true);
    return (open ?? editable[repDraft ? 0 : editable.length - 1]).id;
  })();

  // Who is next, and the sentence the viewer reads.
  const needsEstimatorFirst = repDraft && i.mappingOpen.length > 0 && i.repOpenCount === 0;
  let nextOwner: WizardRole | null;
  let statusLine: string;
  if (final) { nextOwner = null; statusLine = "Approved. Nothing is left in Stage 2."; }
  else if (repDraft) {
    if (needsEstimatorFirst) { nextOwner = "Estimator"; statusLine = estimator ? "The Rep is waiting on your mapping." : "The Rep is waiting on the Estimator's mapping. Next responsible role: Estimator."; }
    else { nextOwner = "Rep"; statusLine = i.roles.rep && !estimator && !i.roles.manager ? "Complete the Stage 1 submission. Next responsible role: Rep." : returned ? `Returned to the Rep (revision ${i.revision}). Next responsible role: Rep: reconfirm the amount with the customer, then submit again.` : "The Rep has not submitted yet. Next responsible role: Rep."; }
  } else if (i.signoff === "current" && !i.dirty) { nextOwner = "Manager"; statusLine = "Signed off by the Estimator. Next responsible role: Manager (Stage 3)."; }
  else { nextOwner = "Estimator"; statusLine = estimator ? "Your review: check the lines and costing, then sign off or return it. Next responsible role: Estimator." : "Submitted by the Rep. Next responsible role: Estimator."; }

  return { steps, entryStepId: entry, returned, submitted, nextOwner, statusLine };
}

// ── Stage 3 ──
export type Stage3WizardId = "summary" | "decision";
export const STAGE3_WIZARD_IDS: readonly Stage3WizardId[] = ["summary", "decision"];
export const STAGE3_WIZARD_LABEL: Record<Stage3WizardId, string> = { summary: "Signed-off summary", decision: "Approve or return" };
export interface Stage3WizardInput {
  state: QuoteStateName;
  revision: number;
  roles: { rep: boolean; estimator: boolean; manager: boolean };
  signoff: "none" | "current" | "stale";
  dirty: boolean;
}
export type Stage3WizardStep = WizardStep<Stage3WizardId>;

export function deriveStage3Wizard(i: Stage3WizardInput): StageWizard<Stage3WizardId> {
  const final = i.state === "MANAGER_APPROVED_FINAL";
  const inReview = i.state === "ESTIMATOR_REVIEW";
  const repDraft = i.state === "REP_DRAFT";
  const signed = inReview && i.signoff === "current";
  const manager = i.roles.manager;
  // The summary is read-only for every viewer, so it is always open. The decision is the Manager's: other roles read it. With the Rep it cannot be opened (a REAL gate: the server only decides a submitted quotation).
  const summaryStatus: StepStatus = final || signed ? "complete" : "incomplete";
  const decisionNote = final ? "Approved" : repDraft ? "Waiting for the Rep to submit" : i.signoff === "none" ? "Waiting for the Estimator's sign-off" : i.signoff === "stale" ? "The Estimator's sign-off is out of date" : i.dirty ? "Unsaved edits: save or discard first" : manager ? "Awaiting your decision" : "Awaiting the Manager's decision";
  const summary: Stage3WizardStep = { id: "summary", label: STAGE3_WIZARD_LABEL.summary, owner: "Estimator", status: summaryStatus, access: "readonly", blockedBy: [], note: final ? "Signed off and approved" : signed ? "Signed off by the Estimator" : repDraft ? "With the Rep" : "Not signed off yet" };
  const decision: Stage3WizardStep = repDraft
    ? { id: "decision", label: STAGE3_WIZARD_LABEL.decision, owner: "Manager", status: "incomplete", access: "locked", blockedBy: [NOT_SUBMITTED_REASON], blockKind: "server", note: decisionNote }
    : { id: "decision", label: STAGE3_WIZARD_LABEL.decision, owner: "Manager", status: final ? "complete" : "incomplete", access: !final && manager ? "edit" : "readonly", blockedBy: [], note: decisionNote };
  const nextOwner: WizardRole | null = final ? "Rep" : repDraft ? "Rep" : signed ? "Manager" : "Estimator";
  const statusLine = final ? "Approved. Next: Rep issues and sends the customer quotation (Stage 4)."
    : repDraft ? (i.revision > 1 ? `Returned to the Rep (revision ${i.revision}). Next responsible role: Rep: reconfirm the amount with the customer, then submit again.` : "The Rep has not submitted yet. Next responsible role: Rep.")
    : signed ? (manager ? "Signed off by the Estimator. Your decision: approve, or return it. Next responsible role: Manager." : "Signed off by the Estimator. Next responsible role: Manager.")
    : i.signoff === "stale" ? "The Estimator's sign-off is out of date. Next responsible role: Estimator."
    : "Not signed off yet. Next responsible role: Estimator.";
  return { steps: [summary, decision], entryStepId: manager && !final ? "decision" : "summary", returned: repDraft && i.revision > 1, submitted: inReview || final, nextOwner, statusLine };
}

/** Phrases an Estimator-owned open item (from Stage 1's owner split) as an instruction to the Estimator. */
export function estimatorItemText(message: string): string {
  const mapping = /^Estimator mapping needed:\s*(.+)$/.exec(message);
  if (mapping) return `Choose the product for ${mapping[1]}`;
  const rest = message.replace(/^Estimator:?\s*/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export interface EstimatorWork { map: string[]; price: string[]; reason: string[]; all: string[] }
/**
 * The Estimator-owned open items by KIND, from the CURRENT budget lines (so the list is never stale after the mappings are confirmed): a product to choose or confirm, a manual quotation price to enter
 * (the price source has none), and manual prices that still need a reason. Each line once. Messages are instructions to the Estimator.
 */
export function estimatorWork(lines: ReadonlyArray<{ label: string; status: string }> | null, blankPriceReasonCount: number): EstimatorWork {
  const seen = new Set<string>();
  const map: string[] = []; const price: string[] = []; const reason: string[] = [];
  for (const b of lines ?? []) {
    if (seen.has(b.label)) continue;
    if (b.status === "unmapped" || b.status === "package_unconfirmed" || b.status === "package_incomplete") { seen.add(b.label); map.push(`Choose or confirm the product for ${b.label}`); }
    else if (b.status === "not_in_price_source" || b.status === "supplier_quote_required") { seen.add(b.label); price.push(`Enter a manual quotation price for ${b.label}`); }
  }
  if (blankPriceReasonCount > 0) reason.push(`${blankPriceReasonCount} manual price${blankPriceReasonCount === 1 ? " needs" : "s need"} a reason`);
  return { map, price, reason, all: [...map, ...price, ...reason] };
}

export interface CommercialReadiness {
  /** Every Estimator-owned item is resolved and the project costs are complete. */
  complete: boolean;
  unmapped: number; quotesRequired: number; noCost: number; reasonsOpen: number;
  /** "Not commercially ready: 3 lines unmapped · 2 supplier quotes required · 7 lines have no cost" (null when complete). */
  headline: string | null;
  /** The exact open list with the owner of each. */
  items: Array<{ owner: "Estimator"; text: string }>;
}
const n1 = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/**
 * Commercial readiness for a viewer with cost visibility, from facts the page already holds (the budget's lines, the blank-reason count and the margin sheet's missing-cost count). It is a PRESENTATION of
 * what is still unresolved: an incomplete estimate is never shown as ready, and its amounts are "indicative". It decides nothing and gates nothing by itself.
 */
export function commercialReadiness(i: { lines: ReadonlyArray<{ label: string; status: string }> | null; blankPriceReasonCount: number; costMissingLines: number; /** The server says costing is incomplete (QuoteView.costing) even if no single line count explains it. */ costingIncomplete?: boolean; costingReason?: string | null }): CommercialReadiness {
  const w = estimatorWork(i.lines, i.blankPriceReasonCount);
  const unmapped = w.map.length; const quotesRequired = w.price.length; const noCost = i.costMissingLines; const reasonsOpen = i.blankPriceReasonCount;
  const parts = [unmapped > 0 && `${n1(unmapped, "line", "lines")} unmapped`, quotesRequired > 0 && `${n1(quotesRequired, "supplier quote", "supplier quotes")} required`, noCost > 0 ? `${n1(noCost, "line has", "lines have")} no cost` : !!i.costingIncomplete && "costing incomplete", reasonsOpen > 0 && `${n1(reasonsOpen, "manual price needs", "manual prices need")} a reason`].filter(Boolean) as string[];
  const items = [...w.all.map((text) => ({ owner: "Estimator" as const, text })), ...(noCost > 0 ? [{ owner: "Estimator" as const, text: `${n1(noCost, "line has", "lines have")} no cost: capture it from Cin7 or enter a manual estimate (step 2)` }] : i.costingIncomplete ? [{ owner: "Estimator" as const, text: `Costing is incomplete: ${i.costingReason ?? "supplier costs are unresolved"} (step 2)` }] : [])];
  return { complete: parts.length === 0, unmapped, quotesRequired, noCost, reasonsOpen, headline: parts.length ? `Not commercially ready: ${parts.join(" \u00B7 ")} (amounts are indicative)` : null, items };
}

/** The quotation total moved away from what the customer confirmed: the Rep must reconfirm (the server refuses approval otherwise). Null text when they agree or nothing was confirmed. */
export function confirmedAmountChange(confirmedCents: number | null, totalCents: number | null): { changed: boolean; text: string | null } {
  if (confirmedCents == null || totalCents == null || confirmedCents === totalCents) return { changed: false, text: null };
  return { changed: true, text: `The total changed from what the customer confirmed (${formatZarCents(confirmedCents)} -> ${formatZarCents(totalCents)}). Return to the Rep to reconfirm.` };
}
