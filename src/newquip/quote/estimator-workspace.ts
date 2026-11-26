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
export type TaskKind = "product" | "package" | "manual" | "cost" | "m75" | "budget_basis";
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
  /** A package whose components ALL already have a cost: only the confirmation is outstanding (no cost is asked for again). */
  confirmOnly?: boolean;
}
export type EvidenceView = { state: "missing" | "recorded" | "outdated"; text: string; note: string | null; reference: string | null };
/** A line that WAS priced on the reference basis (the Rep's handoff) and is now excluded from the total until it has a supplier cost. */
export interface ExcludedLine { id: string; label: string; /** What it was worth on the reference basis, ex VAT, rand. */ previous: number; why: string }
export interface CompleteLine { /** the SKU-less manual item's pricing-evidence record (the existing approval requirement) */ evidence?: EvidenceView; /** the stored reason of a manual quotation price, decoded (reason and evidence) */ manual?: DecodedManualReason; id: string; label: string; how: string; quantity: number | null; unit: number | null; revenue: number | null; provisional: boolean; /** A documented Budget basis (door BOM cost, fixed panel price), NOT a manual quotation price. */ budgetBasis?: boolean; estimatorPriced: boolean; costState: "n/a" | "unverified" | "verified"; /** Priced entirely from automatic Cin7 costs that a Manager has not yet verified: shown under "Ready for verification". */ autoReady?: boolean }

/** What the Estimator needs to see about ONE automatically costed product, without opening anything. INTERNAL (the whole workspace is cost-entitled only). */
export interface AutoSkuFact {
  sku: string; supplier: string | null; currency: string | null; cost: string | null; costDate: string | null; fx: string | null; freight: string | null; landed: string | null; selling: string | null; provenance: string | null;
  /** The product's own words, kept apart so the screen can say the SAME freight source once per package (all three together are `provenance`). */
  costNote: string | null; freightNote: string | null; fxNote: string | null;
  /** How many of this product the line uses in total (the component quantity for a package, the line quantity for a single product). */
  quantity: number | null;
}
/** A warning the Estimator must see even while the cost details are closed. `severity` "critical" is shown in strong colour. */
export interface ReadyWarning { code: "freight_unapproved" | "cost_aged"; severity: "critical" | "notice"; text: string }
export interface ReadyLine {
  id: string; label: string; quantity: number | null; skus: AutoSkuFact[]; unit: number | null; revenue: number | null;
  /** The line's total cost (the bridge's own estimate, rand) - null when the bridge does not hold one. Internal: this whole view is cost-entitled only. */
  totalCost: number | null;
  /** Genuine pricing warnings, each said ONCE for the whole line however many components share it. */
  warnings: ReadyWarning[];
  /** Distinct freight sources used by the components (normally one): shown once in the details, not per component. */
  freightNotes: string[];
}
/** One product that has NO automatic price: the SPECIFIC stored reason and what to do about it. */
export interface PricingException { sku: string; usedBy: string[]; reason: string; action: string; /** The task that opens the editor for it. */ taskId: string; /** Reading Cin7 again may price it (it was not read, or a setting was missing at the time). */ retryable: boolean }
export interface AutoView {
  /** Automatic pricing is part of this quotation (some cost is automatic, or the pricing is entirely automatic): the three-section layout applies. */
  active: boolean;
  ready: ReadyLine[];
  /** Products with an automatic cost still awaiting a Manager's verification. */
  autoPriced: number;
  /** Open decisions (a package or product to confirm, a manual price): never cost entry. */
  needConfirmation: number;
  exceptions: PricingException[];
  /** How many exceptions "Price from Cin7" may resolve. */
  retryable: number;
  /** The viewer is an Estimator and "Price from Cin7" can run on this quotation (the server says so; see top-up-availability.ts). */
  canPrice: boolean;
  /** When some exceptions could be resolved by Price from Cin7 but it cannot run, the plain-words reason (the button is then shown disabled with this text). null otherwise. */
  unavailableReason?: string | null;
}
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
export type NextActionKind = "price_from_cin7" | "open_task" | "wait_rep_items" | "wait_rep" | "return_to_rep" | "verify_costs" | "wait_manager" | "sign_off" | "wait_manager_approval" | "approved" | "read_only" | "record_evidence";
export interface NextAction { kind: NextActionKind; headline: string; detail: string; /** The task to open, for open_task. */ taskId?: string; button: string | null }
export interface WorkspaceFacts {
  /** REP_DRAFT | ESTIMATOR_REVIEW | MANAGER_APPROVED_FINAL */
  state: string;
  /** The quotation revision. Above 1 with state REP_DRAFT means it was RETURNED to the Rep; optional so older callers still work (then it is treated as a first draft). */
  revision?: number;
  confirmedCents: number | null;
  /** true when the Estimator's sign-off is stored against the current content. */
  signedOff: boolean;
  /** The viewer may enter pricing (the Estimator). */
  canEdit: boolean;
  /** The viewer may verify supplier costs (a reviewer). */
  canReview: boolean;
  /** Server-derived: can "Price from Cin7" run here, and if not why (absent for callers that predate it). */
  cin7Pricing?: { available: boolean; reason: string | null };
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
  auto: AutoView;
}

