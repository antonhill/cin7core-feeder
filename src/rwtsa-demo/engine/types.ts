import type { AnomalyConfig } from "./anomaly";
import type { DemandForecast } from "./forecast";

export type HistoryAnchor = "last-available" | "strict";
export type OverdueOnWater = "week-1" | "exclude";
export type SizeCurveConfig =
  | { readonly kind: "none" }
  | { readonly kind: "explicit"; readonly weights: Readonly<Record<string, number>> }
  | { readonly kind: "demand-proportional" };

export interface RedFlagConfig {
  /** The stock-as-at date (`YYYY-MM-DD`). The demonstration's is 31 October 2026. */
  readonly stockDate: string;
  /** Months in the demand window, 1-36 (brief default 6). */
  readonly forecastWindowMonths: number;
  /** Projection horizon in weeks: 13 or 26. */
  readonly horizonWeeks: 13 | 26;
  /**
   * How the demand window is anchored to the stock date.
   *  - "strict": the N months ending at the last COMPLETE month at the stock date. Any month absent from the workbook is
   *    reported as missing and the SKU gets no forecast. Nothing older is substituted.
   *  - "last-available": the N months ending at the workbook's last history month. The months between that and the stock
   *    date are a VISIBLE assumption (their demand is unknown and is never invented).
   */
  readonly historyAnchor: HistoryAnchor;
  /** An overdue shipment still marked on the water: assumed to land in week 1, or excluded. */
  readonly overdueOnWater: OverdueOnWater;
  readonly anomaly: AnomalyConfig;
  /** How a style-level purchase-order quantity is split to SKUs/sizes. */
  readonly sizeCurve: SizeCurveConfig;
  /** A genuinely separate dated commitment schedule: sku -> week (1-based) -> units due. Empty by default (never derived from Committed). */
  readonly committedDue: Readonly<Record<string, Readonly<Record<number, number>>>>;
}

export const DEFAULT_RED_FLAG_CONFIG: RedFlagConfig = {
  stockDate: "2026-10-31",
  forecastWindowMonths: 6,
  horizonWeeks: 13,
  historyAnchor: "last-available",
  overdueOnWater: "week-1",
  anomaly: { multiple: 5, floor: 40 },
  sizeCurve: { kind: "none" },
  committedDue: {},
};

/** A planner's exclusion of one SKU's monthly observation from the demand forecast. The reason is mandatory. */
export interface Exclusion {
  readonly sku: string;
  readonly month: string;
  readonly reason: string;
}

export interface Assumption {
  readonly id: string;
  readonly text: string;
}

export interface WindowInfo {
  readonly anchor: HistoryAnchor;
  readonly months: readonly string[];
  readonly lastHistoryMonth: string | null;
  /** The last complete month at the stock date. */
  readonly stockMonth: string;
  /** Months between the last history month and the stock month: no sales data exists for them. */
  readonly gapMonths: readonly string[];
  /** Window months that are not in the workbook's history at all. */
  readonly missingMonths: readonly string[];
}

export interface AnomalyRow {
  readonly sku: string;
  readonly styleCode: string;
  readonly month: string;
  readonly qty: number;
  readonly median: number;
  readonly inWindow: boolean;
  readonly excluded: boolean;
  readonly reason: string | null;
}

export interface SkuResult {
  readonly sku: string;
  readonly styleCode: string;
  readonly size: string;
  readonly tenderExempt: boolean;
  readonly minLevel: number | null;
  /** Opening Available by the brief's formula, or null when the SKU has no Stock row. */
  readonly available: number | null;
  readonly availableReported: number | null;
  /** computed - reported; null when the file has no Available figure or no stock row. */
  readonly availableDifference: number | null;
  readonly forecast: DemandForecast;
  readonly monthlyForecast: number | null;
  readonly weeklyForecast: number | null;
  readonly inboundWeeks: readonly number[];
  readonly inboundTotal: number;
  /** Closing balance at the end of each week 1..H. Empty when the SKU cannot be projected. */
  readonly balances: readonly number[];
  readonly firstBreachWeek: number | null;
  /** Maximum projected shortfall against the minimum across the horizon (>= 0). */
  readonly shortfall: number;
  /** A PROPOSAL (whole units, >= 0). Always 0 for a tender SKU. */
  readonly proposedOrder: number;
  readonly monthsOfCover: number | null;
  readonly anomalyStatus: "none" | "review" | "excluded";
  readonly excludedMonths: readonly string[];
  readonly evaluable: boolean;
  readonly limitation: string | null;
}

export interface StyleResult {
  readonly styleCode: string;
  readonly skuCount: number;
  readonly available: number;
  readonly inboundTotal: number;
  readonly monthlyForecast: number;
  readonly weeklyForecast: number;
  readonly minLevel: number;
  readonly balances: readonly number[];
  readonly firstBreachWeek: number | null;
  readonly shortfall: number;
  readonly proposedOrder: number;
  readonly monthsOfCover: number | null;
  readonly shortageSkus: number;
  readonly skusWithoutForecast: number;
  readonly tenderExemptSkus: number;
  readonly anomaliesToReview: number;
  readonly anomaliesExcluded: number;
}

export interface InboundReport {
  readonly onWaterUnits: number;
  readonly onOrderUnits: number;
  readonly overdueAssumedWeek1Units: number;
  readonly overdueExcludedUnits: number;
  readonly overdueOnOrderUnits: number;
  readonly beyondHorizonUnits: number;
  readonly receivedExcludedUnits: number;
  readonly unclassifiedUnits: number;
  readonly unallocatedStyleUnits: number;
  readonly unmatchedUnits: number;
  readonly reconciliation: {
    readonly skusConsistent: number;
    readonly skusMismatched: number;
    readonly inTransitStockUnits: number;
    readonly onWaterPoUnits: number;
  };
}

export interface RedFlagSummary {
  readonly skuCount: number;
  readonly shortageSkus: number;
  readonly firstBreachWeek: number | null;
  readonly totalShortfall: number;
  readonly totalProposedOrder: number;
  readonly anomaliesToReview: number;
  readonly anomaliesExcluded: number;
  readonly tenderExemptSkus: number;
  readonly skusWithoutForecast: number;
  readonly availableMismatchSkus: number;
}

export interface RedFlagResult {
  readonly config: RedFlagConfig;
  readonly window: WindowInfo;
  readonly skus: readonly SkuResult[];
  readonly styles: readonly StyleResult[];
  readonly anomalies: readonly AnomalyRow[];
  readonly inbound: InboundReport;
  readonly summary: RedFlagSummary;
  readonly assumptions: readonly Assumption[];
  readonly limitations: readonly string[];
  readonly labels: { readonly proposedOrder: string; readonly tenderExempt: string };
}
