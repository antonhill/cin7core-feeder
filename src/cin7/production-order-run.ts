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
  /** Per-unit actual cost — the material-cost half of "value added per stage" (resourceCosts on the operation is the other half). */
  unitCost: number;
}

export interface ProductionRunOperationResourceCost {
  /** GL account the actual cost was posted against. */
  expenseAccount: string | null;
  /** Actual cost incurred for this operation — distinct from the standard/planned cost on Resources. */
  cost: number;
}

/**
 * A semi-finished/intermediate product handed between operations — Cin7's
 * own "Inputs and Outputs" feature (help.core.cin7.com/hc/en-us/articles/
 * 9034587837839), confirmed via their docs 2026-07-14: optional per BOM
 * ("it is not necessary to include input/output in a Production BOM"), a
 * real inventory SKU that one operation is configured to Output and a
 * later operation Input, specifically "to improve... transparency and
 * tracking of wastage of intermediate products during production." When a
 * BOM doesn't use this feature (e.g. this session's test order, MO-00019 —
 * a plain Mixing → Blending recipe with no semi-finished SKU between them),
 * these arrays are simply empty; that's the BOM's own configuration, not
 * missing/broken data.
 */
export interface ProductionRunOperationProduct {
  productSku: string | null;
  productName: string | null;
  unit: string | null;
  /** Actual quantity this operation produced/received. */
  outputQuantity: number;
  expectedQuantity: number;
  /** Actual wastage of THIS intermediate product specifically — the real, Cin7-tracked transfer figure the "input based on wastage from the previous stage" ask is really after, when the BOM defines one. */
  wastageQuantity: number;
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
  /** Semi-finished products this operation received from an earlier operation in the same BOM (empty unless the BOM defines Inputs and Outputs). */
  inputProducts: ProductionRunOperationProduct[];
  /** Semi-finished products this operation produced for a later operation in the same BOM (empty unless the BOM defines Inputs and Outputs). */
  outputProducts: ProductionRunOperationProduct[];
  /**
   * The order's finished-good line, when this operation is the one that
   * completes it — but its own `.outputQuantity` is confirmed live
   * (2026-07-15, MO-00042) to be UNRELIABLE, not just stale: on a run whose
   * own ground-truth `Output[]` (see `ProductionRun.output` below) read
   * Quantity 98/Received true, this entry read `OutputQuantity: 2,
   * WastageQuantity: 2` — i.e. `.outputQuantity` here silently duplicated
   * the wastage figure instead of the actual produced quantity. Use
   * `ProductionRun.output` for the real finished-good count; this array's
   * `.wastageQuantity` still checks out as the real wastage figure.
   */
  finishedProducts: ProductionRunOperationProduct[];
}

/**
 * One finished-good receipt into stock — the Run-level `Output[]` array,
 * a sibling of `Operations[]`, NOT the same resource as an operation's own
 * `FinishedProducts[]` (see the warning on that field above). Confirmed
 * live (2026-07-15, MO-00042) to be the reliable source: `quantity` read
 * 98 and matched Cin7's own Production Order UI ("Actually Produced: 98")
 * exactly, while the same run's operation-level FinishedProducts entry
 * read a bogus `OutputQuantity: 2`. Empty until the run's output has
 * actually been received into stock (e.g. the VOIDED run in the same
 * live example had `Output: []`).
 */
export interface ProductionRunOutputLine {
  productSku: string | null;
  productName: string | null;
  unit: string | null;
  /** The real actual finished-good quantity produced/received — confirmed live to match Cin7's own "Actually Produced" figure. */
  quantity: number;
  wastageQuantity: number;
  /** True once this output line has actually been received into stock. */
  received: boolean;
  receivedDate: string | null;
}

export interface ProductionRun {
  runId: string;
  number: number;
  /** PLANNED | IN PROGRESS | OPERATIONS COMPLETED | COMPLETED | VOIDED (confirmed live values — note the plural/space in "OPERATIONS COMPLETED", which the community Apiary spec had guessed as singular "OPERATION_COMPLETED"). */
  status: string;
  /** GL account holding this run's WIP value — informational only, no GL/trial-balance integration exists anywhere in this codebase to reconcile against. */
  wipAccount: string | null;
  /** Quantity to produce during this Run — confirmed live on MO-00019's real response ("Quantity": 1 on the Run object). The "how many did it start with" figure for the Kanban card. */
  quantity: number;
  operations: ProductionRunOperation[];
  /** The real finished-good receipt(s) for this run — see ProductionRunOutputLine's own comment. */
  output: ProductionRunOutputLine[];
}

