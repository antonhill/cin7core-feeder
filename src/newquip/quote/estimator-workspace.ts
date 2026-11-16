// THE ESTIMATOR WORKSPACE, as pure data (NewQuip Phase 2). No React, no I/O, no pricing arithmetic: it only READS what the existing bridge and the supplier-pricing model already produced
// (the budget lines, the pricing workspace view, the draft's confirmations and the quotation's workflow facts) and arranges it as the approved exception-first task list:
//   - four DISTINCT readiness indicators per product (Mapping, Selling price, Supplier cost, Verified), never blurred into one "done";
//   - decisions first (a product to choose, a package to confirm, a manual price), then the lines that only need a supplier cost;
//   - Estimator-priced lines (M75, penning) and fully costed lines grouped separately as complete;
//   - one commercial summary whose labels say whether the total is partial, calculated or confirmed, and whether the margin is indicative or verified;
//   - ONE next action that follows the workflow order: price the open tasks, the Rep reconfirms a changed amount, a Manager verifies the costs, the Estimator signs off, a Manager approves.
// It invents nothing: no price, no SKU, no margin. A manual quotation price carries its REASON and EVIDENCE in the existing reason field in a fixed, readable format (see encodeManualReason).

import { formatZar } from "@/lib/format-money";
import type { BridgeComponent, BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView, SkuRow } from "@/newquip/pricing/estimator";
import type { IndicativeComparison } from "@/newquip/pricing/comparison";
import { formatCost7 } from "@/newquip/pricing/estimator";

// ── manual quotation price: reason + evidence in the existing reason field ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Stored as `REASON: <reason>` + a line break + `EVIDENCE: <evidence>`. Each part is ESCAPED (a backslash becomes `\\`, a line break becomes `\n`, a carriage return `\r`), so neither part can ever contain the
// separator or a line break: the text is one readable line pair, and decoding returns EXACTLY what was typed (after trimming), whatever it contains.
const R_PREFIX = "REASON: ";
const E_MARK = "\nEVIDENCE: ";
const esc = (t: string): string => t.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
const unesc = (t: string): string => t.replace(/\\(\\|n|r)/g, (_m, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : "\\"));
export function encodeManualReason(reason: string, evidence: string): string {
  return `${R_PREFIX}${esc(reason.trim())}${E_MARK}${esc(evidence.trim())}`;
}
export interface DecodedManualReason { reason: string; evidence: string; /** true when the stored text was not written in the labelled format (an earlier free-text reason): the whole text is shown as the reason and the evidence is still needed. */ legacy: boolean }
export function decodeManualReason(stored: string | null | undefined): DecodedManualReason {
  const s = stored ?? "";
  if (s.startsWith(R_PREFIX)) {
    const i = s.indexOf(E_MARK);
    if (i >= R_PREFIX.length) return { reason: unesc(s.slice(R_PREFIX.length, i)), evidence: unesc(s.slice(i + E_MARK.length)), legacy: false };
  }
  return { reason: s, evidence: "", legacy: true };
}
/** The stored text as one readable line for the Manager (cost-entitled readers only): both parts, or the whole earlier text. */
export function manualReasonText(stored: string | null | undefined): string {
  const d = decodeManualReason(stored);
  if (d.legacy) return d.reason.trim() || "no reason";
  return `reason: ${d.reason || "—"} · evidence: ${d.evidence || "—"}`;
}
/**
 * Any text that may CONTAIN the stored `REASON: …⏎EVIDENCE: …` pair (a bridge line reason, a comparison row), made plain for a cost-entitled reader: "<reason> (evidence: <evidence>)". The raw labels
 * are never shown to a person. Text without the pair is returned unchanged, byte for byte.
 */
export const plainManualText = (t: string): string => t.replace(/REASON: ([^\n]*)\nEVIDENCE: ([^\n]*)/g, (_m, r: string, e: string) => `${unesc(r)} (evidence: ${unesc(e)})`);
/** Both parts are mandatory for a manual quotation price. The evidence note is the same text the existing pricing-evidence record takes (at least 10 characters, at most 500). */
export const manualPriceComplete = (reason: string, evidence: string, unitPrice: number | null): boolean => reason.trim().length >= 3 && evidence.trim().length >= 10 && evidence.trim().length <= 500 && unitPrice !== null && Number.isFinite(unitPrice) && unitPrice > 0;

