// THE ESTIMATOR WORKSPACE, as pure data (NewQuip Phase 2). No React, no I/O, no pricing arithmetic: it only READS what the existing bridge and the supplier-pricing model already produced
// (the budget lines, the pricing workspace view, the draft's confirmations and the quotation's workflow facts) and arranges it as the approved exception-first task list:
//   - four DISTINCT readiness indicators per product (Mapping, Selling price, Supplier cost, Verified), never blurred into one "done";
//   - decisions first (a product to choose, a package to confirm, a manual price), then the lines that only need a supplier cost;
//   - Estimator-priced lines (M75, penning) and fully costed lines grouped separately as complete;
//   - one commercial summary whose labels say whether the total is partial, calculated or confirmed, and whether the margin is indicative or verified;
//   - ONE next action that follows the workflow order: price the open tasks, the Rep reconfirms a changed amount, a Manager verifies the costs, the Estimator signs off, a Manager approves.
// It invents nothing: no price, no SKU, no margin. A manual quotation price carries its REASON and EVIDENCE in the existing reason field in a fixed, readable format (see encodeManualReason).

import type { BridgeComponent, BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView, SkuRow } from "@/newquip/pricing/estimator";

// ── manual quotation price: reason + evidence in the existing reason field ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const R_PREFIX = "REASON: ";
const E_MARK = "\nEVIDENCE: ";
/** The one stored text for a manual quotation price: `REASON: <why>` then `EVIDENCE: <where the price comes from>`. A line break inside the reason that would start an EVIDENCE line is kept readable but made unambiguous. */
export function encodeManualReason(reason: string, evidence: string): string {
  const r = reason.trim().replace(/\n(?=EVIDENCE: )/g, "\nEVIDENCE : ");
  return `${R_PREFIX}${r}${E_MARK}${evidence.trim()}`;
}
export interface DecodedManualReason { reason: string; evidence: string; /** true when the stored text was not written in the labelled format (an earlier free-text reason): the whole text is shown as the reason and the evidence is still needed. */ legacy: boolean }
export function decodeManualReason(stored: string | null | undefined): DecodedManualReason {
  const s = stored ?? "";
  if (s.startsWith(R_PREFIX)) {
    const i = s.indexOf(E_MARK);
    if (i >= R_PREFIX.length) return { reason: s.slice(R_PREFIX.length, i), evidence: s.slice(i + E_MARK.length), legacy: false };
  }
  return { reason: s, evidence: "", legacy: true };
}
/** Both parts are mandatory for a manual quotation price. */
export const manualPriceComplete = (reason: string, evidence: string, unitPrice: number | null): boolean => reason.trim().length >= 3 && evidence.trim().length >= 3 && unitPrice !== null && Number.isFinite(unitPrice) && unitPrice > 0;

// ── types ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** done = complete; open = needed from someone now; wait = cannot start yet; na = does not apply to this line. */
export type IndicatorState = "done" | "open" | "wait" | "na";
export interface TaskIndicators { mapping: IndicatorState; price: IndicatorState; cost: IndicatorState; verified: IndicatorState }
export type TaskKind = "product" | "package" | "manual" | "cost";
export type TaskTag = "PRODUCT" | "COMPONENTS" | "PRICE" | "COST";
export interface WorkspaceTask {
  /** The budget line's item key. */
  id: string;
  n: number;
  kind: TaskKind;
  label: string;
  tags: TaskTag[];
  /** e.g. "15,840 × NQ1161" */
  meta: string;
  why: string;
  group: "decision" | "cost";
  indicators: TaskIndicators;
  /** The SKUs whose supplier cost this task needs (the line's SKU, or a package's component SKUs). */
  skus: string[];
  /** The button wording. */
  action: string;
  quantity: number | null;
}
export interface CompleteLine { id: string; label: string; how: string; quantity: number | null; unit: number | null; revenue: number | null; provisional: boolean; estimatorPriced: boolean; costState: "n/a" | "unverified" | "verified" }
export type TotalKind = "partial" | "calculated" | "confirmed";
export interface Summary {
  totalKind: TotalKind;
  /** The heading wording next to the total. Never "contract value" until a Manager has approved. */
  totalLabel: string;
  totalNote: string;
  /** The quotation's total as the bridge calculated it (ex VAT, rand). For a partial quotation this is what is priced so far. */
  totalExVat: number;
  pricedLinesExVat: number;
  pricedLineCount: number;
  chargesExVat: number;
  unpricedLineCount: number;
  vat: number;
  totalIncVat: number;
  confirmedCents: number | null;
  /** current total − confirmed total, in cents (null when nothing is confirmed). */
  differenceCents: number | null;
  checks: { mapping: { done: number; of: number }; price: { done: number; of: number }; cost: { done: number; of: number }; verified: { done: number; of: number } };
  marginLabel: "none" | "indicative" | "verified";
  marginNote: string;
  blockers: string[];
}
export type NextActionKind = "open_task" | "wait_rep" | "return_to_rep" | "verify_costs" | "wait_manager" | "sign_off" | "wait_manager_approval" | "approved" | "read_only";
export interface NextAction { kind: NextActionKind; headline: string; detail: string; /** The task to open, for open_task. */ taskId?: string; button: string | null }
export interface WorkspaceFacts {
  /** REP_DRAFT | ESTIMATOR_REVIEW | MANAGER_APPROVED_FINAL */
  state: string;
  confirmedCents: number | null;
  /** true when the Estimator's sign-off is stored against the current content. */
  signedOff: boolean;
  /** The viewer may enter pricing (the Estimator). */
  canEdit: boolean;
  /** The viewer may verify supplier costs (a reviewer). */
  canReview: boolean;
  /** Unconfirmed packages' confirmations and the Estimator's chosen mappings, from the draft. */
  confirmedPackages: readonly string[];
  confirmedMappings: Readonly<Record<string, string | undefined>>;
}
export interface Workspace {
  tasks: WorkspaceTask[];
  complete: CompleteLine[];
  summary: Summary;
  next: NextAction;
}

