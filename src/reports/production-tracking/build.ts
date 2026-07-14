import type { ProductionRun, ProductionRunOperation } from "@/cin7/production-order-run";
import type { ProductionTrackingRow, ProductionOperationRow } from "@/reports/production-tracking/query";

/**
 * Confirmed live 2026-07-14 (Spark Demo, MO-00019): "current stage" is the
 * first Operation (by `order` ascending) whose `status` isn't `COMPLETED` —
 * matches Cin7's own UI exactly (Mixing checked off/complete, Blending
 * selected as current with its Start button enabled). Returns null once
 * every operation is COMPLETED (order fully done) or there are no
 * operations at all.
 */
export function deriveCurrentOperation(operations: ProductionRunOperation[]): ProductionRunOperation | null {
  const sorted = [...operations].sort((a, b) => a.order - b.order);
  return sorted.find((op) => op.status !== "COMPLETED") ?? null;
}

/**
 * WIP financial position — sums the ACTUAL GL-posted cost
 * (ResourceCosts[].Cost) across every operation belonging to a Run that
 * isn't COMPLETED or VOIDED. This is a bottom-up reconstruction, not a
 * real query against Cin7's GL/trial balance (no such integration exists
 * anywhere in this codebase) — Cin7 could post costs to the run's
 * WIPAccount that never appear in ResourceCosts (e.g. overhead
 * allocations), so this should be presented as an estimate, not an
 * authoritative accounting figure.
 */
export function computeWipCost(runs: ProductionRun[]): number {
  return runs
    .filter((run) => run.status !== "COMPLETED" && run.status !== "VOIDED")
    .flatMap((run) => run.operations)
    .flatMap((op) => op.resourceCosts)
    .reduce((sum, rc) => sum + rc.cost, 0);
}

/** Rolls per-operation actual wastage into one order-level total. */
export function totalWastage(operations: ProductionRunOperation[]): number {
  return operations.flatMap((op) => op.components).reduce((sum, c) => sum + c.wastageQty, 0);
}

/**
 * Days late as of `today` (both "YYYY-MM-DD") — positive once
 * `requiredByDate` has passed, null when there's no required-by date to
 * compare against. Doesn't consider status; callers combine this with
 * `isLate` for the actual late/not-late decision.
 */
