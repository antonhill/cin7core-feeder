// Projects - consolidated PROFITABILITY and RECONCILIATION (pure). Generic; Cin7-free. INTERNAL: contains cost and margin, so only ever built
// for viewers who may see cost.
//
// Principles (docs/projects-poc/integration-decisions.md section 13):
//  * Revenue and cost come from different workflows (commercial claims vs Cin7 inventory) and are joined only here, as a derived report; this
//    report can never change a claim or a Cin7 document.
//  * Every figure carries its BASIS. Unknown is null, never 0. A partial accumulation of cost is never presented as the project's margin:
//    the actual margin is produced only when delivery and billing are complete for EVERY scope.
//  * Estimated margins are the frozen quote/variation estimates, independent of Cin7's zero-priced physical lines.

import { marginFigures, type MarginFigures } from "./margin-figures";

export interface ScopeInput {
  scope: "BASE" | "VARIATION";
  label: string;
  projectId: string;
  /** Approved contract value of THIS scope, ex VAT (BASE: original contract; VARIATION: approved variation amount). */
  contractCents: number;
  /** Value held by approved/sent claims (billed or committed), ex VAT. */
  committedCents: number;
  /** Ex-VAT amount of claims that Cin7 holds as an invoice (posting CREATED or RECONCILED). */
  postedCents: number;
  /** Ex-VAT amount of approved claims that are NOT yet in Cin7 as an invoice. */
  unpostedApprovedCents: number;
  /** Postings whose Cin7 figures differ from the approved claim (AMOUNT_MISMATCH). */
  mismatchedPostings: number;
  /** Frozen estimated cost of the COSTED part of the scope; null = unknown. */
  estimatedCostCents: number | null;
  /** Selling value in the contract that the estimated cost does NOT cover (services such as delivery/installation with no recorded cost). Excluded from the estimated margin. */
  uncostedSellingCents: number;
  /** Linked Cin7 Sale, if any. */
  saleNumber: string | null;
  /** Cost recognised in Cin7 on the linked Sale (COGS), or null when not read / unreadable. */
  cogsCents: number | null;
  /** Quantity x AverageCost on the Sale's non-voided invoice lines (cents), or null when unknown. Cin7's per-line cost basis; NOT the same as recognised COGS. */
  invoiceLineCostCents?: number | null;
  /** Indicative cost: Cin7 product AverageCost x the scope's quantities (today's price, not a frozen estimate), or null when any SKU's cost is unknown. */
  indicativeCostCents?: number | null;
  /** Direct non-stock project costs (installation, transport, subcontractors, site) by state; null when the cost ledger is unavailable. */
  nonStock?: { incurredCents: number; committedCents: number } | null;
  /** True when every ordered physical unit on the linked Sale has shipped; false when not; null when unknown / no Sale. */
  deliveryComplete: boolean | null;
}

export interface ProfitabilityException { code: "OVER_BILLED" | "UNPOSTED_APPROVED_CLAIM" | "POSTING_MISMATCH" | "NO_LINKED_SALE" | "COST_UNKNOWN" | "COGS_NOT_READ" | "COGS_ZERO_BUT_LINES_COSTED" | "LINE_COST_UNKNOWN"; scope: string; message: string }

