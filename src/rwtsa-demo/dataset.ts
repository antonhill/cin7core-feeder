import type {
  BomRow,
  CustomerRow,
  ImportPoRow,
  ItemRow,
  LandedCostRow,
  PaymentFecRow,
  ProductionOrderRow,
  QuoteRow,
  RoutingRow,
  StockFileRow,
} from "@/rwtsa-demo/contracts/tabs";
import type { Finding } from "@/rwtsa-demo/findings";

/**
 * The validated, typed in-memory dataset every later calculation engine consumes.
 *
 * `provenance` is REQUIRED and travels with the data so a screen can never present synthetic test data as
 * the advisor's workbook (owner direction: no silent substitution). Only the validate script, after a clean
 * pass on the real file, produces `local-workbook`; fixtures produce `synthetic`.
 */

export type Provenance = "local-workbook" | "synthetic";

export interface DatasetSource {
  /** Never a file name or path. Synthetic: "synthetic:seed=N". Local: "local-workbook:<sha256 prefix>". */
  readonly label: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
}

export interface SalesPoint {
  readonly sku: string;
  /** `YYYY-MM` */
  readonly month: string;
  readonly qty: number;
}

export interface SalesFileAverages {
  readonly sku: string;
  readonly avg6: number | null;
  readonly avg12: number | null;
}

/** A stock row plus the brief's Available (§4): JHB + Durban + Cape Town + Factory store - Committed. Bond and In transit are excluded. */
export interface StockRow extends StockFileRow {
  readonly availableComputed: number;
}

export interface RwtsaDataset {
  readonly schemaVersion: 1;
  readonly provenance: Provenance;
  readonly source: DatasetSource;
  /** Ascending `YYYY-MM` months present in SalesHistory. */
  readonly months: readonly string[];
  readonly tables: {
    readonly items: readonly ItemRow[];
    readonly salesHistory: readonly SalesPoint[];
    readonly salesFileAverages: readonly SalesFileAverages[];
    readonly stock: readonly StockRow[];
    readonly importPos: readonly ImportPoRow[];
    readonly bom: readonly BomRow[];
    readonly routing: readonly RoutingRow[];
    readonly productionOrders: readonly ProductionOrderRow[];
    readonly landedCost: readonly LandedCostRow[];
    readonly paymentsFec: readonly PaymentFecRow[];
    readonly customers: readonly CustomerRow[];
    readonly quotes: readonly QuoteRow[];
  };
  readonly reconciliation: Reconciliation;
  /** Warnings and info only: a dataset with any error finding is never produced. */
  readonly findings: readonly Finding[];
}

export interface StyleControlTotals {
  readonly skuCount: number;
  /** Sum of the COMPUTED Available (brief formula), not the file's own column. */
  readonly availableUnits: number;
  readonly committedUnits: number;
  readonly inTransitUnits: number;
  readonly bondUnits: number;
  readonly salesLast6Months: number;
  readonly salesLast12Months: number;
  readonly salesAllMonths: number;
  readonly importPoQty: number;
}

export interface Reconciliation {
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly months: { readonly first: string | null; readonly last: string | null; readonly count: number };
  /** Keyed by style code, in sorted key order. */
  readonly unitsByStyle: Readonly<Record<string, StyleControlTotals>>;
  readonly totals: StyleControlTotals;
  /** sha256 of the canonicalised dataset: identical for identical content regardless of row/column order. */
  readonly controlHash: string;
}