export function daysLate(requiredByDate: string | null, today: string): number | null {
  if (!requiredByDate) return null;
  const diffMs = new Date(today).getTime() - new Date(requiredByDate).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * An order is late once its required-by date has passed AND it hasn't
 * finished (COMPLETED) or been cancelled (VOIDED) — a completed order that
 * finished after its due date is a historical fact, not something to flag
 * as currently late, and a voided order was cancelled, not missed.
 */
export function isLate(requiredByDate: string | null, listStatus: string | null, today: string): boolean {
  const days = daysLate(requiredByDate, today);
  if (days === null || days <= 0) return false;
  return listStatus !== "COMPLETED" && listStatus !== "VOIDED";
}

/**
 * True when the order's current stage has actually started AND received
 * less of the previous stage's semi-finished output than Cin7 expected —
 * the Kanban card's shortfall alert.
 *
 * Compares actual vs expected directly rather than trusting Cin7's own
 * InputProducts.WastageQuantity field: confirmed live 2026-07-14 on
 * MO-00042 that a real shortfall (Grinding expected 25.5kg from Roasting,
 * actually received only 23.5kg) can show WastageQuantity 0 — an operator
 * can enter a lower received quantity on Cin7's own Input screen without
 * separately flagging it as wastage, the exact same ambiguity as the
 * Output screen's "reduce the quantity" vs "enter wastage" choice. Relying
 * on WastageQuantity alone would silently miss this.
 *
 * Gated on `currentOperationStartedAt !== null` (the current operation's
 * own StartDate, already set once Cin7 shows it IN PROGRESS/SUSPENDED/
 * COMPLETED) so a not-yet-started stage — which always shows 0 received,
 * because nothing has happened yet — doesn't misfire as a false
 * "shortfall". False for orders whose current stage doesn't track
 * Inputs/Outputs at all (currentInputExpectedQty/currentInputActualQty
 * null).
 */
export function hasInputShortfall(
  row: Pick<ProductionTrackingRow, "currentOperationStartedAt" | "currentInputExpectedQty" | "currentInputActualQty">
): boolean {
  if (row.currentOperationStartedAt === null) return false;
  if (row.currentInputExpectedQty === null || row.currentInputActualQty === null) return false;
  return row.currentInputActualQty < row.currentInputExpectedQty;
}

/** A label reserved for orders with no Run yet at all (never released) — distinct from a real, named work centre. */
export const NOT_STARTED_COLUMN = "Not started yet";

/** A labeled bucket of orders for a Kanban column — reused by both groupByWorkCentre and groupByStatus below (the `workCentre` field just means "column label" in the status case, not literally a work centre). */
export interface WorkCentreColumn {
  workCentre: string;
  orders: ProductionTrackingRow[];
}

/**
 * Buckets open orders into Kanban columns by their current work centre.
 * `NOT_STARTED_COLUMN` (orders with no Run yet) always sorts first, since
 * it isn't a real stage in any BOM's routing; the remaining columns order
 * by the lowest `currentOperationOrder` seen among orders sitting there —
 * a heuristic, not a configured sequence, since different BOMs can route
 * through work centres in different orders. Orders within a column keep
 * whatever order the caller already sorted `rows` in (e.g. by required-by
 * date), not re-sorted here.
 */
export function groupByWorkCentre(rows: ProductionTrackingRow[]): WorkCentreColumn[] {
  const byWorkCentre = new Map<string, ProductionTrackingRow[]>();
  for (const row of rows) {
    const key = row.currentWorkCenterName ?? NOT_STARTED_COLUMN;
    const arr = byWorkCentre.get(key) ?? [];
    arr.push(row);
    byWorkCentre.set(key, arr);
  }

  const columns = [...byWorkCentre.entries()].map(([workCentre, orders]) => ({ workCentre, orders }));
  columns.sort((a, b) => {
    if (a.workCentre === NOT_STARTED_COLUMN) return -1;
    if (b.workCentre === NOT_STARTED_COLUMN) return 1;
    const aMin = Math.min(...a.orders.map((o) => o.currentOperationOrder ?? Infinity));
    const bMin = Math.min(...b.orders.map((o) => o.currentOperationOrder ?? Infinity));
    return aMin - bMin;
  });
  return columns;
}

/**
 * Real, confirmed-live `Status` (production_orders.list_status) lifecycle
 * order for a given account (surveyed 2026-07-14 across every order on
 * Spark Demo — all six values are real: DRAFT, PLANNED, RELEASED,
 * IN PROGRESS, COMPLETED, VOIDED). A fixed sequence, unlike work-centre
 * columns — every order goes through this same order-level lifecycle
 * regardless of its BOM's own routing, so there's no need for
 * groupByWorkCentre's "lowest position seen" heuristic here.
 */
export const PRODUCTION_STATUS_ORDER = ["DRAFT", "PLANNED", "RELEASED", "IN PROGRESS", "COMPLETED", "VOIDED"];

/**
 * Buckets orders into Kanban columns by their order-level `listStatus`
 * (Cin7's Status field — distinct from the per-operation work-centre
 * board, and from OrderStatus, a separate DRAFT/AUTHORISED/RELEASED/VOIDED
 * approval-gate field this codebase doesn't currently track). `hidden`
 * lets the caller drop specific columns (e.g. Draft, Planned) without
 * losing anything — the underlying rows are untouched, just not bucketed
 * into a column for a hidden status. A status with no orders in `rows` at
 * all still produces an (empty) column unless hidden, since seeing "0" in
 * e.g. Draft is itself useful information — it's the caller's job to skip
 * rendering empty columns if desired, not this function's.
 */
export function groupByStatus(rows: ProductionTrackingRow[], hidden: Set<string> = new Set()): WorkCentreColumn[] {
  const byStatus = new Map<string, ProductionTrackingRow[]>();
  for (const status of PRODUCTION_STATUS_ORDER) {
    if (!hidden.has(status)) byStatus.set(status, []);
  }
  for (const row of rows) {
    const key = row.listStatus ?? "(none)";
    if (hidden.has(key)) continue;
    const arr = byStatus.get(key) ?? [];
    arr.push(row);
    byStatus.set(key, arr);
  }

  const known = new Set(PRODUCTION_STATUS_ORDER);
  const columns = [...byStatus.entries()].map(([workCentre, orders]) => ({ workCentre, orders }));
  columns.sort((a, b) => {
    const aIdx = known.has(a.workCentre) ? PRODUCTION_STATUS_ORDER.indexOf(a.workCentre) : PRODUCTION_STATUS_ORDER.length;
    const bIdx = known.has(b.workCentre) ? PRODUCTION_STATUS_ORDER.indexOf(b.workCentre) : PRODUCTION_STATUS_ORDER.length;
    return aIdx - bIdx;
  });
  return columns;
}

/**
 * Running total of actualResourceCost + actualMaterialCost for every
 * operation up to and including `uptoOrder` — "value added up the flow"
 * as of a given stage. `operations` isn't assumed pre-sorted.
 */
export function cumulativeCostThroughStage(operations: ProductionOperationRow[], uptoOrder: number): number {
  return operations
    .filter((op) => op.operationOrder <= uptoOrder)
    .reduce((sum, op) => sum + (op.actualResourceCost ?? 0) + (op.actualMaterialCost ?? 0), 0);
}
