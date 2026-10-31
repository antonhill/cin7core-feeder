// Projects - the CONSOLIDATED COMMERCIAL REPORT of an original project across its BASE scope and every approved variation (pure, generic).
//
// Each billing scope is counted ONCE: the original project is the BASE scope, and each variation is counted from the variation record (its approved
// amount) and its own billing project (its claims and Cin7 invoices). The internal billing projects are never added on top of their variations.
// Two different numbers are kept apart and labelled:
//   * REMAINING CONTRACT VALUE = revised contract - everything invoiced in Cin7 (what is still to be billed in total);
//   * CLAIMABLE NOW           = what the approved progress currently allows to be claimed (a subset of the remaining value).
// Invoiced = Cin7 invoices that exist (posting CREATED or RECONCILED), ex VAT. Unknown stays unknown, never zero.

export interface ReportClaim { claimNumber: string; status: string; subtotalCents: number; totalCents: number; invoiceNumber: string | null }
export interface ReportInvoice { invoiceNumber: string | null; amountExVatCents: number; totalCents: number; state: string }
export interface ReportScopeInput {
  scope: "BASE" | "VARIATION";
  label: string;
  projectId: string;
  /** Contract value of THIS scope (BASE: original contract; VARIATION: the approved variation amount). */
  contractCents: number;
  claimableCents: number;
  claims: ReportClaim[];
  /** Cin7 invoices that exist for this scope (posting CREATED or RECONCILED). */
  invoices: ReportInvoice[];
  /** Approved but billing not yet started: counted in the contract, not yet invoiceable. */
  billingStarted: boolean;
}
export interface ReportPhysicalRow { sku: string; name: string; quoted: number | null; ordered: number | null; invoiced: number | null; shipped: number | null; remainingToDeliver: number | null }
export interface ReportPhysicalSection { label: string; scope: "BASE" | "VARIATION"; linked: boolean; rows: ReportPhysicalRow[] }

export interface ConsolidatedScopeLine {
  scope: "BASE" | "VARIATION"; label: string; projectId: string; contractCents: number; invoicedCents: number; invoiceNumbers: string[]; remainingCents: number; claimableCents: number; billingStarted: boolean;
  claims: ReportClaim[];
}
export interface ConsolidatedCommercial {
  contract: { originalCents: number; approvedVariationsCents: number; revisedCents: number };
  scopes: ConsolidatedScopeLine[];
  invoiced: { originalCents: number; variationsCents: number; totalCents: number };
  /** Revised contract - total invoiced: the total still to be billed. */
  remainingContractCents: number;
  /** Currently claimable under approved progress (subset of the remaining value). */
  claimableNowCents: number;
  /** Anything that makes the figures unsafe to read as final. */
  warnings: string[];
}

export function buildConsolidatedCommercial(scopes: readonly ReportScopeInput[]): ConsolidatedCommercial {
  const warnings: string[] = [];
  const base = scopes.filter((s) => s.scope === "BASE");
  if (base.length !== 1) warnings.push(`Expected exactly one BASE scope, found ${base.length}.`);
  const ids = scopes.map((s) => s.projectId);
  if (new Set(ids).size !== ids.length) warnings.push("A scope appears more than once; it was counted once.");
  const unique = scopes.filter((s, i) => ids.indexOf(s.projectId) === i);

  const lines: ConsolidatedScopeLine[] = unique.map((s) => {
    const invoicedCents = s.invoices.reduce((n, i) => n + i.amountExVatCents, 0);
    if (invoicedCents > s.contractCents) warnings.push(`${s.label}: invoiced ${(invoicedCents / 100).toFixed(2)} exceeds its contract ${(s.contractCents / 100).toFixed(2)}.`);
    if (!s.billingStarted && s.scope === "VARIATION") warnings.push(`${s.label}: approved but billing has not started, so it is in the contract value but not yet invoiceable.`);
    return {
      scope: s.scope, label: s.label, projectId: s.projectId, contractCents: s.contractCents, invoicedCents, invoiceNumbers: s.invoices.map((i) => i.invoiceNumber ?? "(number pending)"),
      remainingCents: s.contractCents - invoicedCents, claimableCents: s.claimableCents, billingStarted: s.billingStarted, claims: s.claims,
    };
  });
  const original = lines.filter((l) => l.scope === "BASE").reduce((n, l) => n + l.contractCents, 0);
  const variations = lines.filter((l) => l.scope === "VARIATION").reduce((n, l) => n + l.contractCents, 0);
  const invOriginal = lines.filter((l) => l.scope === "BASE").reduce((n, l) => n + l.invoicedCents, 0);
  const invVar = lines.filter((l) => l.scope === "VARIATION").reduce((n, l) => n + l.invoicedCents, 0);
  return {
    contract: { originalCents: original, approvedVariationsCents: variations, revisedCents: original + variations },
    scopes: lines,
    invoiced: { originalCents: invOriginal, variationsCents: invVar, totalCents: invOriginal + invVar },
    remainingContractCents: original + variations - invOriginal - invVar,
    claimableNowCents: lines.reduce((n, l) => n + l.claimableCents, 0),
    warnings,
  };
}

export interface ConsolidatedPhysical {
  sections: Array<ReportPhysicalSection & { outstandingUnits: number | null; unknownRows: number }>;
  /** Units still to deliver across scopes; null if any row is unknown (never silently zero). */
  outstandingUnits: number | null;
}

/** Physical products and outstanding fulfilment by billing scope. Unknown rows make the total unknown. */
export function buildConsolidatedPhysical(sections: readonly ReportPhysicalSection[]): ConsolidatedPhysical {
  const out = sections.map((s) => {
    const unknownRows = s.rows.filter((r) => r.remainingToDeliver === null).length;
    return { ...s, unknownRows, outstandingUnits: unknownRows > 0 || !s.linked ? null : s.rows.reduce((n, r) => n + (r.remainingToDeliver as number), 0) };
  });
  return { sections: out, outstandingUnits: out.some((s) => s.outstandingUnits === null && s.rows.length > 0) ? null : out.reduce((n, s) => n + (s.outstandingUnits ?? 0), 0) };
}
