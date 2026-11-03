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
import type { ClaimCin7Status } from "./claim-cin7-status";
import type { MarginFigures } from "./margin-figures";
import type { PhysicalException, PhysicalRow } from "./physical-status";
import { commercialBillingFromView, type CommercialBillingResult } from "./commercial-billing-state";
import { invoiceAuthorisation, type VerifiedRef } from "./invoice-authorisation";
import { formatSast } from "@/lib/approvals/time";
import { formatBps, formatCents, type ProjectView, type StageView } from "./project-view";

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
  | { state: "loaded"; /** When Cin7 was read; null if the read did not say. Never invented. */ asOf: string | null; sections: PhysicalSectionInput[] };
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
  asOf?: string | null;
  sections: Array<{ label: string; scope: "BASE" | "VARIATION"; linked: boolean; saleNumber: string | null; rows: PhysicalOverviewRow[] }>;
  totals: { orderedUnits: number | null; shippedUnits: number | null; remainingUnits: number | null; skuCount: number; unknownRowCount: number; shortSkuCount: number } | null;
  /** One entry per SKU across ALL scopes: needs are summed and compared once with the single account-wide stock figure. */
  shortages: Array<{ sections: string[]; sku: string; name: string; remaining: number; availableAccountWide: number; shortfall: number }>;
  /** Deliveries recorded in the Toolbox delivery register; null = could not be read. */
  deliveries: DeliverySummaryInput | null;
  notes: string[];
}
export interface ReconClaim {
  claimNumber: string; claimStatus: string; exVatCents: number;
  cin7Kind: string; cin7Label: string; invoiceNumber: string | null; reconciled: boolean;
  /** UX-006g1 (additive): the claim id and the recorded posting evidence, so a screen can show a VERIFIED status (invoice-authorisation.ts) instead of the snapshot label. */
  claimId: string; cin7Status: ClaimCin7Status;
  /** CREATED invoice with a recorded AMOUNT_MISMATCH (named, never shown as plain "not reconciled yet"). */
  mismatch: boolean;
}
export interface ReconScope {
  projectId: string; scope: "BASE" | "VARIATION"; label: string; saleNumber: string | null; saleLinked: boolean;
  claims: ReconClaim[];
  summary: { invoiceCount: number; reconciledCount: number; notPostedCount: number; uncertainCount: number; retryableCount: number; invoicedExVatCents: number; mismatchCount: number };
  /** Commercial billing state of this scope, from the shared derivation (postings + stage ledger, never the claim status). */
  billing: CommercialBillingResult;
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
export const CIN7_NOTE = "Cin7 invoice reconciliation: the Toolbox compares each Cin7 invoice with the approved claim it was raised for. The invoice status shown (draft, authorised) is the status last recorded when the Toolbox posted or reconciled the invoice; it is not a live read of Cin7, and an invoice can be authorised in Cin7 afterwards.";
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
    claimId: c.id, cin7Status: c.cin7Status, claimNumber: claimLabel(c), claimStatus: c.status, exVatCents: c.subtotal_cents,
    cin7Kind: c.cin7Status.kind, cin7Label: c.cin7Status.kind === "FAILED" ? "Not created in Cin7 - can be retried" : c.cin7Status.label, invoiceNumber: c.cin7Status.invoiceNumber, reconciled: c.cin7Status.reconciled, mismatch: c.cin7Status.mismatch,
  }));
  const live = claims.filter((c) => LIVE_INVOICE.has(c.cin7Kind));
  return {
    projectId: s.projectId, scope: s.scope, label: s.label, saleNumber: s.saleNumber, saleLinked: s.saleNumber !== null, claims,
    summary: {
      invoiceCount: live.length, reconciledCount: live.filter((c) => c.reconciled).length,
      notPostedCount: claims.filter((c) => c.cin7Kind === "NOT_POSTED" || c.cin7Kind === "POSTING").length,
      // UNCERTAIN: Cin7's outcome is unknown, so it must be reconciled before anything is retried. FAILED: Cin7 confirmed nothing was created; posting may be tried again.
      uncertainCount: claims.filter((c) => c.cin7Kind === "UNCERTAIN").length,
      retryableCount: claims.filter((c) => c.cin7Kind === "FAILED").length,
      invoicedExVatCents: live.reduce((n, c) => n + c.exVatCents, 0),
      mismatchCount: claims.filter((c) => c.mismatch).length,
    },
    // The approved variation amount is the billing project's contract (view.commercial.originalContractCents) - the SAME value the Variations panel reads as ScopeSummary.contractCents.
    billing: commercialBillingFromView(s.view, s.scope, s.scope === "VARIATION" ? { approvedAmountCents: s.view.commercial.originalContractCents, billingStarted: true } : undefined),
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
  // A SKU can be on the original Sale AND on a variation Sale, but Cin7 stock is ONE account-wide figure. Summing each scope's own shortfall would count the
  // same stock twice (and miss a shortage that only exists in total), so needs are summed per SKU and compared ONCE. Unknown stays unknown: if any scope's
  // outstanding quantity or the stock is unreadable, that SKU is not reported as short. If scopes disagree on stock, the lower (safer) figure is used.
  const needs = new Map<string, { name: string; sections: string[]; remaining: number; unknown: boolean; available: number | null }>();
  for (const sec of sections) for (const r of sec.rows) {
    const n = needs.get(r.sku) ?? { name: r.name, sections: [], remaining: 0, unknown: false, available: null };
    n.sections.push(sec.label);
    if (r.remaining === null) n.unknown = true; else n.remaining += r.remaining;
    if (r.availableAccountWide !== null) n.available = n.available === null ? r.availableAccountWide : Math.min(n.available, r.availableAccountWide);
    needs.set(r.sku, n);
  }
  const shortages = [...needs.entries()]
    .filter(([, n]) => !n.unknown && n.available !== null && n.remaining > n.available)
    .map(([sku, n]) => ({ sections: n.sections, sku, name: n.name, remaining: n.remaining, availableAccountWide: n.available as number, shortfall: n.remaining - (n.available as number) }));
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
    { id: "revised", label: "Revised contract value", cents: c.revisedContractCents, hint: "Original + approved variations", tone: "accent" },
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
    // One pending claim links straight to its request; several link to the Approvals list (not arbitrarily to the first).
    const one = pending.length === 1 ? pending[0].claim.approval : null;
    add({
      id: "claims-awaiting-approval", severity: "attention", area: "Claims", title: `${pending.length} claim${pending.length === 1 ? "" : "s"} awaiting approval`,
      detail: pending.map(({ claim }) => claim.claim_number).join(", "),
      link: one ? { kind: "href", href: `/approvals/${one.requestId}` } : pending.length > 1 ? { kind: "href", href: "/approvals" } : { kind: "tab", tab: "claims" },
      linkLabel: one ? "Open in Approvals" : pending.length > 1 ? `Open Approvals (${pending.length} pending)` : "Open claims",
    });
  }
  if (outstanding.length) {
    add({ id: "approved-not-posted", severity: "attention", area: "Cin7", title: `${outstanding.length} approved claim${outstanding.length === 1 ? "" : "s"} not yet invoiced in Cin7`, detail: outstanding.map(({ claim }) => claim.claim_number).join(", "), link: { kind: "tab", tab: "claims" }, linkLabel: "Open claims" });
  }
  for (const r of recon) {
    const uncertain = r.claims.filter((cl) => cl.cin7Kind === "UNCERTAIN");
    if (uncertain.length) add({ id: `posting-problem-${r.projectId}`, severity: "critical", area: "Cin7", title: `${r.label}: ${uncertain.length} Cin7 posting${uncertain.length === 1 ? "" : "s"} with an uncertain outcome`, detail: `${uncertain.map((x) => x.claimNumber).join(", ")}. Cin7 did not confirm the result: reconcile before anything is retried.`, link: { kind: "tab", tab: "claims" }, linkLabel: "Reconcile in claims" });
    const retryable = r.claims.filter((cl) => cl.cin7Kind === "FAILED");
    if (retryable.length) add({ id: `posting-retryable-${r.projectId}`, severity: "attention", area: "Cin7", title: `${r.label}: ${retryable.length} claim${retryable.length === 1 ? "" : "s"} not created in Cin7 - can be retried`, detail: `${retryable.map((x) => x.claimNumber).join(", ")}. Cin7 confirmed nothing was created, so posting can safely be tried again.`, link: { kind: "tab", tab: "claims" }, linkLabel: "Open claims" });
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
    if (physical.shortages.length) add({ id: "stock-shortages", severity: "attention", area: "Stock", title: `${physical.shortages.length} product${physical.shortages.length === 1 ? "" : "s"} short of free stock`, detail: physical.shortages.slice(0, 5).map((s) => `${s.sku} (short ${s.shortfall}${s.sections.length > 1 ? ", all scopes combined" : ""})`).join(", ") + " - account-wide stock, an estimate.", link: { kind: "tab", tab: "physical" }, linkLabel: "Open Products & Stock" });
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

// ── Project Journey (UX-006d) ───────────────────────────────────────────────────────────────────────────────
// A journey map is derived from state the Overview ALREADY holds (the loaded scopes with their ProjectView, the delivery summary counts and, once the user has
// asked, the Cin7 fulfilment read). It adds no request. Where the state is not loaded the station says so (`unknown`), it never reports zero and never infers.
// Stations are not steps: nothing here gates anything, and the only "Needs" lines are dependencies the code really enforces. Invoicing and stock fulfilment
// never refer to each other. There is no project completion state. No cost or margin figure is read or output, so nothing here depends on the viewer's role.

export type JourneyStatus = "not_started" | "in_progress" | "completed" | "needs_attention" | "blocked";
export const JOURNEY_STATUS_LABEL: Record<JourneyStatus, string> = { not_started: "Not started", in_progress: "In progress", completed: "Completed", needs_attention: "Needs attention", blocked: "Blocked" };
export const JOURNEY_UNKNOWN_LABEL = "Not read yet";
export interface JourneyStation {
  id: string;
  label: string;
  status: JourneyStatus;
  /** True when the state needed is not loaded: the station shows "Not read yet" in place of its status (status is then always not_started). */
  unknown: boolean;
  detail: string;
  /** Real, code-enforced dependencies only. */
  needs: string[];
  /** Setup details are informational and never block anything. */
  informational?: boolean;
  /** Word shown in place of the status label where the status word would mislead (a rejected variation is closed, not "Completed"). */
  statusLabel?: string;
  /** Extra lines under the detail (a variation's invoice authorisation). */
  lines?: string[];
  /** A Blocked station whose block is a plain prerequisite, not a fault: shown in the milder tone, same status word. */
  soft?: boolean;
  /** A value that is never read by this page (evidence-only rows): shown as "Not read yet" but left out of the lane summary counts. */
  permanentUnknown?: boolean;
  link: { tab: OverviewTab; label: string } | null;
}
export type JourneyLaneId = "commercial" | "physical" | "variations";
export interface JourneyLane { id: JourneyLaneId; title: string; stations: JourneyStation[]; summary: { attention: number; inProgress: number; unknown: number } }
export interface Journey { setup: JourneyStation[]; lanes: JourneyLane[]; footnote: string }
export interface JourneyInput {
  scopes: OverviewScopeInput[];
  /** The Overview's own physical block (state, totals, deliveries): `deliveries` null = could not be read. */
  physical: PhysicalOverview;
  /**
   * What the manual, read-only "Verify invoice statuses" has verified, as plain data (the caller reads it from the in-memory verification context; this module imports no
   * hook). Absent = nothing verified. A verification only ever says something about the claims it lists; it is never read from the recorded snapshot.
   */
  verification?: { verifiedByClaimId: Record<string, VerifiedRef | undefined>; /** Claims whose workspace's last Verify failed to read Cin7. */ failedClaimIds: ReadonlyArray<string> };
}

export const JOURNEY_FOOTNOTE = "There is no project completion or closure state in the Toolbox, so the journey shows progress only and never marks the project as finished.";

const OPEN_CLAIM = ["DRAFT", "READY_FOR_APPROVAL"];
const INVOICED_KINDS = ["DRAFT_CREATED", "AUTHORISED", "CREATED_OTHER"];
/** Retryable (nothing created) and uncertain (check Cin7 first) are different instructions and are never merged into one sentence. */
const postingProblem = (notCreated: number, uncertain: number): string => [
  notCreated ? `${plural(notCreated, "invoice")} not created in Cin7 (can be retried)` : "",
  uncertain ? `${plural(uncertain, "invoice")} with an uncertain outcome: check Cin7 before doing anything` : "",
].filter(Boolean).join("; ") + ".";
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function station(s: Omit<JourneyStation, "unknown" | "needs" | "link"> & Partial<Pick<JourneyStation, "unknown" | "needs" | "link">>): JourneyStation {
  return { unknown: false, needs: [], link: null, ...s };
}
const unknownStation = (id: string, label: string, detail: string, link: JourneyStation["link"], needs: string[] = []): JourneyStation => station({ id, label, status: "not_started", unknown: true, detail, link, needs });

/** The claims of one scope as the journey needs them. Pure counts over the loaded rows. */
function claimFacts(v: ProjectView) {
  const claims = v.claims;
  return {
    claims,
    open: claims.filter((c) => OPEN_CLAIM.includes(c.status)),
    draft: claims.filter((c) => c.status === "DRAFT").length,
    submitted: claims.filter((c) => c.status === "READY_FOR_APPROVAL").length,
    postable: claims.filter((c) => c.status === "APPROVED" && c.cin7Status.kind === "NOT_POSTED").length,
    // A PENDING posting older than the stale window has an unknown outcome: it counts as uncertain here exactly as commercialBillingState counts it (never "being posted").
    posting: claims.filter((c) => c.cin7Status.kind === "POSTING" && !c.cin7Status.stalePending).length,
    notCreated: claims.filter((c) => c.cin7Status.kind === "FAILED").length,
    uncertain: claims.filter((c) => c.cin7Status.kind === "UNCERTAIN" || (c.cin7Status.kind === "POSTING" && c.cin7Status.stalePending)).length,
    invoiced: claims.filter((c) => INVOICED_KINDS.includes(c.cin7Status.kind)).length,
  };
}

const isAuthorised = (s: string | null) => s === "AUTHORISED" || s === "AUTHORIZED";
const sentence = (reasons: string[]): string => reasons.map((r, i) => (i === 0 ? r.charAt(0).toUpperCase() + r.slice(1) : r)).join("; ") + ".";

/**
 * Concept B for one scope: is each invoice's AUTHORISATION verified (UAT-028)? Success ONLY when a current verification lists every live invoice of this scope as AUTHORISED.
 * The recorded snapshot is never success and never current. Reads only this scope's own claims.
 */
function invoiceAuthorisationFor(v: ProjectView, verification: JourneyInput["verification"]): { status: JourneyStatus; unknown: boolean; statusLabel?: string; detail: string; total: number } {
  const invoiced = v.claims.filter((c) => INVOICED_KINDS.includes(c.cin7Status.kind) && !!c.cin7Status.invoiceNumber);
  const total = invoiced.length;
  const failedIds = new Set(verification?.failedClaimIds ?? []);
  if (total === 0) return { status: "not_started", unknown: false, detail: "No invoices posted yet.", total };
  const rows = invoiced.map((c) => invoiceAuthorisation(c.cin7Status, verification?.verifiedByClaimId[c.id] ?? null, failedIds.has(c.id)));
  const verified = rows.filter((r) => r.state === "VERIFIED");
  const authorised = verified.filter((r) => isAuthorised(r.verifiedStatus)).length;
  const problems = rows.filter((r) => r.state === "NOT_IN_SALE" || r.state === "AMBIGUOUS" || r.state === "IDENTITY_MISMATCH" || r.state === "STATUS_UNREADABLE").length;
  const at = verified[0]?.verifiedAt ?? rows.find((r) => r.verifiedAt)?.verifiedAt ?? null;
  if (problems > 0) return { status: "needs_attention", unknown: false, detail: `${plural(problems, "invoice")} could not be matched in Cin7 by the last verification. Open Claims to review.`, total };
  if (authorised === total) return { status: "completed", unknown: false, statusLabel: "Authorised (verified)", detail: `Authorised in Cin7 - verified ${formatSast(at)}. ${plural(total, "invoice")}.`, total };
  if (verified.length > 0) {
    // Only what the verification actually said: the other verified invoices with their REAL status, and the rest as "not verified" (never assumed Draft).
    const other = verified.filter((r) => !isAuthorised(r.verifiedStatus)).map((r) => (r.verifiedStatus ?? "no status").toLowerCase());
    const otherText = [...new Set(other)].map((st) => `${other.filter((x) => x === st).length} ${st}`).join(", ");
    const unverified = rows.filter((r) => r.state !== "VERIFIED").length;
    const failedN = invoiced.filter((c) => failedIds.has(c.id)).length;
    const parts = [otherText ? `${otherText} in Cin7` : "", unverified > 0 ? `${unverified} not verified` : "", failedN > 0 ? `Could not verify ${failedN}` : ""].filter(Boolean);
    return { status: "in_progress", unknown: false, detail: `${authorised} of ${total} authorised (verified ${formatSast(at)})${parts.length ? `; ${parts.join("; ")}` : ""}.`, total };
  }
  // Nothing verified for this scope: the recorded snapshot is evidence of the past and is shown as such, never as success.
  const recorded = rows.map((r) => r.recorded?.status ?? "no status");
  const counts = [...new Set(recorded)].map((st) => [recorded.filter((x) => x === st).length, st.toLowerCase()] as const).sort((x, y) => y[0] - x[0] || x[1].localeCompare(y[1])).map(([n, st]) => `${n} ${st}`).join(", ");
  const last = rows.map((r) => r.recorded?.at).filter((x): x is string => !!x).sort().pop() ?? null;
  const failed = invoiced.some((c) => failedIds.has(c.id));
  return { status: "not_started", unknown: true, statusLabel: failed ? "Could not verify" : "Not verified", detail: `${failed ? "The last verification could not read Cin7. " : ""}Last recorded${last ? ` ${formatSast(last)}` : ""}: ${counts} (recorded snapshot, not verified). Verify in Claims.`, total };
}

function variationStation(code: string, title: string, status: string, amountCents: number, scopeOf: OverviewScopeInput | undefined, verification: JourneyInput["verification"]): JourneyStation {
  const id = `variation-${code}`;
  const label = `${code} commercial billing`;
  const who = `${code} ${title}`;
  const link = { tab: "variations" as const, label: "Open Variations" };
  if (status === "DRAFT") return station({ id, label, status: "not_started", detail: `${who}: draft, ${formatCents(amountCents)} ex VAT, not yet approved. No billing is possible until it is approved.`, link });
  if (status === "REJECTED") return station({ id, label, status: "not_started", statusLabel: "Rejected", detail: "Rejected: closed. It adds nothing to the contract and has no billing.", link });
  if (status !== "APPROVED") return { ...unknownStation(id, label, `${who}: the variation status "${status}" is not one the Toolbox recognises.`, link), statusLabel: "Status not recognised" };
  // Approved but no billing project: the value is approved and cannot be invoiced yet, which is a state to ACT on, but it is not a fault. It reads "Not started - billing not set up"
  // and does not inflate the "needs attention" headline (decision recorded in the PR: not-started, not attention).
  if (!scopeOf) return station({ id, label, status: "not_started", statusLabel: "Billing not set up", detail: `${who}: approved (${formatCents(amountCents)} ex VAT) but no billing project exists yet, so it cannot be invoiced.`, link: { tab: "variations", label: `Start ${code} billing` } });
  const v = scopeOf.view;
  const c = v.commercial;
  // The billing project's own contract figure is the approved amount being billed (the same source the Overview uses).
  const approvedCents = c.originalContractCents;
  const bill = commercialBillingFromView(v, "VARIATION", { approvedAmountCents: approvedCents, billingStarted: true });
  const auth = invoiceAuthorisationFor(v, verification);
  const lines = [`Invoice authorisation: ${auth.unknown ? `${auth.statusLabel}. ${auth.detail}` : auth.detail}`];
  const open = { tab: "variations" as const, label: `Open ${code} billing` };
  // Same state, same status as the Commercial lane: an uncertain claim blocks new billing.
  if (c.uncertainClaimBlocking) return station({ id, label, status: "blocked", detail: `${who}: a claim's Cin7 outcome is uncertain, which blocks new billing.`, needs: ["Needs: the uncertain claim resolved before new billing of its stages."], lines, link: open });
  // The billing project's contract must equal the approval it bills; otherwise "complete" would be measured against a different amount.
  if (c.originalContractCents !== amountCents) return station({ id, label, status: "needs_attention", detail: `${who}: the billing project contract (${formatCents(c.originalContractCents)}) differs from the approved amount (${formatCents(amountCents)}).`, lines, link: open });
  if (bill.state === "NEEDS_ATTENTION") return station({ id, label, status: "needs_attention", detail: `${who}: ${sentence(bill.reasons)}`, lines, link: open });
  if (bill.state === "COMPLETE") return station({ id, label, status: "completed", detail: `${who}: commercial billing complete - ${formatCents(approvedCents)} billed, ${formatCents(0)} remaining, ${plural(bill.counts.reconciled, "invoice")} reconciled.`, lines, link });
  if (bill.state === "NOT_STARTED") return station({ id, label, status: "in_progress", detail: `${who}: billing project open; no claims raised yet.`, lines, link: open });
  return station({ id, label, status: "in_progress", detail: `${who}: ${sentence(bill.reasons)}`, lines, link: open });
}

export function buildJourney(input: JourneyInput): Journey {
  const base = input.scopes.find((s) => s.scope === "BASE");
  const p = input.physical;
  const claimsTab = { tab: "claims" as const, label: "Open Claims" };

  // ── Setup (informational; none of it blocks anything) ───────────────────────
  const setup: JourneyStation[] = [];
  if (!base) {
    setup.push(unknownStation("setup-details", "Project details", "The project could not be read.", null));
    setup.push(unknownStation("setup-schedule", "Billing schedule", "The project could not be read.", { tab: "stages", label: "Open Stages" }));
    setup.push(unknownStation("setup-opening", "Opening commitments", "The project could not be read.", claimsTab));
  } else {
    const bv = base.view;
    const set = [bv.project.project_manager, bv.project.start_date, bv.project.target_completion_date].filter((x) => !!x && String(x).trim() !== "").length;
    setup.push(station({
      id: "setup-details", label: "Project details", informational: true, status: set === 0 ? "not_started" : set === 3 ? "completed" : "in_progress",
      detail: `${set} of 3 set (project manager, start date, target completion). Informational; nothing waits on them.`,
    }));
    setup.push(station({
      id: "setup-schedule", label: "Billing schedule", status: bv.commercial.scheduleBalanced ? "completed" : "needs_attention",
      detail: bv.commercial.scheduleBalanced ? "The stage values total the contract." : "The stage values do not total the contract.", link: { tab: "stages", label: "Open Stages" },
    }));
    const oc = bv.openingCommitments.length;
    setup.push(station({
      id: "setup-opening", label: "Opening commitments", status: bv.openingCommitmentsLocked ? "completed" : oc > 0 ? "in_progress" : "not_started", statusLabel: bv.openingCommitmentsLocked ? "Locked" : undefined,
      detail: bv.openingCommitmentsLocked ? `${oc === 0 ? "None entered" : plural(oc, "commitment") + " entered"}; locked because claims exist.` : oc > 0 ? `${plural(oc, "commitment")} entered.` : "Optional: none entered.",
      needs: bv.openingCommitmentsLocked ? [] : ["Needs: entered before the first claim; they lock once a claim exists."], link: claimsTab,
    }));
  }

  // ── Commercial lane (original contract only; variations have their own lane) ──
  const commercial: JourneyStation[] = [];
  if (!base) {
    for (const [id, label] of [["sale", "Cin7 Sale"], ["stages", "Stage progress"], ["claims", "Progress claims"], ["posting", "Post to Cin7"], ["invoices", "Invoice status"]] as const) commercial.push(unknownStation(`commercial-${id}`, label, "The project could not be read.", claimsTab));
  } else {
    const v = base.view;
    const f = claimFacts(v);
    const c = v.commercial;
    const linked = !!base.saleNumber;
    const blockers = base.scopeBlockers.length;

    commercial.push(linked
      ? station({ id: "commercial-sale", label: "Cin7 Sale", status: "completed", detail: `Linked to ${base.saleNumber}.`, link: claimsTab })
      : blockers > 0
        ? station({ id: "commercial-sale", label: "Cin7 Sale", status: "in_progress", detail: `No Sale linked. ${plural(blockers, "scope item")} not resolved yet.`, needs: [`Needs: all scope items resolved (${blockers} outstanding) before a Sale can be created.`], link: { tab: "components", label: "Open Components / scope" } })
        // No link says nothing about an attempt in flight (PENDING / uncertain): that row is read only on the Claims tab.
        : unknownStation("commercial-sale", "Cin7 Sale", "No Sale is linked. Whether a creation attempt is in flight or uncertain is read on the Claims tab.", claimsTab));

    const anyApproved = v.stages.some((s) => s.approvedBps > 0 || s.committedCents > 0);
    // BASE-only test: the project's remainingCents includes approved variations, so it must not decide a base station.
    const allCommitted = v.stages.length > 0 && v.stages.every((s) => s.committedCents >= s.valueCents);
    const below = v.stages.filter((s) => s.belowCommitted).length;
    const over = v.stages.filter((s) => s.committedCents > s.valueCents).length;
    commercial.push(over > 0
      ? station({ id: "commercial-stages", label: "Stage progress", status: "needs_attention", detail: `${plural(over, "stage")} billed above ${over === 1 ? "its" : "their"} value.`, link: { tab: "stages", label: "Open Stages" } })
      : below > 0
      ? station({ id: "commercial-stages", label: "Stage progress", status: "needs_attention", detail: `${plural(below, "stage")} approved below what is already committed.`, link: { tab: "stages", label: "Open Stages" } })
      : allCommitted ? station({ id: "commercial-stages", label: "Stage progress", status: "completed", detail: "Every stage is fully billed or committed.", link: { tab: "stages", label: "Open Stages" } })
      : anyApproved ? station({ id: "commercial-stages", label: "Stage progress", status: "in_progress", detail: `Approved completion ${formatBps(c.approvedCompletionBps)} of the contract.`, link: { tab: "stages", label: "Open Stages" } })
      : station({ id: "commercial-stages", label: "Stage progress", status: "not_started", detail: "No progress approved for billing yet.", link: { tab: "stages", label: "Open Stages" } }));

    // COMMERCIAL billing, from the POSTINGS and the stage ledger (claim status stays APPROVED forever after posting, so a claim-status rule can never complete).
    const bill = commercialBillingFromView(v, "BASE");
    const billing = (status: JourneyStatus, detail: string, needs: string[] = []) => station({ id: "commercial-billing", label: "Commercial billing", status, detail, needs, link: claimsTab });
    if (c.uncertainClaimBlocking) commercial.push(billing("blocked", "A claim's Cin7 outcome is uncertain, which blocks new billing.", ["Needs: the uncertain claim resolved before new billing of its stages."]));
    else if (bill.state === "COMPLETE") commercial.push(billing("completed", `Commercial billing complete - ${plural(bill.counts.reconciled, "claim")} posted and reconciled.`));
    else if (bill.state === "NEEDS_ATTENTION") commercial.push(billing("needs_attention", sentence(bill.reasons)));
    else if (bill.state === "NOT_STARTED") commercial.push(billing("not_started", c.claimableCents > 0 ? `No claims yet. ${formatCents(c.claimableCents)} ex VAT is claimable now.` : "No claims yet. Nothing is claimable until a manager approves progress."));
    else commercial.push(billing("in_progress", sentence(bill.reasons)));

    const needsSale = linked ? [] : ["Needs: a linked Cin7 Sale before a claim can be posted."];
    const post = (status: JourneyStatus, detail: string, needs = needsSale, soft = false) => station({ id: "commercial-posting", label: "Post to Cin7", status, soft: soft || undefined, detail, needs, link: claimsTab });
    if (f.notCreated + f.uncertain > 0) commercial.push(post("needs_attention", postingProblem(f.notCreated, f.uncertain)));
    else if (bill.counts.mismatched > 0) commercial.push(post("needs_attention", `${plural(bill.counts.mismatched, "invoice")} posted with a recorded amount mismatch.`));
    else if (bill.counts.cancelledWithPosting > 0) commercial.push(post("needs_attention", `${plural(bill.counts.cancelledWithPosting, "cancelled claim")} still ${bill.counts.cancelledWithPosting === 1 ? "has" : "have"} a Cin7 posting that is not resolved.`));
    else if (f.posting > 0) commercial.push(post("in_progress", `${plural(f.posting, "invoice")} being posted.`));
    else if (f.postable > 0 && !linked) commercial.push(post("blocked", `${plural(f.postable, "approved claim")} cannot be posted.`, needsSale, true));
    else if (f.postable > 0) commercial.push(post("in_progress", `${plural(f.postable, "approved claim")} ready to post.`, []));
    else if (bill.state === "COMPLETE" || (bill.counts.live > 0 && bill.counts.reconciled === bill.counts.live && bill.counts.cancelledWithPosting === 0)) commercial.push(post("completed", `${plural(bill.counts.reconciled, "claim")} posted and reconciled; none waiting.`));
    else if (f.invoiced > 0) commercial.push(post("in_progress", `${plural(f.invoiced, "claim")} posted; ${bill.counts.awaitingReconciliation} awaiting reconciliation.`));
    else commercial.push(post("not_started", "No approved claims to post."));

    // Concept B (Cin7 authorisation): success only from a current VERIFICATION of every live invoice; the recorded snapshot is never success.
    const auth = invoiceAuthorisationFor(v, input.verification);
    commercial.push(auth.unknown
      ? { ...unknownStation("commercial-authorisation", "Invoice authorisation", auth.detail, claimsTab), statusLabel: auth.statusLabel }
      : station({ id: "commercial-authorisation", label: "Invoice authorisation", status: auth.status, statusLabel: auth.statusLabel, detail: auth.detail, link: claimsTab }));
  }

  // ── Physical lane (independent of billing) ──────────────────────────────────
  const physical: JourneyStation[] = [];
  const d = p.deliveries;
  const delivTab = { tab: "deliveries" as const, label: "Open Deliveries" };
  physical.push(d === null ? unknownStation("physical-deliveries", "Deliveries", "The delivery register could not be read.", delivTab)
    // `total` already excludes cancelled deliveries (loadDeliverySummary), so a project whose deliveries were all cancelled has total 0 and says so.
    : d.total === 0 ? station({ id: "physical-deliveries", label: "Deliveries", status: "not_started", detail: d.cancelled > 0 ? `No live deliveries; ${d.cancelled} cancelled.` : "No deliveries recorded.", link: delivTab })
    : d.dispatched === d.total ? station({ id: "physical-deliveries", label: "Deliveries", status: "completed", detail: `All ${plural(d.total, "delivery", "deliveries")} dispatched${d.cancelled > 0 ? ` (${d.cancelled} cancelled)` : ""}.`, link: delivTab })
    : station({ id: "physical-deliveries", label: "Deliveries", status: "in_progress", detail: `${d.dispatched} of ${d.total} dispatched${d.cancelled > 0 ? ` (${d.cancelled} cancelled)` : ""}.`, link: delivTab }));

  const fulfilTab = { tab: "physical" as const, label: "Open Products & Stock" };
  const procTab = { tab: "procurement" as const, label: "Open Procurement" };
  if (p.state === "not_loaded") {
    physical.push(unknownStation("physical-fulfilment", "Fulfilment", "Cin7 is read only when you ask. Quantities are unknown, not zero.", fulfilTab));
    physical.push(unknownStation("physical-procurement", "Procurement", "Stock shortfalls are unknown until Cin7 is read.", procTab));
  } else if (p.state === "error" || !p.totals) {
    physical.push(unknownStation("physical-fulfilment", "Fulfilment", "Cin7 fulfilment could not be read.", fulfilTab));
    physical.push(unknownStation("physical-procurement", "Procurement", "Cin7 fulfilment could not be read.", procTab));
  } else {
    const t = p.totals;
    physical.push(t.skuCount === 0 ? station({ id: "physical-fulfilment", label: "Fulfilment", status: "not_started", detail: "No physical products in scope.", link: fulfilTab })
      : t.unknownRowCount > 0 ? station({ id: "physical-fulfilment", label: "Fulfilment", status: "in_progress", detail: `${plural(t.unknownRowCount, "product line")} could not be read, so the totals are incomplete.`, link: fulfilTab })
      : t.remainingUnits === 0 ? station({ id: "physical-fulfilment", label: "Fulfilment", status: "completed", detail: "Everything ordered has shipped (as read from Cin7).", link: fulfilTab })
      : (t.shippedUnits ?? 0) > 0 ? station({ id: "physical-fulfilment", label: "Fulfilment", status: "in_progress", detail: `${t.shippedUnits} shipped, ${t.remainingUnits} still to ship.`, link: fulfilTab })
      : station({ id: "physical-fulfilment", label: "Fulfilment", status: "not_started", detail: `Nothing shipped yet; ${t.remainingUnits} to ship.`, link: fulfilTab }));
    physical.push(t.skuCount === 0 ? station({ id: "physical-procurement", label: "Procurement", status: "not_started", detail: "No physical products in scope.", link: procTab })
      : t.shortSkuCount > 0 ? station({ id: "physical-procurement", label: "Procurement", status: "needs_attention", detail: `${plural(t.shortSkuCount, "product")} short of stock (whole-account stock).`, link: procTab })
      : t.unknownRowCount > 0 ? station({ id: "physical-procurement", label: "Procurement", status: "in_progress", detail: "No shortfall found, but some lines could not be read.", link: procTab })
      : station({ id: "physical-procurement", label: "Procurement", status: "completed", detail: "No stock shortfall at the last Cin7 read (whole-account stock).", link: procTab }));
  }
  // Milestone confirmations live in the delivery register rows, which the Overview does not load (only counts).
  physical.push({ ...unknownStation("physical-milestones", "Milestone confirmations", "Evidence only: a confirmation does not release claimable value. The rows are read on the Deliveries tab.", delivTab), permanentUnknown: true });

  // ── Variations lane (one station per variation; each reads only its OWN billing scope) ──
  const variations: JourneyStation[] = (base?.view.variations ?? []).map((vr) => variationStation(vr.code, vr.title, vr.status, vr.amount_cents, input.scopes.find((s) => s.scope === "VARIATION" && s.variationCode === vr.code), input.verification));

  const lane = (id: JourneyLaneId, title: string, stations: JourneyStation[]): JourneyLane => ({
    id, title, stations,
    summary: { attention: stations.filter((s) => !s.unknown && (s.status === "needs_attention" || s.status === "blocked")).length, inProgress: stations.filter((s) => !s.unknown && s.status === "in_progress").length, unknown: stations.filter((s) => s.unknown && !s.permanentUnknown).length },
  });
  return { setup, lanes: [lane("commercial", "Commercial", commercial), lane("physical", "Physical", physical), lane("variations", "Variations", variations)], footnote: JOURNEY_FOOTNOTE };
}
