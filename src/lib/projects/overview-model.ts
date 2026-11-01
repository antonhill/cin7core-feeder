// Projects - the EXECUTIVE OVERVIEW view-model (PURE). Everything the management dashboard shows is derived here from rows that were already loaded
// by existing authoritative loaders; nothing here reads Cin7, writes anything, or calls a database. Every number on the screen is therefore testable.
//
// Rules this module enforces:
//  * All commercial amounts are EX VAT integer cents (claims use subtotal_cents, never total_cents).
//  * The revised contract is the base project's own figure (original + APPROVED variations). Variation billing scopes are used only for what has
//    been billed against them; their contract values are never added on top of the revised contract again.
//  * Unknown is null, never 0. A total containing an unknown member is unknown.
//  * Physical progress (what Cin7 holds), commercial approval (what a manager approved) and invoicing (what Cin7 invoices exist) are separate
//    measures and are never combined into one percentage.
//  * Cost and margin appear ONLY for a viewer who may see cost, even if cost figures were supplied.
//  * Stock is Cin7's account-wide stock, never presented as reserved for the project.
import type { MarginFigures } from "./margin-figures";
import type { PhysicalException, PhysicalRow } from "./physical-status";
import { formatCents, type ProjectView, type StageView } from "./project-view";

export type OverviewTab = "stages" | "components" | "claims" | "variations" | "deliveries" | "physical" | "procurement" | "profitability";
export type OverviewLink = { kind: "tab"; tab: OverviewTab } | { kind: "href"; href: string };

// ── inputs (already loaded by existing loaders) ─────────────────────────────────────────────────────────────

export interface OverviewScopeInput {
  projectId: string;
  scope: "BASE" | "VARIATION";
  label: string;
  variationCode: string | null;
  /** Linked Cin7 Sale number, or null when no Sale is linked. */
  saleNumber: string | null;
  view: ProjectView;
  /** Unresolved/unmapped approved-scope items for this scope (the product register). */
  scopeBlockers: string[];
}
export interface OverviewEstimateInput {
  revised: MarginFigures;
  incomplete: boolean;
  uncostedSellingCents: number;
  exceptions: Array<{ code: string; scope: string; message: string }>;
}
export interface PhysicalSectionInput {
  label: string;
  scope: "BASE" | "VARIATION";
  linked: boolean;
  saleNumber: string | null;
  rows: PhysicalRow[];
  exceptions: PhysicalException[];
  scopeBlockers: string[];
}
export type PhysicalLoad =
  | { state: "not_loaded" }
  | { state: "error"; error: string }
  | { state: "loaded"; asOf: string; sections: PhysicalSectionInput[] };
export interface DeliverySummaryInput { total: number; dispatched: number; inProgress: number; cancelled: number; latestActivityAt: string | null }

export interface OverviewInput {
  scopes: OverviewScopeInput[];
  /** Approved variations with no billing project yet: part of the revised contract, not yet invoiceable. */
  unbilledApprovedVariations: Array<{ code: string; amountCents: number }>;
  /** Null = could not be read (unknown), never "no deliveries". */
  deliveries: DeliverySummaryInput | null;
  physical: PhysicalLoad;
  /** Frozen estimates (administrators only). Ignored unless viewer.isAdmin. */
  estimates: OverviewEstimateInput | null;
  viewer: { isAdmin: boolean };
}

