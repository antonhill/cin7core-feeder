// PRICING INPUTS (NQ-008B Phase 1). Plain, JSON-safe data: nothing in this file calculates, reads a database or renders. A completed supplier workbook can later be turned
// into these shapes (see fixtures.ts for the shape it needs to produce) without changing the calculation or the UI. Money is integer cents; rates, native costs and
// freight factors are integer micro units (6 decimals) - see money.ts.

/** Server-owned attribution. Whatever a client submits for `by` / `at` is ignored and replaced (see inputs.ts). */
export interface Stamp { by: string; at: string }
export interface Reasoned extends Stamp { reason: string }

// ── rule versions ──────────────────────────────────────────────────────────

export type RuleVersionStatus = "legacy" | "draft" | "approved";
/**
 * A VERSIONED SET OF COMMERCIAL PARAMETERS. A rule version is data, never code: changing a markup or a policy means adding a new version, never editing one in place.
 * `legacy` reproduces what the Grower POC does today. `draft` is fixture/development only and can never be selected for a real quotation. `approved` is reserved for a
 * version NewQuip has confirmed (none exists yet: no NewQuip business rule is invented here).
 */
export interface PricingRuleVersion {
  id: string;
  label: string;
  status: RuleVersionStatus;
  /** Markup on LANDED cost in basis points (2000 = 20%). Selling price = landed x (1 + markup). */
  markupBps: number;
  /** A cost the supplier has not verified: price it but flag the quotation provisional ("flag"), or refuse to price the line ("block"). */
  unverifiedCost: "flag" | "block";
  /** A line with no freight / landed-cost adjustment recorded: assume none but flag it ("flag"), or refuse to price it ("block"). */
  freightUnspecified: "flag" | "block";
  /** An exchange rate older than this many days is flagged stale. null = age is not checked. */
  maxRateAgeDays: number | null;
}

// ── cost inputs ────────────────────────────────────────────────────────────

export interface SupplierCostInput {
  supplierId: string | null;
  supplierName: string | null;
  /** The currency the supplier invoices in (ISO 4217). ZAR means no conversion. */
  currency: string;
  /** Supplier cost per unit in `currency`, micro units. */
  nativeUnitCostMicro: number;
  /** "verified" only when someone has confirmed it against a supplier quote / invoice. */
  verification: "verified" | "unverified";
  /** Where the figure came from (workbook sheet, supplier quote reference, Cin7 supplier price...). */
  source: string;
}

export interface FreightInput {
  /** Multiplier on the converted cost (1.2 = +20%), micro units. 1_000_000 = none. */
  factorMicro: number;
  /** A fixed landed-cost add-on per unit, in cents (duty, clearing, local freight). */
  addOnCents?: number;
  source: string;
}

export interface FxQuote { rateMicro: number; source: string; asOf: string }
/** The Estimator's own forward-exchange-contract rate. It replaces the spot rate for that currency, visibly, and carries who set it and why. */
export interface ForwardCover extends Reasoned { rateMicro: number; coverDays: number; reference?: string }

export interface PricingLineInput {
  key: string;
  label: string;
  sku: string | null;
  quantity: number;
  /** null = the supplier cost is NOT KNOWN. Never treated as zero. */
  cost: SupplierCostInput | null;
  freight: FreightInput | null;
}

// ── overrides and adjustments ──────────────────────────────────────────────

export interface ItemOverride {
  /** Replace the calculated unit selling price (ex VAT) for this line. */
  price?: Reasoned & { unitPriceCents: number };
  /** Replace the quantity for this line. */
  quantity?: Reasoned & { quantity: number };
}

/** An overall change to the project markup on landed cost. Applies to every line that has no item price override. */
export interface ProjectMarkupChange extends Reasoned { markupBps: number }

/** An overall adjustment to the project's selling price, kept as its OWN line: it is never spread into item prices. */
export type ProjectAdjustment = Reasoned & ({ kind: "target_total"; targetTotalCents: number } | { kind: "amount"; amountCents: number });

export interface PricingScenario {
  /** The instant the calculation is "as of" (ISO). Used for rate age; passed in so the calculation is deterministic. */
  pricingDate: string;
  fxQuotes: Record<string, FxQuote | undefined>;
  forwardCover: Record<string, ForwardCover | undefined>;
  lines: PricingLineInput[];
  itemOverrides: Record<string, ItemOverride | undefined>;
  projectMarkup: ProjectMarkupChange | null;
  projectAdjustment: ProjectAdjustment | null;
}
