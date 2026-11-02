import type { AnomalyConfig } from "./anomaly";
import type { DemandForecast } from "./forecast";

export type Classification = "ordinary" | "tender" | "unclassified";
export type ClassificationSource = "planner" | "workbook" | "none";
export type ReplenishmentFormula = "minimum-shortfall" | "net-requirement";

/** A planner's temporary minimum for one SKU. Applies in each projection week whose closing date is on or after `effectiveFrom` and, when set, on or before `expires`. */
export interface MinOverrideInput {
  readonly replacement: number;
  readonly effectiveFrom: string;
  /** null = until removed by the planner. */
  readonly expires: string | null;
}
export interface PlannerInputs {
  /** The planner's tender / ordinary classification per SKU (overrides the workbook). A SKU absent here keeps the workbook's value, or is unclassified. */
  readonly classification: Readonly<Record<string, "ordinary" | "tender">>;
  readonly minOverrides: Readonly<Record<string, MinOverrideInput>>;
}

export type HistoryAnchor = "last-available" | "strict";
export type OverdueOnWater = "week-1" | "exclude";
export type SizeCurveConfig =
  | { readonly kind: "none" }
  | { readonly kind: "explicit"; readonly weights: Readonly<Record<string, number>>; readonly label?: string; readonly provenance?: string }
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
  /** Which formula drives the calculated replenishment proposal. The approved minimum-shortfall rule is the default. */
  readonly replenishmentFormula: ReplenishmentFormula;
  readonly planner: PlannerInputs;
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
  replenishmentFormula: "minimum-shortfall",
  planner: { classification: {}, minOverrides: {} },
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
  /** The last month of the forecast window: the last observed month under "last-available". */
  readonly windowEnd: string;
  /** Whole months between the last observed month and the stock month (0 = history is current). */
  readonly staleMonths: number;
  readonly staleWarning: string | null;
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
  /** True for a tender / customer-order-only SKU (no standing replenishment). */
  readonly tenderExempt: boolean;
  readonly classification: Classification;
  readonly classificationSource: ClassificationSource;
  /** The workbook's minimum, never overwritten. */
  readonly minLevel: number | null;
  /** The minimum in force at the stock date (the override while it is active, else the original). */
  readonly effectiveMin: number | null;
  readonly minOverride: MinOverrideInput | null;
  /** Projection weeks (1..H) in which the override is in force. */
  readonly minOverrideWeeks: number;
  /** The proposal by the selected formula. 0 for tender; the value for an unclassified SKU is NOT a proposal until it is classified. Null when it cannot be calculated. */
  readonly proposalCalculated: number | null;
  readonly proposalFormula: ReplenishmentFormula;
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
  /** OPENING cover: opening Available / average monthly demand. */
  readonly monthsOfCover: number | null;
  /** Units of usable inbound supply inside the horizon (overdue and beyond-horizon units are not in it). */
  readonly coverInboundUnits: number;
  /** RFP DP-17 cover: (opening Available + usable inbound within the horizon) / average monthly demand. Committed is already netted in Available. */
  readonly monthsOfCoverWithInbound: number | null;
  /** RFP DP-13 net requirement: forecast demand over the horizon - Available - usable inbound, whole units, >= 0. Always 0 for a tender SKU. A DIFFERENT formula from the approved minimum-shortfall proposal. */
  readonly netRequirement: number | null;
  readonly anomalyStatus: "none" | "review" | "excluded";
  readonly excludedMonths: readonly string[];
  readonly evaluable: boolean;
  readonly limitation: string | null;
}

export interface StyleResult {
  readonly styleCode: string;
  readonly skuCount: number;
  readonly available: number;
  /** Opening Available of the SKUs that can be projected: the same basis as `balances` and `minLevel`. */
  readonly projectedOpening: number;
  readonly inboundTotal: number;
  readonly monthlyForecast: number;
  readonly weeklyForecast: number;
  readonly minLevel: number;
  readonly balances: readonly number[];
  readonly firstBreachWeek: number | null;
  readonly shortfall: number;
  readonly proposedOrder: number;
  readonly monthsOfCover: number | null;
  readonly monthsOfCoverWithInbound: number | null;
  /** Sum of its SKUs' net requirements; null when any non-tender SKU has none (unknowns are not counted as zero). */
  readonly netRequirement: number | null;
  readonly shortageSkus: number;
  readonly skusWithoutForecast: number;
  readonly tenderExemptSkus: number;
  readonly anomaliesToReview: number;
  readonly anomaliesExcluded: number;
}

export interface SizeAllocationLine {
  readonly styleCode: string;
  readonly poNo: string;
  /** The style-level quantity on the purchase-order line. */
  readonly qty: number;
  readonly parts: readonly { readonly sku: string; readonly size: string; readonly units: number }[];
}
export interface SizeAllocationReport {
  readonly curveLabel: string | null;
  readonly curveProvenance: string | null;
  readonly lines: readonly SizeAllocationLine[];
  readonly unitsIn: number;
  readonly unitsAllocated: number;
  /** Every line's allocated sizes add up to its original style-level quantity, exactly. */
  readonly reconciles: boolean;
}

export interface InboundReport {
  /** All units on lines still marked on the water whose ETA to stores is on or before the stock date, whatever the treatment. */
  readonly overdueOnWaterUnits: number;
  readonly sizeAllocation: SizeAllocationReport;
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
  readonly unclassifiedSkus: number;
  readonly tenderStockoutSkus: number;
  readonly skusWithoutForecast: number;
  readonly availableMismatchSkus: number;
  /** Planner exclusions in force, whether or not the detector currently flags the month. */
  readonly exclusionsApplied: number;
}

export interface ComparisonRow {
  readonly sku: string;
  readonly styleCode: string;
  /** Averages over the 6 and 12 months ending at the window end; null when a month is missing (nothing is invented). Planner exclusions are NOT applied: this reconciles raw history. */
  readonly avg6: number | null;
  readonly avg12: number | null;
  readonly ref6: number | null;
  readonly ref12: number | null;
  readonly match6: boolean | null;
  readonly match12: boolean | null;
}
export interface ComparisonReport {
  readonly windowEnd: string;
  readonly rows: readonly ComparisonRow[];
  readonly compared6: number;
  readonly matched6: number;
  readonly compared12: number;
  readonly matched12: number;
}

export interface RedFlagResult {
  readonly comparison: ComparisonReport;
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
