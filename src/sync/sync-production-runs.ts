import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductionOrdersList } from "@/cin7/production-orders";
import { fetchProductionOrderRun, pickLatestRun, actualOutputQty } from "@/cin7/production-order-run";
import { deriveCurrentOperation, latestStartedOperation, computeWipCost, totalWastage } from "@/reports/production-tracking/build";
import type { Cin7Credentials } from "@/cin7/types";

// Rate-limited detail fetch is one Cin7 call per order — capped per run so a
// large open-order count spreads across several sync runs instead of one
// timing out (Vercel's maxDuration; see api/sync-production-runs/route.ts),
// same reasoning as assembly builds/sales/purchases.
const DETAIL_FETCH_BATCH_SIZE = 50;

// An open order gets requeued by Phase 1 on every list-sync pass (unlike
// assembly builds' one-shot detail fetch, since an in-progress order's
// current stage keeps changing) — this bounds how often Phase 2 actually
// re-fetches the same order's run detail, so an order that hasn't moved
// between ticks isn't re-polled every single 15-minute cron run.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export interface ProductionRunsSyncSummary {
  instanceId: string;
  listSynced: number;
  detailSynced: number;
  detailFailed: number;
  errors: { productionOrderId: string; error: string }[];
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * Phase 1: pulls /production/orderList (already used for costing) for
 * every Manufacture Order (Type "O") on the instance, regardless of
 * status — unlike assembly builds (COMPLETED only), a late order that
 * never started still needs to show as late, so it can't be filtered out
 * here. Upserts header rows; run-derived columns (run_status,
 * current_operation_name, wip_actual_cost, etc.) are deliberately not
 * included in this payload, so this pass never clobbers what Phase 2 has
 * already computed for them.
 */