// ── outputs ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Kpi {
  id: string;
  label: string;
  /** Money in ex-VAT cents; null = unknown. */
  cents: number | null;
  /** Percentage with two decimals, for the margin KPI only. */
  percent?: number | null;
  /** Free count shown beside the value (for example "2 claims"). */
  count?: number;
  hint: string;
  /** Why the value is unknown. */
  unknown?: string;
  tone: "default" | "accent" | "warning";
}
export interface MilestoneRow {
  id: string; name: string; valueCents: number; reportedBps: number; approvedBps: number; earnedCents: number;
  committedCents: number; remainingCents: number; claimableCents: number; belowCommitted: boolean;
}
export interface MilestoneGroup {
  projectId: string; scope: "BASE" | "VARIATION"; label: string; rows: MilestoneRow[];
  totals: { valueCents: number; earnedCents: number; committedCents: number; remainingCents: number; claimableCents: number };
}
export interface PhysicalOverviewRow {
  sku: string; name: string;
  /** Approved quantity (the quotation / variation scope), falling back to the Sale's ordered quantity. */
  approved: number | null; ordered: number | null; shipped: number | null; remaining: number | null;
  /** Cin7 stock for the SKU: ACCOUNT-WIDE, not reserved for this project. */
  availableAccountWide: number | null; shortfall: number | null;
}
export interface PhysicalOverview {
  state: "not_loaded" | "error" | "loaded";
  error?: string;
  asOf?: string;
  sections: Array<{ label: string; scope: "BASE" | "VARIATION"; linked: boolean; saleNumber: string | null; rows: PhysicalOverviewRow[] }>;
  totals: { orderedUnits: number | null; shippedUnits: number | null; remainingUnits: number | null; skuCount: number; unknownRowCount: number; shortSkuCount: number } | null;
  shortages: Array<{ section: string; sku: string; name: string; remaining: number; availableAccountWide: number | null; shortfall: number }>;
  /** Deliveries recorded in the Toolbox delivery register; null = could not be read. */
  deliveries: DeliverySummaryInput | null;
  notes: string[];
}
export interface ReconClaim {
  claimNumber: string; claimStatus: string; exVatCents: number;
  cin7Kind: string; cin7Label: string; invoiceNumber: string | null; reconciled: boolean;
}
export interface ReconScope {
  projectId: string; scope: "BASE" | "VARIATION"; label: string; saleNumber: string | null; saleLinked: boolean;
  claims: ReconClaim[];
  summary: { invoiceCount: number; reconciledCount: number; notPostedCount: number; problemCount: number; invoicedExVatCents: number };
}
export interface ExceptionItem {
  id: string;
  severity: "critical" | "attention" | "info";
  area: "Claims" | "Cin7" | "Delivery" | "Stock" | "Products" | "Commercial" | "Cost";
  title: string;
  detail: string;
  link: OverviewLink;
  linkLabel: string;
}
export interface ProjectOverview {
  header: { reference: string; name: string; customer: string; status: string; originatingQuote: string | null };
  /** All commercial amounts are ex VAT. */
  kpis: Kpi[];
  costVisible: boolean;
  milestones: MilestoneGroup[];
  physical: PhysicalOverview;
  reconciliation: { scopes: ReconScope[]; invoicedExVatCents: number; cin7Note: string; xeroNote: string };
  exceptions: ExceptionItem[];
}

export const XERO_NOTE = "Xero bank and payment reconciliation is not connected or verified in this view. A Cin7 invoice that is reconciled here means the Toolbox read the invoice back from Cin7 and it matches the approved claim; it does not mean the customer has paid.";
export const CIN7_NOTE = "Cin7 invoice reconciliation: the Toolbox compares each Cin7 invoice with the approved claim it was raised for. Draft invoices are shown as drafts.";
export const STOCK_NOTE = "Stock shown is Cin7 stock across the whole account. It is not reserved for this project.";
export const PICK_PACK_NOTE = "Shipped quantities come from fulfilments Cin7 reports as shipped. Picked and packed quantities that are not yet shipped are not part of this read.";

const LIVE_INVOICE = new Set(["DRAFT_CREATED", "AUTHORISED", "CREATED_OTHER"]);
const sumOrNull = (xs: ReadonlyArray<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((n, x) => n + (x as number), 0));
const claimLabel = (c: { claim_number: string }) => c.claim_number;