/** The ONE plain-English status shown for a line in the primary list (the four underlying readiness checks stay in the editor and in the derivation). */
export type StatusWord = "Confirmation needed" | "Supplier cost needed" | "Product selection needed" | "Component pricing needed" | "Price needed" | "Evidence needed" | "Provisional" | "Complete";
export const taskStatusWord = (t: Pick<WorkspaceTask, "kind"> & { confirmOnly?: boolean }): StatusWord => (t.confirmOnly || t.kind === "budget_basis" ? "Confirmation needed" : t.kind === "cost" ? "Supplier cost needed" : t.kind === "product" ? "Product selection needed" : t.kind === "m75" ? "Price needed" : "Component pricing needed");
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
/** Everything the Estimator checks about one automatically costed product, read straight from the pricing view (no arithmetic here: the landed cost and the price come from the model). */
function autoFact(r: SkuRow, quantity: number | null = null): AutoSkuFact {
  const fxNote = r.currency !== "ZAR" && r.rate?.source ? `Exchange rate: ${r.rate.source}.` : null;
  return {
    quantity, costNote: r.costSource, freightNote: r.freightSource ? `Freight: ${r.freightSource.replace(/\.+$/, "")}.` : null, fxNote,
    sku: r.sku, supplier: r.supplier, currency: r.currency, cost: r.nativeUnitCostE7 == null || !r.currency ? null : `${r.currency} ${costText(r.nativeUnitCostE7)}`, costDate: r.costDate,
    fx: r.currency === "ZAR" || !r.rate ? null : `${r.currency} ${(r.rate.rateMicro / 1e6).toFixed(4)}${r.rate.asOf ? ` as of ${r.rate.asOf.slice(0, 10)}` : ""}`,
    freight: r.freightFactorMicro == null ? null : `× ${(r.freightFactorMicro / 1e6).toFixed(2)}${r.freightAddOnCents ? ` + ${money(r.freightAddOnCents / 100)}` : ""}`,
    landed: r.unitLandedCostCents == null ? null : money(r.unitLandedCostCents / 100), selling: r.unitPriceCents == null ? null : money(r.unitPriceCents / 100), provenance: [r.costSource, r.freightSource ? `Freight: ${r.freightSource}.` : null, r.currency !== "ZAR" && r.rate?.source ? `Exchange rate: ${r.rate.source}.` : null].filter(Boolean).join(" ") || null,
  };
}
const FREIGHT_UNAPPROVED = /test[- ]only|not approved/i;
const ESCALATION = /\+(\d+(?:\.\d+)?)% age escalation/i;
/** The line's warnings, deduplicated: the unapproved-freight note is ONE warning for the package, however many components carry it (every component still keeps its own text in the details). Pure. */
export function readyWarnings(skus: readonly AutoSkuFact[]): { warnings: ReadyWarning[]; freightNotes: string[] } {
  const freightNotes = [...new Set(skus.map((s) => s.freightNote).filter((n): n is string => !!n))];
  const warnings: ReadyWarning[] = [];
  const unapproved = skus.filter((s) => s.freightNote && FREIGHT_UNAPPROVED.test(s.freightNote));
  if (unapproved.length > 0) {
    const all = unapproved.length === skus.length;
    warnings.push({ code: "freight_unapproved", severity: "critical", text: `Freight uses a TEST-ONLY assumption, not an approved policy${all ? "" : ` (${unapproved.length} of ${skus.length} components)`}.` });
  }
  const aged = skus.map((s) => Number(ESCALATION.exec(s.costNote ?? "")?.[1] ?? 0)).filter((p) => p > 0);
  if (aged.length > 0) warnings.push({ code: "cost_aged", severity: "notice", text: `${aged.length} cost${aged.length === 1 ? " is" : "s are"} age-escalated (up to ${Math.max(...aged)}%).` });
  return { warnings, freightNotes };
}
/** Codes for which reading Cin7 again may produce a price (nothing about the product itself was wrong). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["not_read", "settings_incomplete", "fx_missing", "fx_stale", "freight_not_set", "freight_conflict"]);

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
  // A documented Budget basis (door BOM cost, fixed panel price): its own editor, never a supplier-cost or manual-price form.
  if (l.pricedBy === "budget_rate" || (l.budgetBasis && l.status !== "priced")) return { kind: "budget_basis", skus: [] };
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
  const ready: ReadyLine[] = [];
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
    // A DOCUMENTED BUDGET BASIS (door BOM cost + markup once; fixed control-panel price): confirmed by the Estimator, evidenced, provisional. No supplier cost exists or is asked for.
    if (l.pricedBy === "budget_rate" && l.status === "priced") {
      const ev = evidenceOf(l.itemKey as string);
      complete.push({ ...base, how: `Documented Budget basis, provisional (not a supplier cost)${ev?.state === "recorded" ? " · evidence recorded" : " · pricing evidence still to record"}`, unit: l.unitPrice, revenue: l.revenueExTax, provisional: true, budgetBasis: true, estimatorPriced: true, costState: "n/a", evidence: ev });
      continue;
    }
    if (l.budgetBasis && l.status !== "priced") {
      tasks.push({ ...base, kind: "budget_basis", tags: ["PRICE"], meta: `${qtyText(l.quantity)}`, why: l.budgetBasis.kind === "fixed_selling_price" ? "Confirm the fixed Budget selling price. No supplier cost, freight or markup applies." : "Confirm the documented Budget cost basis. The project markup is applied once, with no freight. No supplier is required.", group: "decision", indicators: { mapping: "open", price: "open", cost: "na", verified: "na" }, skus: [], action: "Confirm Budget basis" });
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
      const autoOnly = skus.length > 0 && skus.every((s) => rowOf(view.rows, s)?.costKind === "cin7_auto");
      if (autoOnly && !verified) {
        const qtyOf = (s: string): number | null => { const cs = (l.components ?? []).filter((c) => c.sku === s && c.quantity != null); return cs.length > 0 ? cs.reduce((a, c) => a + (c.quantity as number), 0) : l.sku === s ? l.quantity : null; };
        const facts2 = [...new Set(skus)].map((s) => autoFact(rowOf(view.rows, s)!, qtyOf(s)));
        ready.push({ id: l.itemKey as string, label: l.label, quantity: l.quantity, unit: l.unitPrice, revenue: l.revenueExTax, skus: facts2, totalCost: l.estimatedCost ?? null, ...readyWarnings(facts2) });
      }
      complete.push({ ...base, how: autoOnly && !verified ? `${l.sku ?? "Package"} · Automatically priced — awaiting Manager verification` : `${l.sku ?? "Package"} · supplier cost entered · ${verified ? "independently verified" : "awaiting Manager verification"}`, unit: l.unitPrice, revenue: l.revenueExTax, provisional: false, estimatorPriced: false, costState: verified ? "verified" : "unverified", ...(autoOnly && !verified ? { autoReady: true } : {}) });
      continue;
    }
    // ── a task ──
    if (isPackage && unresolvedParts) {
      tasks.push({ ...base, kind: "manual", tags: ["COMPONENTS", "PRICE"], meta: `${qtyText(l.quantity)} × ${l.components!.length} parts`, why: "No SKU yet. Manual price with a reason and evidence, provisional.", group: "decision", indicators: { mapping: "open", price: "open", cost: "na", verified: "na" }, skus: [], action: "Quote price" });
    } else if (isPackage) {
      const confirmed = facts.confirmedPackages.includes(l.itemKey as string);
      // Components that already carry a stored cost (an automatic one included) are never asked for again: only the missing ones are named.
      const uncosted = skus.filter((s) => { const r = rowOf(view.rows, s); return !r || r.costState === "missing"; }).length;
      const confirmOnly = !confirmed && uncosted === 0 && skus.length > 0;
      tasks.push({ ...base, kind: "package", confirmOnly, tags: ["COMPONENTS", "PRICE"], meta: `${qtyText(l.quantity)} × ${l.components!.length} components`, why: confirmOnly ? `Confirm the package. All ${l.components!.length} components already have a cost; none is asked for again.` : uncosted === 0 ? `Check the ${l.components!.length} component costs.` : uncosted < skus.length ? (confirmed ? `Cost the ${uncosted} component${uncosted === 1 ? "" : "s"} without a cost (the others are already costed).` : `Confirm the package, then cost the ${uncosted} component${uncosted === 1 ? "" : "s"} without a cost (the others are already costed).`) : confirmed ? `Cost ${l.components!.length} components (or a manual price with evidence).` : `Confirm the package, then cost ${l.components!.length} components (or a manual price with evidence).`, group: "decision", indicators: { mapping: confirmed ? "done" : "open", price: "open", cost: confirmed ? ci.cost : "open", verified: confirmed ? ci.verified : "wait" }, skus, action: confirmOnly ? "Confirm package" : confirmed ? "Cost components" : "Map and price" });
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
    totalLabel: totalKind === "partial" ? "PARTIAL TOTAL, EX VAT" : totalKind === "calculated" ? "CALCULATED TOTAL, NOT YET CONFIRMED" : "INDICATIVE TOTAL, CONFIRMED BY THE REP",
    // A partial total is always one of two things (an Estimator task exists only for a line that is not priced): lines without a confirmed price are left out, or another pricing blocker (a required charge, a Rep input) is open.
    totalNote: totalKind === "partial" ? (live.length - pricedLines.length > 0 ? `Indicative only. Not a contract value. ${live.length - pricedLines.length} line${live.length - pricedLines.length === 1 ? " has" : "s have"} no confirmed price and ${live.length - pricedLines.length === 1 ? "is" : "are"} left out.` : "Indicative only. Not a contract value. Pricing is incomplete: a required charge or a Rep input is still outstanding.")
      : totalKind === "calculated" ? "Not a contract value until the Rep confirms it and the costs are verified." : "Matches the amount the customer confirmed as indicative. It is not an approved price: the costs still need independent verification and a Manager must approve it.",
    totalExVat, pricedLinesExVat, pricedLineCount: pricedLines.length, chargesExVat, unpricedLineCount: live.length - pricedLines.length,
    vat: Math.round(totalExVat * 0.15 * 100) / 100, totalIncVat: Math.round(totalExVat * 1.15 * 100) / 100,
    confirmedCents: confirmed, differenceCents: confirmed === null ? null : totalCents - confirmed,
    checks: { mapping: { done: mappingDone, of: mappingOf }, price: { done: pricedLines.length, of: live.length }, cost: { done: costDone, of: costOf }, verified: { done: Math.max(verifiedDone, verifiedN), of: Math.max(required, costOf) } },
    marginLabel: !marginFig ? "none" : marginVerified ? "verified" : "indicative",
    marginNote: !marginFig ? "A margin appears once costs are entered, labelled indicative. It is called verified only after a Manager verifies the costs." : marginVerified ? "Every supplier cost has been independently verified." : "Indicative, unverified: it rests on supplier costs a Manager has not yet verified.",
    blockers,
  };

  // ── automatic pricing: three clearly separated groups, counting only what genuinely needs a person ──
  // A product that has a stored cost (automatic or entered) is NEVER an exception and never asked for again; an exception is a product of an open task that has no cost, with the SPECIFIC stored reason.
  // The server states whether Price from Cin7 can run (independently of the Rep-pricing flag); callers that predate it fall back to "the pricing is entirely automatic".
  const cin7Ok = facts.cin7Pricing ? facts.cin7Pricing.available : view.autoOwned;
  const exMap = new Map<string, PricingException>();
  for (const t of ordered) {
    if (t.kind === "m75" || t.kind === "product" || t.kind === "manual") continue;
    for (const sku of t.skus) {
      const r = rowOf(view.rows, sku);
      if (r && r.status !== "no_input" && !(r.status === "not_priced" && t.kind === "cost")) continue;
      const prev = exMap.get(sku);
      if (prev) { if (!prev.usedBy.includes(t.label)) prev.usedBy.push(t.label); continue; }
      const f = r?.autoFlag ?? null;
      const stored = r && r.status === "not_priced"
        ? { reason: `Cannot be priced yet (${r.issues[0] ?? "check the rate and the cost"}).`, action: "Open it and check the cost and the rate.", retryable: false }
        : f ? { reason: f.text, action: f.action, retryable: RETRYABLE_CODES.has(f.code) }
        : { reason: "No supplier cost has been recorded for this product.", action: cin7Ok ? "Use Price from Cin7, or enter the supplier cost yourself." : "Enter the supplier cost yourself.", retryable: facts.cin7Pricing ? true : view.autoOwned };
      exMap.set(sku, { sku, usedBy: [t.label], reason: stored.reason, action: stored.action, taskId: t.id, retryable: stored.retryable });
    }
  }
  const exceptions = [...exMap.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  const autoPricedN = view.rows.filter((r) => r.usedBy.length > 0 && r.costKind === "cin7_auto" && r.status !== "no_input" && r.costState !== "verified").length;
  const wantsRetry = exceptions.filter((e) => e.retryable).length;
  const retryable = facts.canEdit && cin7Ok ? wantsRetry : 0;
  const unavailableReason = facts.canEdit && !cin7Ok && wantsRetry > 0 ? (facts.cin7Pricing?.reason ?? "Price from Cin7 is not available for this quotation.") : null;
  const auto: AutoView = { active: view.rows.some((r) => r.costKind === "cin7_auto" || !!r.autoFlag), ready, autoPriced: autoPricedN, needConfirmation: ordered.filter((t) => t.kind !== "cost").length, exceptions, retryable, canPrice: facts.canEdit && cin7Ok, unavailableReason };

  // ── the one next action: the first unmet gate (Rep reconfirmation, then Manager verification, then Estimator sign-off, then Manager approval) ──
  let next: NextAction;
  const first = ordered[0];
  const g0 = gates[0];
  const taskHeadline = (t: Omit<WorkspaceTask, "n"> & { n: number }): string => (t.kind === "m75" ? `Enter the M75 system price` : t.kind === "cost" ? `Enter the supplier cost for ${t.label.toLowerCase()}` : t.kind === "product" ? `Choose and price ${t.label.toLowerCase()}` : t.kind === "manual" ? `Quote a manual price for ${t.label.toLowerCase()}` : t.confirmOnly ? `Confirm ${t.label.toLowerCase()}` : `Confirm and cost ${t.label.toLowerCase()}`);
  if (facts.state === "MANAGER_APPROVED_FINAL") next = { kind: "approved", headline: "Approved", detail: "This quotation is approved and sealed.", button: null };
  else if (facts.state === "REP_DRAFT" && (facts.revision ?? 1) > 1 && !facts.canEdit) next = { kind: "wait_rep", headline: "Waiting for the Rep to reconfirm the amount and submit it again", detail: "The quotation is with the Rep. You can read it here; nothing changes until it comes back.", button: null };
  else if (g0?.id === "tasks" && facts.canEdit && retryable > 0 && ordered.every((t) => t.kind === "cost")) {
    // Only exceptions remain and Cin7 may still price some of them: ONE obvious action reads them (decisions to confirm always come first).
    next = { kind: "price_from_cin7", headline: `Price ${retryable} product${retryable === 1 ? "" : "s"} from Cin7`, detail: "Reads each supplier cost from Cin7 (read only), applies the commercial settings, and leaves the costs awaiting Manager verification.", button: "Price from Cin7" };
  } else if (g0?.id === "tasks") {
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

  return { tasks: ordered, repItems, complete, summary, next, auto };
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