// ── types ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** done = complete; open = needed from someone now; wait = cannot start yet; na = does not apply to this line. */
export type IndicatorState = "done" | "open" | "wait" | "na";
export interface TaskIndicators { mapping: IndicatorState; price: IndicatorState; cost: IndicatorState; verified: IndicatorState }
export type TaskKind = "product" | "package" | "manual" | "cost" | "m75";
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
export type EvidenceView = { state: "missing" | "recorded" | "outdated"; text: string; note: string | null; reference: string | null };
/** A line that WAS priced on the reference basis (the Rep's handoff) and is now excluded from the total until it has a supplier cost. */
export interface ExcludedLine { id: string; label: string; /** What it was worth on the reference basis, ex VAT, rand. */ previous: number; why: string }
export interface CompleteLine { /** the SKU-less manual item's pricing-evidence record (the existing approval requirement) */ evidence?: EvidenceView; /** the stored reason of a manual quotation price, decoded (reason and evidence) */ manual?: DecodedManualReason; id: string; label: string; how: string; quantity: number | null; unit: number | null; revenue: number | null; provisional: boolean; estimatorPriced: boolean; costState: "n/a" | "unverified" | "verified" }
export type TotalKind = "partial" | "calculated" | "confirmed";
export interface Summary {
  totalKind: TotalKind;
  /** Lines that were priced on the reference basis and now wait for a supplier cost, with their previous amounts. Never part of the total. */
  excluded: ExcludedLine[];
  excludedPreviousTotal: number;
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
export type NextActionKind = "open_task" | "wait_rep_items" | "wait_rep" | "return_to_rep" | "verify_costs" | "wait_manager" | "sign_off" | "wait_manager_approval" | "approved" | "read_only" | "record_evidence";
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
  /** The stored manual quotation prices (item key -> reason text), to show their reason and evidence. */
  priceResolutionReasons?: Readonly<Record<string, string | undefined>>;
  /** The Rep's handoff comparison (cost-entitled viewers only): what each line was worth on the reference basis. */
  reference?: Pick<IndicativeComparison, "rows"> | null;
}
/** Something only the Rep can supply (a quantity, a charge, the pig size): named, never a task button for the Estimator. */
export interface RepItem { id: string; label: string; why: string }
export interface Workspace {
  tasks: WorkspaceTask[];
  repItems: RepItem[];
  complete: CompleteLine[];
  summary: Summary;
  next: NextAction;
}

/** The ONE plain-English status shown for a line in the primary list (the four underlying readiness checks stay in the editor and in the derivation). */
export type StatusWord = "Supplier cost needed" | "Product selection needed" | "Component pricing needed" | "Price needed" | "Evidence needed" | "Provisional" | "Complete";
export const taskStatusWord = (t: Pick<WorkspaceTask, "kind">): StatusWord => (t.kind === "cost" ? "Supplier cost needed" : t.kind === "product" ? "Product selection needed" : t.kind === "m75" ? "Price needed" : "Component pricing needed");
/** A line whose only open item is its pricing-evidence record (it gates sign-off, so it belongs in the OPEN list, not the completed group). */
export const needsEvidence = (c: Pick<CompleteLine, "evidence">): boolean => !!c.evidence && c.evidence.state !== "recorded";
export const completeStatusWord = (c: CompleteLine): StatusWord => (needsEvidence(c) ? "Evidence needed" : c.provisional ? "Provisional" : "Complete");

/** Rand with its cents, always: R193.60 stays R193.60 (never rounded to a whole rand). Formats only: the amount comes from the model's exact cents. */
export const money = (n: number): string => formatZar(n); // the single South African presentation (R 1 234,50), as on the rest of the quotation
/** An exact supplier cost (units of 1e-7): up to 7 decimals as entered, at least 2 (193.60, 6.5454755). */
export const costText = (e7: number): string => { const t = formatCost7(e7); const [i, f = ""] = t.split("."); return f.length >= 2 ? t : `${i}.${f.padEnd(2, "0")}`; };
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

