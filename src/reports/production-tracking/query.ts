import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProductionTrackingRow {
  productionOrderId: string;
  orderNumber: string | null;
  productSku: string | null;
  productName: string | null;
  locationName: string | null;
  listStatus: string | null;
  requiredByDate: string | null;
  completionDate: string | null;
  runStatus: string | null;
  wipAccount: string | null;
  currentOperationName: string | null;
  currentWorkCenterName: string | null;
  /** Operations[].Order for the current stage — drives the Kanban board's column ordering (groupByWorkCentre in build.ts), not shown directly in the UI. */
  currentOperationOrder: number | null;
  currentOperationStartedAt: string | null;
  /** The Run's own planned quantity to produce — "how many did it start with," null until the first successful run-detail fetch. */
  plannedQuantity: number | null;
  /**
   * The current operation's own InputProducts figures, copied onto the
   * header row so the Kanban card can flag a shortfall without fetching
   * full per-operation detail — null on all three means the current
   * stage's BOM doesn't define Inputs/Outputs (not tracked), distinct from
   * 0 (tracked, no shortfall).
   */
  currentInputExpectedQty: number | null;
  currentInputActualQty: number | null;
  currentInputWastageQty: number | null;
  /**
   * The real finished-good quantity actually produced — sourced from the
   * Run's own Output[] (see actualOutputQty() in production-order-run.ts),
   * confirmed live 2026-07-15 (MO-00042) to match Cin7's own "Actually
   * Produced" figure exactly. An earlier attempt sourced this from an
   * operation's FinishedProducts.outputQuantity instead, which was
   * confirmed unreliable (silently duplicated the wastage figure instead
   * of the actual produced quantity) — null until output has actually
   * been received into stock.
   */
  actualOutputQty: number | null;
  wipActualCost: number | null;
  runSyncedAt: string | null;
  /** Sum of production_operations.wastage_qty across this order's latest Run — a plain DB read alongside the header rows, not a separate per-row query. */
  totalWastage: number;
  /** Cin7's own free-text Production Order Tags field — commonly used to note which customer/sales order a run is for. Shown on the Kanban card. */
  tags: string | null;
}

/**
 * Open production orders (list_status not COMPLETED/VOIDED) by default,
 * with a toggle to include completed/voided ones too — a late order that
 * never started still needs to show up, so "open" is the meaningful
 * default here, not "in progress only". Fetches production_operations'
 * wastage_qty for the same instance alongside the header rows and sums it
 * client-side per order — same "already-fetched, cheap plain DB read"
 * convention as getOrderFulfillmentLines, not a per-row query.
 */
export async function getProductionTrackingRows(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  includeCompleted = false
): Promise<ProductionTrackingRow[]> {
  let ordersQuery = db.from("production_orders").select("*").eq("org_id", orgId).eq("instance_id", instanceId);
  if (!includeCompleted) ordersQuery = ordersQuery.neq("list_status", "COMPLETED").neq("list_status", "VOIDED");

  const [ordersRes, operationsRes] = await Promise.all([
    ordersQuery.order("required_by_date", { ascending: true, nullsFirst: false }),
    db.from("production_operations").select("cin7_production_order_id, wastage_qty").eq("org_id", orgId).eq("instance_id", instanceId),
  ]);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (operationsRes.error) throw new Error(operationsRes.error.message);

  const wastageByOrder = new Map<string, number>();
  for (const op of operationsRes.data ?? []) {
    const key = op.cin7_production_order_id as string;
    wastageByOrder.set(key, (wastageByOrder.get(key) ?? 0) + (op.wastage_qty ?? 0));
  }

  return (ordersRes.data ?? []).map((o) => ({
    productionOrderId: o.cin7_production_order_id,
    orderNumber: o.order_number,
    productSku: o.product_sku,
    productName: o.product_name,
    locationName: o.location_name,
    listStatus: o.list_status,
    requiredByDate: o.required_by_date,
    completionDate: o.completion_date,
    runStatus: o.run_status,
    wipAccount: o.wip_account,
    currentOperationName: o.current_operation_name,
    currentWorkCenterName: o.current_work_center_name,
    currentOperationOrder: o.current_operation_order,
    currentOperationStartedAt: o.current_operation_started_at,
    plannedQuantity: o.planned_quantity,
    currentInputExpectedQty: o.current_input_expected_qty,
    currentInputActualQty: o.current_input_actual_qty,
    currentInputWastageQty: o.current_input_wastage_qty,
    actualOutputQty: o.actual_output_qty,
    wipActualCost: o.wip_actual_cost,
    runSyncedAt: o.run_synced_at,
    totalWastage: wastageByOrder.get(o.cin7_production_order_id) ?? 0,
    tags: o.tags,
  }));
}