export interface ProfitabilityReport {
  /** What the cost figures are, so they are never mistaken for verified actuals. */
  reportingBasis: string;
  asOf: string;
  contract: { originalCents: number; approvedVariationsCents: number; revisedCents: number };
  billing: { committedCents: number; postedToCin7Cents: number; unpostedApprovedCents: number; remainingToClaimCents: number };
  estimated: {
    original: MarginFigures;
    variations: MarginFigures;
    revised: MarginFigures;
    /** Contract value left OUT of the estimated margins above because no cost was recorded for it. */
    uncostedSellingCents: number;
    /** True when a scope has no estimated cost: that scope's margin (and the revised total) is withheld. */
    incomplete: boolean;
    /** Cin7 product average cost x scope quantities, where available. Explicitly NOT the frozen estimate; shown so a missing estimate is never read as zero cost. */
    indicativeProductCostCents: number | null;
  };
  actual: {
    /** Cost carried on the Cin7 invoice lines (Quantity x AverageCost). Distinct from recognised COGS; null if any scope's is unknown. */
    invoiceLineCostCents: number | null;
    /** Direct non-stock costs recorded in Toolbox: incurred (actual) and committed (expected). Null if the cost ledger is unavailable. */
    nonStockIncurredCents: number | null;
    nonStockCommittedCents: number | null;
    /** Incurred cost on the best available basis: max(recognised COGS, invoice-line cost) + incurred non-stock; null when unknown. Never a margin by itself. */
    incurredCostCents: number | null;
    /** Plain statement of which figure is which, so they are never assumed equivalent. */
    costBasisNote: string;
    /** COGS recognised in Cin7 across the linked Sales to date; null if ANY scope's is unknown. */
    recognisedCostToDateCents: number | null;
    /** Contract value invoiced to date (ex VAT), for the "to date" comparison. */
    invoicedToDateCents: number;
    /** The project margin on actuals - only when delivery and billing are COMPLETE for every scope. Otherwise null. */
    projectMargin: MarginFigures | null;
    meaningful: boolean;
    reason: string;
  };
  exceptions: ProfitabilityException[];
}

