import type { ProductionRun, ProductionRunOperation } from "@/cin7/production-order-run";

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