function toRunOperationProduct(raw: Record<string, unknown>): ProductionRunOperationProduct {
  return {
    productSku: typeof raw.ProductSKU === "string" ? raw.ProductSKU : null,
    productName: typeof raw.ProductName === "string" ? raw.ProductName : null,
    unit: typeof raw.Unit === "string" ? raw.Unit : null,
    outputQuantity: Number(raw.OutputQuantity ?? 0),
    expectedQuantity: Number(raw.ExpectedQuantity ?? 0),
    wastageQuantity: Number(raw.WastageQuantity ?? 0),
  };
}

function toRunOperation(raw: Record<string, unknown>): ProductionRunOperation {
  const components = Array.isArray(raw.Components) ? (raw.Components as Record<string, unknown>[]) : [];
  const resourceCosts = Array.isArray(raw.ResourceCosts) ? (raw.ResourceCosts as Record<string, unknown>[]) : [];
  const inputProducts = Array.isArray(raw.InputProducts) ? (raw.InputProducts as Record<string, unknown>[]) : [];
  const outputProducts = Array.isArray(raw.OutputProducts) ? (raw.OutputProducts as Record<string, unknown>[]) : [];
  const finishedProducts = Array.isArray(raw.FinishedProducts) ? (raw.FinishedProducts as Record<string, unknown>[]) : [];
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
      unitCost: Number(c.UnitCost ?? 0),
    })),
    inputProducts: inputProducts.map(toRunOperationProduct),
    outputProducts: outputProducts.map(toRunOperationProduct),
    finishedProducts: finishedProducts.map(toRunOperationProduct),
    resourceCosts: resourceCosts.map((r) => ({
      expenseAccount: typeof r.ExpenseAccount === "string" ? r.ExpenseAccount : null,
      cost: Number(r.Cost ?? 0),
    })),
  };
}

function toRunOutputLine(raw: Record<string, unknown>): ProductionRunOutputLine {
  return {
    productSku: typeof raw.ProductCode === "string" ? raw.ProductCode : null,
    productName: typeof raw.ProductName === "string" ? raw.ProductName : null,
    unit: typeof raw.Unit === "string" ? raw.Unit : null,
    quantity: Number(raw.Quantity ?? 0),
    wastageQuantity: Number(raw.WastageQuantity ?? 0),
    received: raw.Received === true,
    receivedDate: typeof raw.ReceivedDate === "string" ? raw.ReceivedDate : null,
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
    quantity: Number(run.Quantity ?? 0),
    operations: Array.isArray(run.Operations) ? (run.Operations as Record<string, unknown>[]).map(toRunOperation) : [],
    output: Array.isArray(run.Output) ? (run.Output as Record<string, unknown>[]).map(toRunOutputLine) : [],
  }));
}

/**
 * The real total finished-good quantity actually produced by `run` —
 * summed across `run.output` (see ProductionRunOutputLine's own comment
 * for why this, not any operation's FinishedProducts.outputQuantity, is
 * the reliable figure). Null when output hasn't been received yet (run
 * not completed, or a VOIDED run), distinct from a genuine 0.
 */
export function actualOutputQty(run: ProductionRun | null): number | null {
  if (!run || !run.output.length) return null;
  return run.output.reduce((sum, o) => sum + o.quantity, 0);
}

/** The most recent Run (highest `number`) — an order restarting a Run is rare, so only the latest one is meaningful. Null if the order has no Runs yet (e.g. never released). */
export function pickLatestRun(runs: ProductionRun[]): ProductionRun | null {
  if (!runs.length) return null;
  return runs.reduce((a, b) => (b.number > a.number ? b : a));
}

/**
 * Actual wastage quantity per component SKU, summed across every operation
 * in `run` — confirmed live 2026-07-14 to be the real, actual figure,
 * distinct from `/production/order`'s Components[].WastageQty (always the
 * planned figure, 0 in every real example seen). Empty map for a null run
 * (order never released).
 */
export function actualWastageBySku(run: ProductionRun | null): Map<string, number> {
  const wastage = new Map<string, number>();
  if (!run) return wastage;
  for (const operation of run.operations) {
    for (const component of operation.components) {
      if (!component.productCode) continue;
      wastage.set(component.productCode, (wastage.get(component.productCode) ?? 0) + component.wastageQty);
    }
  }
  return wastage;
}