export function buildProfitability(scopes: readonly ScopeInput[], asOfIso: string): ProfitabilityReport {
  const exceptions: ProfitabilityException[] = [];
  const base = scopes.filter((s) => s.scope === "BASE");
  const vars = scopes.filter((s) => s.scope === "VARIATION");
  const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);
  const sumOrNull = (xs: ReadonlyArray<number | null>): number | null => (xs.some((x) => x === null) ? null : sum(xs as number[]));

  for (const s of scopes) {
    if (s.committedCents > s.contractCents) exceptions.push({ code: "OVER_BILLED", scope: s.label, message: `${s.label}: ${s.committedCents} cents claimed against a contract of ${s.contractCents}.` });
    if (s.unpostedApprovedCents > 0) exceptions.push({ code: "UNPOSTED_APPROVED_CLAIM", scope: s.label, message: `${s.label}: approved claims worth ${(s.unpostedApprovedCents / 100).toFixed(2)} are not yet invoiced in Cin7.` });
    if (s.mismatchedPostings > 0) exceptions.push({ code: "POSTING_MISMATCH", scope: s.label, message: `${s.label}: ${s.mismatchedPostings} Cin7 invoice(s) differ from the approved claim.` });
    if (!s.saleNumber) exceptions.push({ code: "NO_LINKED_SALE", scope: s.label, message: `${s.label} has no linked Cin7 Sale.` });
    if (s.estimatedCostCents === null) exceptions.push({ code: "COST_UNKNOWN", scope: s.label, message: `${s.label} has no estimated cost, so its margin is withheld.` });
    if (s.saleNumber && s.cogsCents === 0 && (s.invoiceLineCostCents ?? 0) > 0) exceptions.push({ code: "COGS_ZERO_BUT_LINES_COSTED", scope: s.label, message: `${s.label}: Cin7 has recognised R0 cost, but its invoice lines carry ${((s.invoiceLineCostCents as number) / 100).toFixed(2)} of average cost. R0 recognised cost is not evidence that the goods are free; the actual margin is withheld until Cin7 recognises the cost.` });
    if (s.saleNumber && s.invoiceLineCostCents === null) exceptions.push({ code: "LINE_COST_UNKNOWN", scope: s.label, message: `${s.label}: an invoice line has no readable average cost, so the line-level cost is unknown (not zero).` });
    if (s.saleNumber && s.cogsCents === null) exceptions.push({ code: "COGS_NOT_READ", scope: s.label, message: `Cost recognised in Cin7 for ${s.label} was not read.` });
  }

  const orig = sum(base.map((s) => s.contractCents));
  const varSum = sum(vars.map((s) => s.contractCents));
  const origCost = sumOrNull(base.map((s) => s.estimatedCostCents));
  const varCost = vars.length ? sumOrNull(vars.map((s) => s.estimatedCostCents)) : 0;
  const revCost = origCost === null || varCost === null ? null : origCost + varCost;
  const uncostedBase = sum(base.map((s) => s.uncostedSellingCents));
  const uncostedVar = sum(vars.map((s) => s.uncostedSellingCents));
  const committed = sum(scopes.map((s) => s.committedCents));

  const cogs = sumOrNull(scopes.map((s) => s.cogsCents));
  const invoiced = sum(scopes.map((s) => s.postedCents));
  const lineCost = sumOrNull(scopes.map((s) => s.invoiceLineCostCents ?? null));
  const ns = scopes.map((s) => s.nonStock ?? null);
  const nsIncurred = ns.some((x) => x === null) ? null : sum(ns.map((x) => x!.incurredCents));
  const nsCommitted = ns.some((x) => x === null) ? null : sum(ns.map((x) => x!.committedCents));
  const stockIncurred = cogs === null && lineCost === null ? null : Math.max(cogs ?? 0, lineCost ?? 0);
  const incurred = stockIncurred === null || nsIncurred === null ? null : stockIncurred + nsIncurred;
  const indicative = sumOrNull(scopes.map((s) => s.indicativeCostCents ?? null));
  const zeroCogsButCosted = scopes.some((s) => s.cogsCents === 0 && (s.invoiceLineCostCents ?? 0) > 0);
  const complete = scopes.length > 0 && !zeroCogsButCosted && scopes.every((s) => s.deliveryComplete === true && s.committedCents === s.contractCents && s.unpostedApprovedCents === 0 && s.mismatchedPostings === 0 && s.cogsCents !== null);
  const reason = zeroCogsButCosted ? "Not meaningful yet: Cin7 has recognised R0 cost although the invoice lines carry cost. Zero recognised cost is not proof the goods are free; authorise/complete the invoices in Cin7 so the cost is recognised."
    : complete
    ? "Delivery and billing are complete for every scope; margin is on Cin7-recognised cost."
    : scopes.some((s) => s.deliveryComplete !== true) ? "Not meaningful yet: delivery is not complete (or not readable) for every scope, so recognised cost is partial."
    : scopes.some((s) => s.committedCents !== s.contractCents) ? "Not meaningful yet: the contract is not fully billed."
    : "Not meaningful yet: billing is not fully posted and reconciled in Cin7, or cost was not read.";

  return {
    reportingBasis: "Estimates are the figures frozen at quote/variation approval (PROVISIONAL POC costs). Actual cost is what Cin7 has recognised as COGS on the linked Sales to date; it is not a verified project cost; services without a Cin7 cost (installation, delivery) and account-wide assembly costs are not in it. Excluding VAT.",
    asOf: asOfIso,
    contract: { originalCents: orig, approvedVariationsCents: varSum, revisedCents: orig + varSum },
    billing: {
      committedCents: committed, postedToCin7Cents: invoiced, unpostedApprovedCents: sum(scopes.map((s) => s.unpostedApprovedCents)),
      remainingToClaimCents: Math.max(0, orig + varSum - committed),
    },
    estimated: {
      original: marginFigures(orig - uncostedBase, origCost),
      variations: marginFigures(varSum - uncostedVar, varCost),
      revised: marginFigures(orig + varSum - uncostedBase - uncostedVar, revCost),
      uncostedSellingCents: uncostedBase + uncostedVar,
      incomplete: scopes.some((s) => s.estimatedCostCents === null),
      indicativeProductCostCents: indicative,
    },
    actual: {
      invoiceLineCostCents: lineCost, nonStockIncurredCents: nsIncurred, nonStockCommittedCents: nsCommitted, incurredCostCents: incurred,
      costBasisNote: "Estimated = frozen at quote/variation approval. Committed = non-stock costs recorded as expected. Incurred = the larger of Cin7-recognised COGS and invoice-line average cost, plus incurred non-stock costs (stock costs already inside Cin7 inventory/assembly values are not entered twice). Recognised COGS, invoice-line cost and incurred cost are different figures and are never assumed equal.",
      recognisedCostToDateCents: cogs, invoicedToDateCents: invoiced,
      projectMargin: complete && cogs !== null ? marginFigures(invoiced, cogs) : null,
      meaningful: complete, reason,
    },
    exceptions,
  };
}
