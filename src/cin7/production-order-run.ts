import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * `/production/order/run` — a wholly separate Cin7 resource from
 * `/production/order` (see production-order-detail.ts, which is confirmed
 * to be pure plan/BOM data with no progress fields at all). Found via the
 * community Apiary spec transcription (github.com/nnhansg/dear-openapi,
 * specification/dearinventory.apib, "Production Run" section) and
 * confirmed live 2026-07-14 against a genuinely in-progress order
 * (MO-00019, Spark Demo instance): Mixing showed Status "COMPLETED" with a
 * real ActualTime/StartDate/EndDate and actual ResourceCosts; Blending
 * (not yet started) showed Status "PLANNED" with everything empty/null —
 * exactly matching Cin7's own UI (Mixing checked off, Blending selected as
 * current, Start button enabled).
 */
const RUN_PATH = "/production/order/run";

export interface ProductionRunOperationComponent {
  productCode: string | null;
  /** Actual quantity consumed so far (0 until the operation genuinely issues stock) — distinct from expectedQuantity, the planned figure. */
  quantity: number;
  expectedQuantity: number;
  /** Actual wastage — confirmed real field, though every live example seen so far was 0. */
  wastageQty: number;
}

export interface ProductionRunOperationResourceCost {
  /** GL account the actual cost was posted against. */
  expenseAccount: string | null;
  /** Actual cost incurred for this operation — distinct from the standard/planned cost on Resources. */
  cost: number;
}

export interface ProductionRunOperation {
  operationId: string;
  /** Sequence number — "current stage" = the first operation (by this field ascending) whose status isn't COMPLETED. */
  order: number;
  name: string | null;
  workCenterName: string | null;
  /** PLANNED | IN PROGRESS | SUSPENDED | COMPLETED (confirmed live values). */
  status: string;
  plannedTime: number | null;
  actualTime: number | null;
  startDate: string | null;
  endDate: string | null;
  components: ProductionRunOperationComponent[];
  resourceCosts: ProductionRunOperationResourceCost[];
}

export interface ProductionRun {
  runId: string;
  number: number;
  /** PLANNED | IN PROGRESS | OPERATION_COMPLETED | COMPLETED | VOIDED (confirmed live values). */
  status: string;
  /** GL account holding this run's WIP value — informational only, no GL/trial-balance integration exists anywhere in this codebase to reconcile against. */
  wipAccount: string | null;
  operations: ProductionRunOperation[];
}

function toRunOperation(raw: Record<string, unknown>): ProductionRunOperation {
  const components = Array.isArray(raw.Components) ? (raw.Components as Record<string, unknown>[]) : [];
  const resourceCosts = Array.isArray(raw.ResourceCosts) ? (raw.ResourceCosts as Record<string, unknown>[]) : [];
  return {
    operationId: String(raw.OperationID ?? ""),
    order: Number(raw.Order ?? 0),
    name: typeof raw.Name === "string" ? raw.Name : null,
    workCenterName: typeof raw.WorkCenterName === "string" ? raw.WorkCenterName : null,
    status: String(raw.Status ?? ""),
    plannedTime: typeof raw.PlannedTime === "number" ? raw.PlannedTime : null,
    actualTime: typeof raw.ActualTime === "number" ? raw.ActualTime : null,
    startDate: typeof raw.StartDate === "string" ? raw.StartDate : null,
    endDate: typeof raw.EndDate === "string" ? raw.EndDate : null,
    components: components.map((c) => ({
      productCode: typeof c.ProductCode === "string" ? c.ProductCode : null,
      quantity: Number(c.Quantity ?? 0),
      expectedQuantity: Number(c.ExpectedQuantity ?? 0),
      wastageQty: Number(c.WastageQty ?? 0),
    })),
    resourceCosts: resourceCosts.map((r) => ({
      expenseAccount: typeof r.ExpenseAccount === "string" ? r.ExpenseAccount : null,
      cost: Number(r.Cost ?? 0),
    })),
  };
}

/** Fetches every Run for one Production Order, typed per the confirmed live shape above. Empty array if the order has no Runs yet (e.g. never released). */
export async function fetchProductionOrderRun(creds: Cin7Credentials, productionOrderId: string): Promise<ProductionRun[]> {
  const response = await cin7Request<{ Runs?: Record<string, unknown>[] }>(creds, RUN_PATH, {
    query: { ProductionOrderID: productionOrderId },
  });
  const runs = Array.isArray(response.Runs) ? response.Runs : [];
  return runs.map((run) => ({
    runId: String(run.RunID ?? ""),
    number: Number(run.Number ?? 0),
    status: String(run.Status ?? ""),
    wipAccount: typeof run.WIPAccount === "string" ? run.WIPAccount : null,
    operations: Array.isArray(run.Operations) ? (run.Operations as Record<string, unknown>[]).map(toRunOperation) : [],
  }));
}
