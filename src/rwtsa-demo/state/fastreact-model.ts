import { LIMITS } from "@/rwtsa-demo/fastreact/contract";
import { buildExport, type ExchangeSource, type ExportReport } from "@/rwtsa-demo/fastreact/export";
import { MATRIX, SCHEDULING_FIELDS_NOT_WRITTEN, type MatrixRow } from "@/rwtsa-demo/fastreact/matrix";
import { RETURN_FIELDS, RETURN_FORMAT_LABEL, RETURN_STATUSES, buildSampleReturn, parseReturnFile, type ReturnField } from "@/rwtsa-demo/fastreact/return-format";
import { planReturn, type HistoryEntry, type ReturnPlan, type StoredOrderReturn } from "@/rwtsa-demo/fastreact/return-reconcile";
import { bannerOf, provenanceOf, type Banner, type DemoState, type ProvenanceLabel } from "@/rwtsa-demo/state/demo-state";
import { EMPTY_EXCHANGE, type ExchangeState } from "@/rwtsa-demo/state/fastreact-store";

/**
 * View model for the Fast React Exchange page. Everything is derived on this machine from the validated dataset plus the planner's
 * locally stored inputs; nothing is fetched, and nothing here claims a live connection.
 */

export const INTEGRATION_STATUS =
  "DEMONSTRATION OF AN INTEGRATION CONTRACT. No Fast React instance is connected: nothing has been sent to or received from Fast React, Cin7 Core or Xero.";

export const OWNERSHIP: readonly { readonly system: string; readonly owns: string }[] = [
  { system: "CIN7 CORE", owns: "Products, customers, operational orders and inventory." },
  { system: "FAST REACT", owns: "Scheduling and production planning: which order runs on which line, and when." },
  { system: "TOOLBOX", owns: "Exchange generation, validation, reconciliation and the local demonstration of returned information." },
  { system: "XERO", owns: "Financial accounting. Outside this exchange: Fast React and Xero never exchange data directly." },
];

/** Steps that need the vendor before production use (each is an unresolved dependency, not something this demonstration settles). */
export const VENDOR_DEPENDENCIES: readonly string[] = [
  "Confirm the Fast React version and integration method. The client runs a Light version that cannot integrate; an interface-capable version is a precondition (RWTSA-funded).",
  "Confirm the import configuration: date format, delimiter, compliant field names, header (.HDR) file, and the import directory and permissions.",
  "Supply the operation external IDs so product types carry work content (T^WC:n). None have been provided and none are invented here.",
  "Confirm the product type list in the client's Fast React, and that the production code is the Fast React product code.",
  "Confirm the section and line names, and whether the factory is a multi-section environment (U.SECT is then compulsory).",
  "Keep the 'synchronise / delete missing orders' import option OFF unless the full order position is intended: this demonstration never relies on it.",
  "Obtain the vendor's real return (export) layout. The return file here is Spark's proposal, to be replaced or mapped once the vendor supplies theirs.",
];

export interface OrderView {
  readonly orderNo: string;
  readonly styleCode: string;
  readonly qty: number;
  /** The planning line the workbook records (Rev2 production-line column); Fast React's returned line is shown separately. */
  readonly workbookLine: string;
  readonly returned: StoredOrderReturn | null;
  /** Whole percent complete from the returned quantity, or null when nothing has been returned. */
  readonly percentComplete: number | null;
}

export interface PendingView {
  readonly fileHash: string;
  readonly sourceKind: "synthetic-sample" | "upload";
  readonly createdAt: string;
  readonly plan: ReturnPlan;
}

export interface FastReactModel {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly integrationStatus: string;
  readonly hasData: boolean;
  readonly sourceLabel: string | null;
  readonly orders: readonly OrderView[];
  readonly customers: readonly string[];
  readonly styles: readonly string[];
  readonly exchange: ExchangeState;
  readonly stateError: string | null;
  readonly report: ExportReport;
  readonly matrix: readonly MatrixRow[];
  readonly schedulingNotWritten: typeof SCHEDULING_FIELDS_NOT_WRITTEN;
  readonly returnLabel: string;
  readonly returnFields: readonly ReturnField[];
  readonly returnStatuses: readonly string[];
  /** The synthetic sample return file (text), for display and download. Empty when it cannot be generated. */
  readonly sampleText: string;
  readonly limits: typeof LIMITS;
  readonly pending: PendingView | null;
  readonly history: readonly HistoryEntry[];
  readonly ownership: typeof OWNERSHIP;
  readonly vendorDependencies: readonly string[];
}

/** The exchange source from a validated dataset. Null when there is none. Never substitutes another source. */
export function exchangeSourceFrom(state: DemoState): ExchangeSource | null {
  if (state.kind !== "validated" || state.dataset === null) return null;
  const t = state.dataset.tables;
  return {
    provenance: state.dataset.provenance,
    sourceLabel: state.summary.sourceLabel,
    customers: t.customers.map((c) => c.customer),
    items: t.items.map((i) => ({ sku: i.sku, styleCode: i.styleCode, productionCode: i.productionCode ?? null, description: i.description ?? null })),
    orders: t.productionOrders.map((o) => ({ orderNo: o.orderNo, styleCode: o.styleCode, qty: o.qty })),
  };
}

export function fastReactModel(state: DemoState, exchange: ExchangeState | null, stateError: string | null, now: Date): FastReactModel {
  const source = exchangeSourceFrom(state);
  const ex = exchange ?? EMPTY_EXCHANGE;
  const report = buildExport(source, ex.supplement, { ...ex.options, updates: [] });
  const lineByOrder = new Map<string, string>();
  if (state.kind === "validated" && state.dataset) for (const o of state.dataset.tables.productionOrders) lineByOrder.set(o.orderNo, o.productionLine);
  const orders: OrderView[] = (source?.orders ?? [])
    .map((o) => {
      const returned = ex.returns.orders[o.orderNo] ?? null;
      return {
        orderNo: o.orderNo,
        styleCode: o.styleCode,
        qty: o.qty,
        workbookLine: lineByOrder.get(o.orderNo) ?? "",
        returned,
        percentComplete: returned === null || o.qty <= 0 ? null : Math.round((returned.qtyDone / o.qty) * 100),
      };
    })
    .sort((a, b) => (a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0));
  let pending: PendingView | null = null;
  if (ex.pending && source) {
    const plan = planReturn(parseReturnFile(ex.pending.text), source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty })), ex.returns, { now, fileHash: ex.pending.fileHash });
    pending = { fileHash: ex.pending.fileHash, sourceKind: ex.pending.sourceKind, createdAt: ex.pending.createdAt, plan };
  }
  return {
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    integrationStatus: INTEGRATION_STATUS,
    hasData: source !== null,
    sourceLabel: source?.sourceLabel ?? null,
    orders,
    customers: [...new Set(source?.customers ?? [])].sort(),
    styles: [...new Set((source?.orders ?? []).map((o) => o.styleCode))].sort(),
    exchange: ex,
    stateError,
    report,
    matrix: MATRIX,
    schedulingNotWritten: SCHEDULING_FIELDS_NOT_WRITTEN,
    returnLabel: RETURN_FORMAT_LABEL,
    returnFields: RETURN_FIELDS,
    returnStatuses: RETURN_STATUSES,
    sampleText: source ? buildSampleReturn(source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty })), now) : "",
    limits: LIMITS,
    pending,
    history: ex.returns.history,
    ownership: OWNERSHIP,
    vendorDependencies: VENDOR_DEPENDENCIES,
  };
}