/** Which editor a budget line opens, and the supplier-cost SKUs it involves (also used to reopen a COMPLETE line for editing). */
export function targetOf(l: BridgeLine): { kind: TaskKind | "complete_manual"; skus: string[] } {
  const skus = l.sku ? [l.sku] : componentSkus(l);
  if (l.status === "estimator_price_required" && l.itemKey === "flex_auger") return { kind: "m75", skus: [] };
  if (l.pricedBy === "estimator_resolution") return { kind: "complete_manual", skus };
  const isPackage = !!l.components && l.components.length > 0;
  if (isPackage && (l.components ?? []).some((c) => c.status === "identity_unresolved" || !c.sku)) return { kind: "manual", skus: [] };
  if (isPackage) return { kind: "package", skus };
  if (l.status === "unmapped" || !l.sku) return { kind: "product", skus: [] };
  return { kind: "cost", skus };
}

/** The whole workspace from the facts the page already holds. Pure. */
export function buildWorkspace(i: { budget: BudgetQuote; view: PricingWorkspaceView; facts: WorkspaceFacts }): Workspace {
  const { budget, view, facts } = i;
  const tasks: Omit<WorkspaceTask, "n">[] = [];
  const complete: CompleteLine[] = [];
  const repItems: RepItem[] = [];
  const live = budget.lines.filter((l) => l.status !== "not_selected");
  const evidenceOf = (id: string): EvidenceView | undefined => { const r = (view.manualEvidence ?? []).find((x) => x.itemKey === id); return r ? { state: r.state, text: r.stateText, note: r.note, reference: r.reference } : undefined; };

  for (const l of live) {
    const base = { id: l.itemKey as string, label: l.label, quantity: l.quantity };
    // Estimator-priced by design (M75, penning): never a product mapping, no supplier cost.
    if (l.pricedBy === "estimator_input" || l.pricedBy === "penning_rate") {
      complete.push({ ...base, how: l.pricedBy === "penning_rate" ? "Pig-size rate (not a product mapping)" : "Your price, by design (not a product mapping)", unit: l.unitPrice, revenue: l.revenueExTax, provisional: false, estimatorPriced: true, costState: "n/a", evidence: evidenceOf(l.itemKey as string) });
      continue;
    }
    // The M75 system price: the Estimator's own commercial price per system. It has no supplier cost and is not a product mapping, so it is a PRICE task (never a package or component task).
    if (l.status === "estimator_price_required" && l.itemKey === "flex_auger") {
      tasks.push({ ...base, kind: "m75", tags: ["PRICE"], meta: `${qtyText(l.quantity)} systems`, why: "Enter the commercial price per system, ex VAT. Your price, by design: no supplier cost, not a product mapping.", group: "decision", indicators: { mapping: "na", price: "open", cost: "na", verified: "na" }, skus: [], action: "Enter price" });
      continue;
    }
    // Anything else that is waiting for the Rep (a quantity, the penning pig size): named, not a task for the Estimator.
    if (l.status === "no_quantity" || l.status === "estimator_price_required") { repItems.push({ id: l.itemKey as string, label: l.label, why: l.status === "no_quantity" ? "quantity not entered" : l.reason.replace(/\.$/, "") }); continue; }
    // A manual quotation price: exceptional and provisional, no supplier cost to verify.
    if (l.pricedBy === "estimator_resolution") {
      complete.push({ ...base, manual: decodeManualReason(facts.priceResolutionReasons?.[l.itemKey as string]), how: `Manual quotation price, provisional${evidenceOf(l.itemKey as string)?.state === "recorded" ? " · evidence recorded" : " · pricing evidence still to record"}`, unit: l.unitPrice, revenue: l.revenueExTax, provisional: true, estimatorPriced: false, costState: "n/a", evidence: evidenceOf(l.itemKey as string) });
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

  // ── lines that WERE priced on the reference basis (the Rep's handoff) and now wait for a supplier cost: named, with their previous amounts, never in the total ──
  const taskOf = new Map(ordered.map((t) => [t.id, t]));
  const excluded: ExcludedLine[] = [];
  for (const row of facts.reference?.rows ?? []) {
    if (row.kind !== "line") continue;
    const t = taskOf.get(row.key);
    const was = row.original?.revenueCents ?? null;
    if (!t || was == null || was <= 0 || row.current?.revenueCents != null) continue;
    excluded.push({ id: row.key, label: row.label, previous: was / 100, why: t.kind === "cost" ? "needs a supplier cost" : t.kind === "product" ? "needs a product choice and a supplier cost" : t.kind === "package" ? "needs the package confirmed and each component costed" : t.kind === "m75" ? "needs your system price" : "needs a manual price with a reason and evidence" });
  }
  const excludedPreviousTotal = excluded.reduce((a, e) => a + e.previous, 0);

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
  // ── ONE set of gates drives both the "blocked by" list and the next action, so they can never disagree ──
  const repWaiting = [...repItems.map((r) => `${r.label}: ${r.why}`), ...budget.charges.filter((c) => c.status === "required").map((c) => `${c.label}: amount not entered`)];
  const incompleteReason = budget.incomplete && open === 0 && repWaiting.length === 0 ? (budget.blockers?.[0] ?? "a line is not priced yet") : null;
  const costsOpen = required > verifiedN;
  const evidenceMissing = complete.filter((c) => c.evidence && c.evidence.state !== "recorded");
  type Gate = { id: "tasks" | "rep_items" | "incomplete" | "evidence" | "with_rep" | "amount" | "costs"; text: string };
  const gates: Gate[] = [];
  const openItems = open + evidenceMissing.length; // evidence still to record is listed with the open tasks, so it is counted with them
  if (open > 0) gates.push({ id: "tasks", text: `${openItems} task${openItems === 1 ? "" : "s"} open` });
  if (repWaiting.length > 0) gates.push({ id: "rep_items", text: `Waiting for the Rep: ${repWaiting.join("; ")}` });
  if (incompleteReason) gates.push({ id: "incomplete", text: `The quotation is incomplete: ${incompleteReason}` });
  if (open === 0 && repWaiting.length === 0 && !incompleteReason && evidenceMissing.length > 0) gates.push({ id: "evidence", text: `Pricing evidence to record: ${evidenceMissing.map((c) => c.label).join(", ")}` });
  if (open === 0 && repWaiting.length === 0 && !incompleteReason && evidenceMissing.length === 0) {
    if (facts.state === "REP_DRAFT") gates.push({ id: "with_rep", text: "With the Rep to reconfirm the amount" });
    else if (confirmed === null) gates.push({ id: "amount", text: "No amount confirmed by the Rep yet" });
    else if (!equal) gates.push({ id: "amount", text: "Amount differs from the Rep's confirmation" });
  }
  if (costsOpen) gates.push({ id: "costs", text: "Costs not independently verified" });
  const blockers = gates.map((g) => g.text);
  const summary: Summary = {
    totalKind, excluded, excludedPreviousTotal,
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

  // ── the one next action: the first unmet gate (Rep reconfirmation, then Manager verification, then Estimator sign-off, then Manager approval) ──
  let next: NextAction;
  const first = ordered[0];
  const g0 = gates[0];
  const taskHeadline = (t: Omit<WorkspaceTask, "n"> & { n: number }): string => (t.kind === "m75" ? `Enter the M75 system price` : t.kind === "cost" ? `Enter the supplier cost for ${t.label.toLowerCase()}` : t.kind === "product" ? `Choose and price ${t.label.toLowerCase()}` : t.kind === "manual" ? `Quote a manual price for ${t.label.toLowerCase()}` : `Confirm and cost ${t.label.toLowerCase()}`);
  if (facts.state === "MANAGER_APPROVED_FINAL") next = { kind: "approved", headline: "Approved", detail: "This quotation is approved and sealed.", button: null };
  else if (facts.state === "REP_DRAFT" && !facts.canEdit) next = { kind: "wait_rep", headline: "Waiting for the Rep to reconfirm the amount and submit it again", detail: "The quotation is with the Rep. You can read it here; nothing changes until it comes back.", button: null };
  else if (g0?.id === "tasks") {
    next = facts.canEdit
      ? { kind: "open_task", headline: taskHeadline(first), detail: first.why, taskId: first.id, button: `Open task 1 of ${open}` }
      : { kind: "read_only", headline: `${open} task${open === 1 ? "" : "s"} waiting for the Estimator`, detail: "Only an Estimator enters pricing.", button: null };
  } else if (g0?.id === "rep_items" || g0?.id === "incomplete") next = { kind: "wait_rep_items", headline: g0.text, detail: "These belong to the Rep. Nothing here can be signed off until they are complete.", button: null };
  else if (g0?.id === "evidence") next = facts.canEdit
    ? { kind: "record_evidence", headline: `Record the pricing evidence for ${evidenceMissing[0].label.toLowerCase()}`, detail: "Manual and Estimator-priced lines need a short evidence note before sign-off. It does not change any price.", button: "Record evidence" }
    : { kind: "read_only", headline: "The Estimator records the pricing evidence", detail: "", button: null };
  else if (g0?.id === "with_rep") next = { kind: "wait_rep", headline: "Waiting for the Rep to confirm the new amount", detail: "The amount changed, so the Rep reconfirms it with the customer before anyone verifies costs. You will see it again when they submit.", button: null };
  else if (g0?.id === "amount") next = facts.canEdit
    ? { kind: "return_to_rep", headline: "Return to the Rep to reconfirm the new amount", detail: "The total is no longer the amount the customer confirmed. The Rep sees only the new price, never your costs. Sign-off stays locked until they confirm it.", button: "Return to Rep" }
    : { kind: "read_only", headline: "The Estimator returns this to the Rep to reconfirm the amount", detail: "", button: null };
  else if (g0?.id === "costs") next = facts.canReview
    ? { kind: "verify_costs", headline: `Verify ${required - verifiedN} supplier cost${required - verifiedN === 1 ? "" : "s"}`, detail: "Check each cost against its evidence. You cannot verify a cost you entered yourself.", button: "Verify costs" }
    : { kind: "wait_manager", headline: `Waiting for a Manager to verify ${required - verifiedN} supplier cost${required - verifiedN === 1 ? "" : "s"}`, detail: "You cannot verify your own entries.", button: null };
  else if (!facts.signedOff) next = facts.canEdit
    ? { kind: "sign_off", headline: "Sign off this quotation", detail: "Costs are verified and the Rep has confirmed the amount.", button: "Go to sign-off" }
    : { kind: "read_only", headline: "Waiting for the Estimator to sign off", detail: "", button: null };
  else next = { kind: "wait_manager_approval", headline: "Next: Manager approval", detail: "The Estimator has signed off. A Manager approves or returns it.", button: "Open Manager approval" };

  return { tasks: ordered, repItems, complete, summary, next };
}

// ── switching supplier pricing ON: what changes, before it happens ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ActivationStarter { sku: string; label: string; itemKey: string; quantity: number | null }
export interface ActivationPreview {
  /** Lines priced from the reference price source today: with supplier pricing on they have no price until a supplier cost is entered, so they drop out of the total. */
  excluded: ExcludedLine[];
  excludedTotal: number;
  currentTotal: number;
  /** What the total would be the moment supplier pricing is on and before any cost: the current total less the excluded lines. Partial, never a contract value. */
  totalAfter: number;
  /** Single-SKU lines that can take the first supplier cost (the server needs at least one to switch the model on). */
  starters: ActivationStarter[];
}
export function activationPreview(budget: BudgetQuote): ActivationPreview {
  const live = budget.lines.filter((l) => l.status === "priced" && l.pricedBy === "price_source");
  const excluded: ExcludedLine[] = live.map((l) => ({ id: l.itemKey as string, label: l.label, previous: l.revenueExTax ?? 0, why: l.sku ? "needs a supplier cost" : "needs each component costed" }));
  const excludedTotal = excluded.reduce((a, e) => a + e.previous, 0);
  const currentTotal = budget.totals.subtotalExTax;
  return {
    excluded, excludedTotal, currentTotal, totalAfter: Math.round((currentTotal - excludedTotal) * 100) / 100,
    starters: live.filter((l) => !!l.sku).map((l) => ({ sku: l.sku as string, label: l.label, itemKey: l.itemKey as string, quantity: l.quantity })),
  };
}