async function syncProductionOrdersList(db: SupabaseClient, orgId: string, instanceId: string, creds: Cin7Credentials): Promise<number> {
  const orders = await fetchAllProductionOrdersList(creds);
  const typeO = orders.filter((o) => o.Type === "O" && o.ProductionOrderID && o.OrderNumber);
  if (!typeO.length) return 0;

  const rows = typeO.map((o) => ({
    org_id: orgId,
    instance_id: instanceId,
    cin7_production_order_id: o.ProductionOrderID!,
    order_number: o.OrderNumber ?? null,
    product_sku: o.ProductSku ?? null,
    product_name: o.ProductName ?? null,
    location_name: o.LocationName ?? null,
    list_status: o.Status ?? null,
    required_by_date: toDateOnly(o.RequiredByDate),
    completion_date: toDateOnly(o.CompletionDate),
    tags: o.Tags ?? null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db.from("production_orders").upsert(rows, { onConflict: "org_id,instance_id,cin7_production_order_id" });
  if (error) throw new Error(`production_orders upsert: ${error.message}`);

  return typeO.length;
}

/**
 * Phase 2: re-fetches /production/order/run for open orders (list_status
 * not COMPLETED/VOIDED) whose run detail is missing or older than
 * REFRESH_INTERVAL_MS, capped at DETAIL_FETCH_BATCH_SIZE per run. Takes
 * the highest-Number Run (the latest one — an order restarting a Run is
 * rare and out of scope), computes current stage/WIP cost/wastage via
 * build.ts, replaces (delete + reinsert) that order's production_operations
 * rows wholesale, and updates the header.
 */
async function syncProductionOrderRunDetails(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials,
  force = false
): Promise<{ synced: number; failed: number; errors: { productionOrderId: string; error: string }[] }> {
  let pendingQuery = db
    .from("production_orders")
    .select("cin7_production_order_id")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .neq("list_status", "COMPLETED")
    .neq("list_status", "VOIDED");
  // force = true is the user-initiated "Sync now" click, not the automated
  // cron sweep — a human pacing their own clicks won't hammer Cin7's 60/min
  // account-wide limit the way an unthrottled automated loop could, so it's
  // safe to skip the freshness gate and always re-fetch every open order.
  if (!force) {
    const cutoffIso = new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString();
    pendingQuery = pendingQuery.or(`run_synced_at.is.null,run_synced_at.lt.${cutoffIso}`);
  }
  const { data: pending } = await pendingQuery.order("run_synced_at", { ascending: true, nullsFirst: true }).limit(DETAIL_FETCH_BATCH_SIZE);

  let synced = 0;
  const errors: { productionOrderId: string; error: string }[] = [];

  for (const row of (pending ?? []) as { cin7_production_order_id: string }[]) {
    const productionOrderId = row.cin7_production_order_id;
    try {
      const runs = await fetchProductionOrderRun(creds, productionOrderId);
      const latestRun = pickLatestRun(runs);

      const { error: deleteError } = await db
        .from("production_operations")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_production_order_id", productionOrderId);
      if (deleteError) throw new Error(`production_operations delete: ${deleteError.message}`);

      if (latestRun) {
        const operationRows = latestRun.operations.map((op) => {
          // null means "not tracked for this stage" (BOM doesn't define Cin7's
          // Inputs and Outputs feature for this operation) — distinct from 0
          // ("configured, genuinely zero"). Most BOMs won't have these at all
          // (help.core.cin7.com/hc/en-us/articles/9034587837839: "not necessary
          // to include input/output in a Production BOM").
          const hasInput = op.inputProducts.length > 0;
          const hasOutput = op.outputProducts.length > 0;
          return {
            org_id: orgId,
            instance_id: instanceId,
            cin7_production_order_id: productionOrderId,
            operation_order: op.order,
            operation_name: op.name,
            work_center_name: op.workCenterName,
            status: op.status,
            planned_time: op.plannedTime,
            actual_time: op.actualTime,
            start_date: op.startDate,
            end_date: op.endDate,
            actual_resource_cost: op.resourceCosts.reduce((sum, rc) => sum + rc.cost, 0),
            actual_material_cost: op.components.reduce((sum, c) => sum + c.quantity * c.unitCost, 0),
            wastage_qty: totalWastage([op]),
            input_expected_qty: hasInput ? op.inputProducts.reduce((sum, p) => sum + p.expectedQuantity, 0) : null,
            input_actual_qty: hasInput ? op.inputProducts.reduce((sum, p) => sum + p.outputQuantity, 0) : null,
            input_wastage_qty: hasInput ? op.inputProducts.reduce((sum, p) => sum + p.wastageQuantity, 0) : null,
            output_qty: hasOutput ? op.outputProducts.reduce((sum, p) => sum + p.outputQuantity, 0) : null,
            output_wastage_qty: hasOutput ? op.outputProducts.reduce((sum, p) => sum + p.wastageQuantity, 0) : null,
          };
        });
        if (operationRows.length) {
          const { error: insertError } = await db.from("production_operations").insert(operationRows);
          if (insertError) throw new Error(`production_operations insert: ${insertError.message}`);
        }

        const current = deriveCurrentOperation(latestRun.operations);
        // The shortfall/overproduction alert fields deliberately read from
        // latestStartedOperation, NOT `current` — deriveCurrentOperation
        // goes null once every operation is COMPLETED (nothing left to
        // work on), which would silently clear a real, unresolved WIP
        // shortfall from the Kanban card the moment the order finishes,
        // reading as "resolved" when the material loss never actually
        // was. latestStartedOperation stays pointed at the last operation
        // that ran even after it completes. current_operation_name/
        // current_work_center_name/current_operation_order stay on
        // `current` on purpose — those drive groupByWorkCentre's "Awaiting
        // output" bucketing, which needs them to go null once finished.
        const latestStarted = latestStartedOperation(latestRun.operations);
        const latestStartedHasInput = (latestStarted?.inputProducts.length ?? 0) > 0;
        const { error: updateError } = await db
          .from("production_orders")
          .update({
            run_status: latestRun.status,
            wip_account: latestRun.wipAccount,
            current_operation_name: current?.name ?? null,
            current_work_center_name: current?.workCenterName ?? null,
            current_operation_order: current?.order ?? null,
            current_operation_started_at: latestStarted?.startDate ?? null,
            current_input_expected_qty: latestStartedHasInput ? latestStarted!.inputProducts.reduce((sum, p) => sum + p.expectedQuantity, 0) : null,
            current_input_actual_qty: latestStartedHasInput ? latestStarted!.inputProducts.reduce((sum, p) => sum + p.outputQuantity, 0) : null,
            current_input_wastage_qty: latestStartedHasInput ? latestStarted!.inputProducts.reduce((sum, p) => sum + p.wastageQuantity, 0) : null,
            // Sourced from the Run's own Output[] (see actualOutputQty's
            // comment) — confirmed live 2026-07-15 (MO-00042) to match
            // Cin7's own "Actually Produced" figure exactly. An operation's
            // FinishedProducts.outputQuantity was tried first and confirmed
            // unreliable (silently duplicated the wastage figure instead).
            actual_output_qty: actualOutputQty(latestRun),
            planned_quantity: latestRun.quantity,
            wip_actual_cost: computeWipCost(runs),
            run_synced_at: new Date().toISOString(),
          })
          .eq("org_id", orgId)
          .eq("instance_id", instanceId)
          .eq("cin7_production_order_id", productionOrderId);
        if (updateError) throw new Error(`production_orders update: ${updateError.message}`);
      } else {
        // No Run yet (order never released) — still mark as attempted so it doesn't get re-fetched every single tick.
        const { error: updateError } = await db
          .from("production_orders")
          .update({ run_synced_at: new Date().toISOString() })
          .eq("org_id", orgId)
          .eq("instance_id", instanceId)
          .eq("cin7_production_order_id", productionOrderId);
        if (updateError) throw new Error(`production_orders update: ${updateError.message}`);
      }

      synced++;
    } catch (e) {
      errors.push({ productionOrderId, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return { synced, failed: errors.length, errors };
}

/** Runs both sync phases for one instance. `force` skips Phase 2's 15-minute freshness gate — see syncProductionOrderRunDetails. */
export async function syncInstanceProductionRuns(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  force = false
): Promise<ProductionRunsSyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const listSynced = await syncProductionOrdersList(db, orgId, instanceId, creds);
  const { synced, failed, errors } = await syncProductionOrderRunDetails(db, orgId, instanceId, creds, force);
  return { instanceId, listSynced, detailSynced: synced, detailFailed: failed, errors };
}

/**
 * Syncs production order/run tracking for active instances — every one
 * for the org, or just the given subset — mirroring sync-assembly-builds.ts's
 * shape. Per-instance failures are caught so one bad instance doesn't stop
 * others.
 */
export async function syncOrgProductionRuns(
  db: SupabaseClient,
  orgId?: string,
  instanceIds?: string[],
  force = false
): Promise<ProductionRunsSyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results: ProductionRunsSyncSummary[] = [];
  for (const instance of (instances ?? []) as { id: string; org_id: string }[]) {
    try {
      results.push(await syncInstanceProductionRuns(db, instance.org_id, instance.id, force));
    } catch (e) {
      results.push({
        instanceId: instance.id,
        listSynced: 0,
        detailSynced: 0,
        detailFailed: 0,
        errors: [{ productionOrderId: "-", error: e instanceof Error ? e.message : "Unknown error" }],
      });
    }
  }
  return results;
}