export interface ProductionOperationRow {
  operationOrder: number;
  operationName: string | null;
  workCenterName: string | null;
  status: string | null;
  plannedTime: number | null;
  actualTime: number | null;
  startDate: string | null;
  endDate: string | null;
  actualResourceCost: number | null;
  /** Material cost consumed at this stage — sum of component quantity * unitCost, the other half of "value added per stage" alongside actualResourceCost. */
  actualMaterialCost: number | null;
  wastageQty: number | null;
  /**
   * Real, Cin7-tracked semi-finished-product transfer figures (Cin7's own
   * "Inputs and Outputs" feature, help.core.cin7.com/hc/en-us/articles/
   * 9034587837839) — null on ALL THREE means this stage's BOM doesn't
   * define an intermediate product here at all (the common case; "not
   * necessary to include input/output in a Production BOM" per Cin7's own
   * docs), which the UI should render as "not tracked," not as zero.
   */
  inputExpectedQty: number | null;
  inputActualQty: number | null;
  inputWastageQty: number | null;
  /** How much semi-finished product this stage produced for the next one — null when the BOM doesn't define an output here. */
  outputQty: number | null;
  /**
   * Wastage flagged on THIS stage's own Output record — confirmed live
   * 2026-07-14 (MO-00042) that this can be nonzero (properly flagged by
   * the operator on Roasting's Output screen) while the NEXT stage's own
   * InputWastageQty stays 0 for the same handoff — Output and Input are
   * separate, independently-entered Cin7 records. Lets the next stage's
   * shortfall message say "flagged as wastage in {this stage}" instead of
   * wrongly claiming nothing was flagged anywhere.
   */
  outputWastageQty: number | null;
}

/** Per-operation breakdown behind one order's row (the drill-down panel) — a plain DB read, already synced, not a live Cin7 call. */
export async function getProductionOrderOperations(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  productionOrderId: string
): Promise<ProductionOperationRow[]> {
  const { data, error } = await db
    .from("production_operations")
    .select("*")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("cin7_production_order_id", productionOrderId)
    .order("operation_order", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((op) => ({
    operationOrder: op.operation_order,
    operationName: op.operation_name,
    workCenterName: op.work_center_name,
    status: op.status,
    plannedTime: op.planned_time,
    actualTime: op.actual_time,
    startDate: op.start_date,
    endDate: op.end_date,
    actualResourceCost: op.actual_resource_cost,
    actualMaterialCost: op.actual_material_cost,
    wastageQty: op.wastage_qty,
    inputExpectedQty: op.input_expected_qty,
    inputActualQty: op.input_actual_qty,
    inputWastageQty: op.input_wastage_qty,
    outputQty: op.output_qty,
    outputWastageQty: op.output_wastage_qty,
  }));
}

export interface ProductionTrackingSyncStatus {
  totalOrders: number;
  /** Open orders still waiting on their first (or a refreshed) /production/order/run fetch — mirrors getSalesSyncStatus's pendingDetail signal, since this is a two-phase queued sync, not a snapshot-replace one. */
  pendingRunDetail: number;
}

/** Scoped to one instance — same convention as Replenish's own sync-status action. */
export async function getProductionTrackingSyncStatus(db: SupabaseClient, orgId: string, instanceId: string): Promise<ProductionTrackingSyncStatus> {
  const totalQuery = db.from("production_orders").select("*", { count: "exact", head: true }).eq("org_id", orgId).eq("instance_id", instanceId);
  const pendingQuery = db
    .from("production_orders")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .neq("list_status", "COMPLETED")
    .neq("list_status", "VOIDED")
    .is("run_synced_at", null);
  const [totalRes, pendingRes] = await Promise.all([totalQuery, pendingQuery]);
  if (totalRes.error) throw new Error(totalRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  return { totalOrders: totalRes.count ?? 0, pendingRunDetail: pendingRes.count ?? 0 };
}