const rand = (n: number): string => `R${Math.round(n).toLocaleString("en-ZA").replace(/\s/g, ",")}`;
export const money = rand;
const qtyText = (n: number | null): string => (n == null ? "" : n.toLocaleString("en-ZA").replace(/\s/g, ","));
const componentSkus = (l: BridgeLine): string[] => (l.components ?? []).map((c: BridgeComponent) => c.sku).filter((s): s is string => !!s);
const rowOf = (rows: readonly SkuRow[], sku: string): SkuRow | undefined => rows.find((r) => r.sku === sku);

function costIndicators(skus: readonly string[], rows: readonly SkuRow[]): { cost: IndicatorState; verified: IndicatorState } {
  if (skus.length === 0) return { cost: "open", verified: "wait" };
  const rs = skus.map((s) => rowOf(rows, s));
  const costed = rs.filter((r) => r && r.costState !== "missing");
  const cost: IndicatorState = costed.length === skus.length ? "done" : "open";
  const verified: IndicatorState = cost !== "done" ? "wait" : rs.every((r) => r?.costState === "verified") ? "done" : "open";
  return { cost, verified };
}

/** The whole workspace from the facts the page already holds. Pure. */
export function buildWorkspace(i: { budget: BudgetQuote; view: PricingWorkspaceView; facts: WorkspaceFacts }): Workspace {
  const { budget, view, facts } = i;
  const tasks: Omit<WorkspaceTask, "n">[] = [];
  const complete: CompleteLine[] = [];
  const live = budget.lines.filter((l) => l.status !== "not_selected");

  for (const l of live) {
    const base = { id: l.itemKey as string, label: l.label, quantity: l.quantity };
    // Estimator-priced by design (M75, penning): never a product mapping, no supplier cost.
    if (l.pricedBy === "estimator_input" || l.pricedBy === "penning_rate") {
      complete.push({ ...base, how: l.pricedBy === "penning_rate" ? "Pig-size rate (not a product mapping)" : "Your price, by design (not a product mapping)", unit: l.unitPrice, revenue: l.revenueExTax, provisional: false, estimatorPriced: true, costState: "n/a" });
      continue;
    }
    // A manual quotation price: exceptional and provisional, no supplier cost to verify.
    if (l.pricedBy === "estimator_resolution") {
      complete.push({ ...base, how: "Manual quotation price, provisional (reason and evidence recorded)", unit: l.unitPrice, revenue: l.revenueExTax, provisional: true, estimatorPriced: false, costState: "n/a" });
      continue;
    }
    const skus = l.sku ? [l.sku] : componentSkus(l);
    const isPackage = !!l.components && l.components.length > 0;
    const unresolvedParts = isPackage && (l.components ?? []).some((c) => c.status === "identity_unresolved" || !c.sku);
    const ci = costIndicators(skus, view.rows);
    if (l.status === "priced") {
      const states = skus.map((s) => rowOf(view.rows, s)?.costState);
      const verified = states.length > 0 && states.every((s) => s === "verified");
      complete.push({ ...base, how: `${l.sku ?? "Package"} · supplier cost entered · ${verified ? "independently verified" : "awaiting Manager verification"}`, unit: l.unitPrice, revenue: l.revenueExTax, provisional: false, estimatorPriced: false, costState: verified ? "verified" : "unverified" });
      continue;
    }
    // ── a task ──
    if (isPackage && unresolvedParts) {
      tasks.push({ ...base, kind: "manual", tags: ["COMPONENTS", "PRICE"], meta: `${qtyText(l.quantity)} × ${l.components!.length} parts`, why: "No SKU yet. Manual price with a reason and evidence, provisional.", group: "decision", indicators: { mapping: "open", price: "open", cost: "na", verified: "na" }, skus: [], action: "Quote price" });
    } else if (isPackage) {
      const confirmed = facts.confirmedPackages.includes(l.itemKey as string);
      tasks.push({ ...base, kind: "package", tags: ["COMPONENTS", "PRICE"], meta: `${qtyText(l.quantity)} × ${l.components!.length} components`, why: confirmed ? `Cost ${l.components!.length} components (or a manual price with evidence).` : `Confirm the package, then cost ${l.components!.length} components (or a manual price with evidence).`, group: "decision", indicators: { mapping: confirmed ? "done" : "open", price: "open", cost: confirmed ? ci.cost : "open", verified: confirmed ? ci.verified : "wait" }, skus, action: confirmed ? "Cost components" : "Map and price" });
    } else if (l.status === "unmapped" || !l.sku) {
      tasks.push({ ...base, kind: "product", tags: ["PRODUCT", "PRICE"], meta: `${qtyText(l.quantity)}`, why: "No product chosen. Choose the product, then cost it.", group: "decision", indicators: { mapping: "open", price: "open", cost: "open", verified: "wait" }, skus: [], action: "Choose and price" });
    } else {
      tasks.push({ ...base, kind: "cost", tags: ["COST"], meta: `${qtyText(l.quantity)} × ${l.sku}`, why: "Needs a supplier cost.", group: "cost", indicators: { mapping: "done", price: "open", cost: ci.cost, verified: ci.verified }, skus, action: ci.cost === "done" ? "Review cost" : "Enter cost" });
    }
  }
  const ordered = [...tasks.filter((t) => t.group === "decision"), ...tasks.filter((t) => t.group === "cost")].map((t, k) => ({ ...t, n: k + 1 }));

  // ── commercial summary ──
  const chargesExVat = budget.charges.reduce((a, c) => a + (c.amountExTax ?? 0), 0);
  const pricedLines = live.filter((l) => l.status === "priced");
  const pricedLinesExVat = pricedLines.reduce((a, l) => a + (l.revenueExTax ?? 0), 0);
  const totalExVat = budget.totals.subtotalExTax;
  const totalCents = Math.round(totalExVat * 100);
  const open = ordered.length;
  const confirmed = facts.confirmedCents;
  const equal = confirmed !== null && confirmed === totalCents;
  const totalKind: TotalKind = open > 0 || budget.incomplete ? "partial" : equal ? "confirmed" : "calculated";
  const required = view.costs.required, verifiedN = view.costs.verified;
  const costDone = ordered.filter((t) => t.indicators.cost === "done").length + complete.filter((c) => !c.estimatorPriced && !c.provisional).length;
  const costOf = ordered.filter((t) => t.indicators.cost !== "na").length + complete.filter((c) => !c.estimatorPriced && !c.provisional).length;
  const verifiedDone = complete.filter((c) => c.costState === "verified").length;
  const mappingDone = ordered.filter((t) => t.indicators.mapping === "done").length + complete.filter((c) => !c.estimatorPriced && !c.provisional).length;
  const mappingOf = ordered.length + complete.filter((c) => !c.estimatorPriced && !c.provisional).length;
  const marginFig = view.totals.margin;
  const marginVerified = required > 0 && verifiedN === required && !budget.incomplete;
  const blockers: string[] = [];
  if (open > 0) blockers.push(`${open} task${open === 1 ? "" : "s"} open`);
  if (!equal && confirmed !== null) blockers.push("Amount differs from the Rep's confirmation");
  if (confirmed === null && open === 0) blockers.push("No amount confirmed by the Rep yet");
  if (required > verifiedN || required === 0) blockers.push("Costs not independently verified");
  const summary: Summary = {
    totalKind,
    totalLabel: totalKind === "partial" ? "PARTIAL TOTAL, EX VAT" : totalKind === "calculated" ? "CALCULATED TOTAL, NOT YET CONFIRMED" : "AMOUNT CONFIRMED BY THE REP",
    totalNote: totalKind === "partial" ? "Indicative only. Not a contract value." : totalKind === "calculated" ? "Not a contract value until the Rep confirms it and the costs are verified." : "Matches the Rep's confirmation. Costs still need independent verification before approval.",
    totalExVat, pricedLinesExVat, pricedLineCount: pricedLines.length, chargesExVat, unpricedLineCount: live.length - pricedLines.length,
    vat: Math.round(totalExVat * 0.15 * 100) / 100, totalIncVat: Math.round(totalExVat * 1.15 * 100) / 100,
    confirmedCents: confirmed, differenceCents: confirmed === null ? null : totalCents - confirmed,
    checks: { mapping: { done: mappingDone, of: mappingOf }, price: { done: pricedLines.length, of: live.length }, cost: { done: costDone, of: costOf }, verified: { done: Math.max(verifiedDone, verifiedN), of: Math.max(required, costOf) } },
    marginLabel: !marginFig ? "none" : marginVerified ? "verified" : "indicative",
    marginNote: !marginFig ? "A margin appears once costs are entered, labelled indicative. It is called verified only after a Manager verifies the costs." : marginVerified ? "Every supplier cost has been independently verified." : "Indicative, unverified: it rests on supplier costs a Manager has not yet verified.",
    blockers,
  };

  // ── the one next action (decision 5: Rep reconfirmation, then Manager verification, then Estimator sign-off, then Manager approval) ──
  let next: NextAction;
  const first = ordered[0];
  if (facts.state === "MANAGER_APPROVED_FINAL") next = { kind: "approved", headline: "Approved", detail: "This quotation is approved and sealed.", button: null };
  else if (open > 0) {
    next = facts.canEdit
      ? { kind: "open_task", headline: `${first.action === "Enter cost" || first.kind === "cost" ? "Enter the supplier cost for" : first.kind === "product" ? "Choose and price" : first.kind === "manual" ? "Quote a manual price for" : "Confirm and cost"} ${first.label.toLowerCase()}`, detail: first.why, taskId: first.id, button: `Open task 1 of ${open}` }
      : { kind: "read_only", headline: `${open} task${open === 1 ? "" : "s"} waiting for the Estimator`, detail: "Only an Estimator enters pricing.", button: null };
  } else if (facts.state === "REP_DRAFT") next = { kind: "wait_rep", headline: "Waiting for the Rep to confirm the new amount", detail: "The amount changed, so the Rep reconfirms it with the customer before anyone verifies costs. You will see it again when they submit.", button: null };
  else if (confirmed === null || confirmed !== totalCents) next = facts.canEdit
    ? { kind: "return_to_rep", headline: "Return to the Rep to reconfirm the new amount", detail: "The total is no longer the amount the customer confirmed. The Rep sees only the new price, never your costs. Sign-off stays locked until they confirm it.", button: "Return to Rep" }
    : { kind: "read_only", headline: "The Estimator returns this to the Rep to reconfirm the amount", detail: "", button: null };
  else if (required > verifiedN) next = facts.canReview
    ? { kind: "verify_costs", headline: `Verify ${required - verifiedN} supplier cost${required - verifiedN === 1 ? "" : "s"}`, detail: "Check each cost against its evidence. You cannot verify a cost you entered yourself.", button: "Verify costs" }
    : { kind: "wait_manager", headline: `Waiting for a Manager to verify ${required - verifiedN} supplier cost${required - verifiedN === 1 ? "" : "s"}`, detail: "You cannot verify your own entries.", button: null };
  else if (!facts.signedOff) next = facts.canEdit
    ? { kind: "sign_off", headline: "Sign off this quotation", detail: "Costs are verified and the Rep has confirmed the amount.", button: "Go to sign-off" }
    : { kind: "read_only", headline: "Waiting for the Estimator to sign off", detail: "", button: null };
  else next = { kind: "wait_manager_approval", headline: "Next: Manager approval", detail: "The Estimator has signed off. A Manager approves or returns it.", button: "Open Manager approval" };

  return { tasks: ordered, complete, summary, next };
}