function milestoneGroup(s: OverviewScopeInput): MilestoneGroup {
  const rows = s.view.stages.map((st: StageView): MilestoneRow => ({
    id: st.id, name: st.name, valueCents: st.valueCents, reportedBps: st.reportedBps, approvedBps: st.approvedBps, earnedCents: st.earnedCents,
    committedCents: st.committedCents, remainingCents: st.remainingCents, claimableCents: st.claimableCents, belowCommitted: st.belowCommitted,
  }));
  const sum = (f: (r: MilestoneRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    projectId: s.projectId, scope: s.scope, label: s.label, rows,
    totals: { valueCents: sum((r) => r.valueCents), earnedCents: sum((r) => r.earnedCents), committedCents: sum((r) => r.committedCents), remainingCents: sum((r) => r.remainingCents), claimableCents: sum((r) => r.claimableCents) },
  };
}

function reconScope(s: OverviewScopeInput): ReconScope {
  // Claims that have, or had, a real chance of a Cin7 document: value-reserving ones plus a confirmed failure. Drafts, claims awaiting approval and cancelled drafts are not reconciliation items.
  const relevant = s.view.claims.filter((c) => c.reserves || c.status === "FAILED_CONFIRMED_NO_WRITE");
  const claims: ReconClaim[] = relevant.map((c) => ({
    claimNumber: claimLabel(c), claimStatus: c.status, exVatCents: c.subtotal_cents,
    cin7Kind: c.cin7Status.kind, cin7Label: c.cin7Status.label, invoiceNumber: c.cin7Status.invoiceNumber, reconciled: c.cin7Status.reconciled,
  }));
  const live = claims.filter((c) => LIVE_INVOICE.has(c.cin7Kind));
  return {
    projectId: s.projectId, scope: s.scope, label: s.label, saleNumber: s.saleNumber, saleLinked: s.saleNumber !== null, claims,
    summary: {
      invoiceCount: live.length, reconciledCount: live.filter((c) => c.reconciled).length,
      notPostedCount: claims.filter((c) => c.cin7Kind === "NOT_POSTED" || c.cin7Kind === "POSTING").length,
      problemCount: claims.filter((c) => c.cin7Kind === "UNCERTAIN" || c.cin7Kind === "FAILED").length,
      invoicedExVatCents: live.reduce((n, c) => n + c.exVatCents, 0),
    },
  };
}

function physicalOverview(i: OverviewInput): PhysicalOverview {
  const notes = [STOCK_NOTE, PICK_PACK_NOTE];
  const deliveries = i.deliveries;
  if (i.physical.state !== "loaded") {
    return { state: i.physical.state, ...(i.physical.state === "error" ? { error: i.physical.error } : {}), sections: [], totals: null, shortages: [], deliveries, notes };
  }
  const sections = i.physical.sections.map((s) => ({
    label: s.label, scope: s.scope, linked: s.linked, saleNumber: s.saleNumber,
    rows: s.rows.map((r): PhysicalOverviewRow => ({
      sku: r.sku, name: r.name, approved: r.quoted ?? r.ordered, ordered: r.ordered, shipped: r.shipped, remaining: r.remaining,
      availableAccountWide: r.available, shortfall: r.shortfall,
    })),
  }));
  const rows = sections.flatMap((s) => s.rows);
  const shortages = sections.flatMap((s) => s.rows.filter((r) => r.shortfall !== null && r.shortfall > 0 && r.remaining !== null).map((r) => ({
    section: s.label, sku: r.sku, name: r.name, remaining: r.remaining as number, availableAccountWide: r.availableAccountWide, shortfall: r.shortfall as number,
  })));
  return {
    state: "loaded", asOf: i.physical.asOf, sections,
    totals: {
      orderedUnits: sumOrNull(rows.map((r) => r.ordered)), shippedUnits: sumOrNull(rows.map((r) => r.shipped)), remainingUnits: sumOrNull(rows.map((r) => r.remaining)),
      skuCount: rows.length, unknownRowCount: rows.filter((r) => r.remaining === null).length, shortSkuCount: shortages.length,
    },
    shortages, deliveries, notes,
  };
}

export function buildProjectOverview(i: OverviewInput): ProjectOverview {
  const base = i.scopes.filter((s) => s.scope === "BASE");
  if (base.length !== 1) throw new Error(`An overview needs exactly one original project scope; found ${base.length}.`);
  const b = base[0];
  const bv = b.view;
  const c = bv.commercial;
  const ids = i.scopes.map((s) => s.projectId);
  if (new Set(ids).size !== ids.length) throw new Error("A project scope was supplied twice.");
  const scopes = i.scopes;

  // ── C1 summary (ex VAT) ──
  const billedCents = scopes.reduce((n, s) => n + s.view.commercial.committedCents, 0);
  const remainingCents = c.revisedContractCents - billedCents;
  const allClaims = scopes.flatMap((s) => s.view.claims.map((cl) => ({ scope: s, claim: cl })));
  const outstanding = allClaims.filter(({ claim }) => claim.reserves && (claim.cin7Status.kind === "NOT_POSTED" || claim.cin7Status.kind === "POSTING"));
  const costVisible = i.viewer.isAdmin;
  const kpis: Kpi[] = [
    { id: "original", label: "Original contract", cents: c.originalContractCents, hint: "Ex VAT", tone: "default" },
    { id: "variations", label: "Approved variations", cents: c.approvedVariationsCents, hint: "Approved variations only", tone: "default" },
    { id: "revised", label: "Revised contract", cents: c.revisedContractCents, hint: "Original + approved variations", tone: "accent" },
  ];
  if (costVisible) {
    const e = i.estimates;
    if (!e) {
      const reason = "The frozen cost estimate could not be loaded.";
      kpis.push({ id: "cost", label: "Estimated project cost", cents: null, unknown: reason, hint: "Frozen at quotation approval", tone: "default" });
      kpis.push({ id: "gp", label: "Estimated gross profit", cents: null, percent: null, unknown: reason, hint: "Estimate, not actual", tone: "default" });
    } else {
      const why = e.incomplete ? "A scope has no estimated cost, so cost and margin are withheld." : "No frozen cost estimate exists for this project.";
      const unc = e.uncostedSellingCents > 0 ? ` Excludes ${formatCents(e.uncostedSellingCents)} of selling value with no recorded cost.` : "";
      kpis.push({ id: "cost", label: "Estimated project cost", cents: e.revised.costCents, ...(e.revised.costCents === null ? { unknown: why } : {}), hint: `Frozen at quotation approval.${unc}`, tone: "default" });
      kpis.push({ id: "gp", label: "Estimated gross profit", cents: e.revised.gpCents, percent: e.revised.marginPct, ...(e.revised.gpCents === null ? { unknown: why } : {}), hint: "Estimate, not actual. Margin = profit ÷ selling value.", tone: "default" });
    }
  }
  kpis.push(
    { id: "billed", label: "Billed / committed", cents: billedCents, hint: "Approved, sent or uncertain claims across the original project and its variations", tone: "default" },
    { id: "remaining", label: "Remaining commercial value", cents: remainingCents, hint: "Revised contract − billed / committed", tone: remainingCents < 0 ? "warning" : "default" },
    { id: "outstanding", label: "Approved claims not yet in Cin7", cents: outstanding.reduce((n, { claim }) => n + claim.subtotal_cents, 0), count: outstanding.length, hint: "Approved claims with no Cin7 invoice yet", tone: outstanding.length > 0 ? "warning" : "default" },
  );

  // ── C2 milestones ──
  const milestones = scopes.map(milestoneGroup);

  // ── C3 / C4 ──
  const physical = physicalOverview(i);
  const recon = scopes.map(reconScope);

  // ── C5 exceptions ──
  const ex: ExceptionItem[] = [];
  const add = (e: ExceptionItem) => ex.push(e);
  const pending = allClaims.filter(({ claim }) => claim.status === "READY_FOR_APPROVAL");
  if (pending.length) {
    const first = pending.find(({ claim }) => claim.approval)?.claim.approval;
    add({
      id: "claims-awaiting-approval", severity: "attention", area: "Claims", title: `${pending.length} claim${pending.length === 1 ? "" : "s"} awaiting approval`,
      detail: pending.map(({ claim }) => claim.claim_number).join(", "),
      link: first ? { kind: "href", href: `/approvals/${first.requestId}` } : { kind: "tab", tab: "claims" }, linkLabel: first ? "Open in Approvals" : "Open claims",
    });
  }
  if (outstanding.length) {
    add({ id: "approved-not-posted", severity: "attention", area: "Cin7", title: `${outstanding.length} approved claim${outstanding.length === 1 ? "" : "s"} not yet invoiced in Cin7`, detail: outstanding.map(({ claim }) => claim.claim_number).join(", "), link: { kind: "tab", tab: "claims" }, linkLabel: "Open claims" });
  }
  for (const r of recon) {
    const bad = r.claims.filter((cl) => cl.cin7Kind === "UNCERTAIN" || cl.cin7Kind === "FAILED");
    if (bad.length) add({ id: `posting-problem-${r.projectId}`, severity: "critical", area: "Cin7", title: `${r.label}: ${bad.length} Cin7 posting${bad.length === 1 ? "" : "s"} failed or uncertain`, detail: bad.map((x) => `${x.claimNumber} (${x.cin7Label})`).join(", "), link: { kind: "tab", tab: "claims" }, linkLabel: "Reconcile in claims" });
    const unrec = r.claims.filter((cl) => LIVE_INVOICE.has(cl.cin7Kind) && !cl.reconciled);
    if (unrec.length) add({ id: `unreconciled-${r.projectId}`, severity: "attention", area: "Cin7", title: `${r.label}: ${unrec.length} Cin7 invoice${unrec.length === 1 ? "" : "s"} created but not reconciled`, detail: unrec.map((x) => x.invoiceNumber ?? x.claimNumber).join(", "), link: { kind: "tab", tab: "claims" }, linkLabel: "Reconcile with Cin7" });
    if (!r.saleLinked && r.claims.length > 0) add({ id: `no-sale-${r.projectId}`, severity: "attention", area: "Cin7", title: `${r.label}: no Cin7 Sale is linked`, detail: "Claims exist but no Advanced Sale is linked to this scope.", link: { kind: "tab", tab: r.scope === "BASE" ? "claims" : "variations" }, linkLabel: "Open Cin7 Sale" });
  }
  const claimable = scopes.reduce((n, s) => n + s.view.commercial.claimableCents, 0);
  if (claimable > 0) add({ id: "claimable-now", severity: "info", area: "Commercial", title: "Approved progress is ready to claim", detail: `${formatCents(claimable)} (ex VAT) is approved for billing and not yet claimed.`, link: { kind: "tab", tab: "claims" }, linkLabel: "Prepare a claim" });
  const openMilestones = milestones.flatMap((g) => g.rows.map((r) => ({ g, r }))).filter(({ r }) => r.remainingCents > 0);
  if (openMilestones.length) add({ id: "open-milestones", severity: "info", area: "Commercial", title: `${openMilestones.length} billing milestone${openMilestones.length === 1 ? "" : "s"} not fully billed`, detail: openMilestones.map(({ g, r }) => `${g.scope === "BASE" ? "" : g.label + ": "}${r.name}`).join(", "), link: { kind: "tab", tab: "stages" }, linkLabel: "Open stages" });
  for (const g of milestones) for (const r of g.rows) if (r.belowCommitted) add({ id: `below-committed-${r.id}`, severity: "critical", area: "Commercial", title: `${g.label}: ${r.name} is billed above its approved completion`, detail: "Approved completion is below what is already committed; this needs a manager's attention.", link: { kind: "tab", tab: "stages" }, linkLabel: "Open stages" });
  if (!c.scheduleBalanced) add({ id: "schedule-unbalanced", severity: "critical", area: "Commercial", title: "Stage values do not add up to the contract", detail: "Claiming is blocked until the schedule balances.", link: { kind: "tab", tab: "stages" }, linkLabel: "Open stages" });
  const scopeContractSum = scopes.filter((s) => s.scope === "VARIATION").reduce((n, s) => n + s.view.commercial.originalContractCents, 0) + i.unbilledApprovedVariations.reduce((n, u) => n + u.amountCents, 0);
  if (scopeContractSum !== c.approvedVariationsCents) add({ id: "variation-mismatch", severity: "critical", area: "Commercial", title: "Variation values do not reconcile", detail: "The variation billing scopes plus unbilled approved variations differ from the approved variations in the revised contract.", link: { kind: "tab", tab: "variations" }, linkLabel: "Open variations" });
  if (i.unbilledApprovedVariations.length) add({ id: "unbilled-variations", severity: "info", area: "Commercial", title: `${i.unbilledApprovedVariations.length} approved variation${i.unbilledApprovedVariations.length === 1 ? "" : "s"} not yet set up for billing`, detail: i.unbilledApprovedVariations.map((u) => u.code).join(", "), link: { kind: "tab", tab: "variations" }, linkLabel: "Open variations" });

  // unmapped products: the register is known without Cin7, so this does not depend on the Cin7 read
  const blockers = new Set<string>();
  for (const s of scopes) for (const m of s.scopeBlockers) blockers.add(`${s.label}: ${m}`);
  if (i.physical.state === "loaded") for (const s of i.physical.sections) for (const m of s.scopeBlockers) blockers.add(`${s.label}: ${m}`);
  if (blockers.size) add({ id: "unmapped-products", severity: "critical", area: "Products", title: `${blockers.size} product${blockers.size === 1 ? "" : "s"} not mapped to Cin7`, detail: [...blockers].slice(0, 5).join(" | ") + (blockers.size > 5 ? ` | and ${blockers.size - 5} more` : ""), link: { kind: "tab", tab: "components" }, linkLabel: "Resolve products" });

  if (i.physical.state === "error") add({ id: "physical-unreadable", severity: "attention", area: "Delivery", title: "Fulfilment could not be read from Cin7", detail: i.physical.error, link: { kind: "tab", tab: "physical" }, linkLabel: "Open Products & Stock" });
  if (physical.state === "loaded" && physical.totals) {
    const t = physical.totals;
    if (t.remainingUnits !== null && t.remainingUnits > 0) add({ id: "outstanding-delivery", severity: "attention", area: "Delivery", title: `${t.remainingUnits} unit${t.remainingUnits === 1 ? "" : "s"} still to ship`, detail: `${t.shippedUnits ?? "Unknown"} of ${t.orderedUnits ?? "unknown"} shipped.`, link: { kind: "tab", tab: "deliveries" }, linkLabel: "Open deliveries" });
    if (t.unknownRowCount > 0) add({ id: "physical-unknown", severity: "attention", area: "Delivery", title: `${t.unknownRowCount} product line${t.unknownRowCount === 1 ? "" : "s"} could not be read`, detail: "Their shipped or remaining quantity is unknown, not zero.", link: { kind: "tab", tab: "physical" }, linkLabel: "Open Products & Stock" });
    if (physical.shortages.length) add({ id: "stock-shortages", severity: "attention", area: "Stock", title: `${physical.shortages.length} product${physical.shortages.length === 1 ? "" : "s"} short of free stock`, detail: physical.shortages.slice(0, 5).map((s) => `${s.sku} (short ${s.shortfall})`).join(", ") + " - account-wide stock, an estimate.", link: { kind: "tab", tab: "physical" }, linkLabel: "Open Products & Stock" });
  }
  if (i.deliveries && i.deliveries.inProgress > 0) add({ id: "deliveries-in-progress", severity: "info", area: "Delivery", title: `${i.deliveries.inProgress} deliver${i.deliveries.inProgress === 1 ? "y" : "ies"} planned or loading`, detail: "Not yet dispatched.", link: { kind: "tab", tab: "deliveries" }, linkLabel: "Open deliveries" });

  if (costVisible && i.estimates) {
    for (const e of i.estimates.exceptions) {
      if (e.code === "OVER_BILLED") add({ id: `cost-${e.code}-${e.scope}`, severity: "critical", area: "Cost", title: `${e.scope}: billed above the contract`, detail: e.message, link: { kind: "tab", tab: "profitability" }, linkLabel: "Open profitability" });
      else if (e.code === "COST_UNKNOWN") add({ id: `cost-${e.code}-${e.scope}`, severity: "attention", area: "Cost", title: `${e.scope}: no estimated cost`, detail: e.message, link: { kind: "tab", tab: "profitability" }, linkLabel: "Open profitability" });
      else if (e.code === "POSTING_MISMATCH") add({ id: `cost-${e.code}-${e.scope}`, severity: "critical", area: "Cin7", title: `${e.scope}: a Cin7 invoice differs from its claim`, detail: e.message, link: { kind: "tab", tab: "claims" }, linkLabel: "Open claims" });
    }
    if (i.estimates.revised.marginPct !== null && i.estimates.revised.gpCents !== null && i.estimates.revised.gpCents < 0) add({ id: "negative-margin", severity: "critical", area: "Cost", title: "Estimated margin is negative", detail: "The frozen cost estimate exceeds the selling value.", link: { kind: "tab", tab: "profitability" }, linkLabel: "Open profitability" });
  }
  const rank = { critical: 0, attention: 1, info: 2 } as const;
  ex.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    header: { reference: bv.project.project_reference, name: bv.project.name, customer: bv.project.customer_name, status: bv.project.status, originatingQuote: bv.project.originating_quote_ref },
    kpis, costVisible, milestones, physical,
    reconciliation: { scopes: recon, invoicedExVatCents: recon.reduce((n, r) => n + r.summary.invoicedExVatCents, 0), cin7Note: CIN7_NOTE, xeroNote: XERO_NOTE },
    exceptions: ex,
  };
}
