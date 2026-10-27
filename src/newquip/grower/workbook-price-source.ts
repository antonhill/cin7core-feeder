import type { PriceResult, PriceSource, PriceSourceDescriptor, QuoteType } from "./pricing-source";
import { FINAL_GROWER_DECISIONS } from "./final-feedback";

// The NewQuip Master workbook, as a CONTROLLED POC SNAPSHOT. Commercial model of the workbook:
//
//     Retail ex VAT = Cost × ROE × Freight × MU          (day-to-day selling price)
//     Landed cost   = Cost × ROE × Freight               (project basis)
//     Project price = Landed cost × 1.20                 (Sean: "Project = landed cost + 20% markup")
//
// The project price is NOT Retail with another 20% added: the workbook MU is not applied for projects. All arithmetic is in
// integer cents so a price can never drift by floating-point error. This module is the only place those formulas live;
// engineering rules never see a price.

export interface SnapshotEntry {
  sku: string;
  description: string;
  /** Supplier cost in the workbook's source currency. */
  cost: number;
  roe: number;
  freight: number;
  mu: number;
  /** The workbook's Retail Price ex VAT (ZAR) — authoritative for day-to-day. */
  retailExVat: number;
}

export interface PriceSnapshot {
  id: string;
  /** e.g. "NewQuip Master workbook – POC controlled snapshot". */
  label: string;
  sourceFile: string;
  sourceSheet: string | null;
  /** ISO date the workbook was dated / captured. */
  sourceDate: string;
  sha256: string | null;
  entries: Record<string, SnapshotEntry>;
}

export const PROJECT_MARKUP_PCT = FINAL_GROWER_DECISIONS.pricing.projectMarkupPctOnLandedCost;

export const toCents = (rands: number): number => Math.round(rands * 100);
export const fromCents = (cents: number): number => cents / 100;

/** Landed cost in integer cents = Cost × ROE × Freight. */
export function landedCostCents(e: Pick<SnapshotEntry, "cost" | "roe" | "freight">): number {
  return Math.round(e.cost * e.roe * e.freight * 100);
}

/** Project selling price in integer cents = landed cost × (1 + 20%). Half-up, integer arithmetic. */
export function projectPriceCents(landedCents: number, markupPct: number = PROJECT_MARKUP_PCT): number {
  return Math.round((landedCents * (100 + markupPct)) / 100);
}

export const WORKBOOK_SOURCE_LABEL = "NewQuip Master workbook – POC controlled snapshot";

function describe(snapshot: PriceSnapshot): PriceSourceDescriptor {
  return {
    id: "newquip_master_workbook_snapshot",
    label: WORKBOOK_SOURCE_LABEL,
    basis: "Day-to-day: workbook Retail Price ex VAT. Project: landed cost (Cost × ROE × Freight) + 20%.",
    provenance: `${snapshot.sourceFile}${snapshot.sourceSheet ? ` · sheet ${snapshot.sourceSheet}` : ""} · dated ${snapshot.sourceDate}${snapshot.sha256 ? ` · sha256 ${snapshot.sha256.slice(0, 12)}…` : ""}`,
    notice: "POC price source (Cin7 holds demo data). Not a production price list — the production source stays swappable.",
  };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function createWorkbookPriceSource(snapshot: PriceSnapshot): PriceSource {
  return {
    descriptor: describe(snapshot),
    has: (sku) => Object.prototype.hasOwnProperty.call(snapshot.entries, sku),
    priceFor(sku: string, quoteType: QuoteType): PriceResult {
      const e = Object.prototype.hasOwnProperty.call(snapshot.entries, sku) ? snapshot.entries[sku] : undefined;
      if (!e) return { status: "not_in_source", reason: `${sku} is not in the ${snapshot.label}.` };
      if (![e.cost, e.roe, e.freight, e.mu, e.retailExVat].every(finite) || e.cost < 0 || e.roe < 0 || e.freight < 0) {
        return { status: "not_in_source", reason: `${sku} has an invalid workbook row (non-numeric or negative figures).` };
      }
      const landed = landedCostCents(e);
      const unit = quoteType === "project" ? projectPriceCents(landed) : toCents(e.retailExVat);
      // A zero (or missing) price is NEVER a R0 quote line: it is flagged for a supplier quote (e.g. NQ3132, Retail 0).
      if (unit <= 0) {
        return {
          status: "supplier_quote_required",
          reason: `N/A — supplier quote required: the workbook ${quoteType === "project" ? "landed cost" : "Retail Price"} for ${sku} is zero. It is never quoted at R0.`,
        };
      }
      return { status: "priced", unitPriceExVat: fromCents(unit), landedCostExVat: fromCents(landed) };
    },
  };
}

/** Penning is sold per RUNNING METRE by pig size (Sean final). These are selling rates, ex VAT. */
export const PENNING_RATE_PER_RM = FINAL_GROWER_DECISIONS.penning.rateExVatByPigSize;
