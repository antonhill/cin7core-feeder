import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllFinishedGoodsList, fetchFinishedGoodsDetail } from "@/cin7/finished-goods";
import type { Cin7Credentials } from "@/cin7/types";

// Rate-limited detail fetch is one Cin7 call per build — capped per run so a
// large backlog spreads across several sync runs instead of one timing out
// (Vercel's maxDuration; see api/sync-assembly-builds/route.ts), same
// reasoning as sales/purchases.
const DETAIL_FETCH_BATCH_SIZE = 50;

export interface AssemblyBuildsSyncSummary {
  instanceId: string;
  listSynced: number;
  detailSynced: number;
  detailFailed: number;
  errors: { taskId: string; error: string }[];
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * Phase 1: pulls /finishedGoodsList (cheap, paginated, already used by the
 * Assemblies report) for every COMPLETED build — only a completed build
 * represents real inventory movement (DRAFT/IN PROGRESS haven't happened
 * yet, VOIDED never will). Like Purchases, there's no confirmed "Updated"
 * watermark field, so this scans the full list each run. A build is queued
 * for phase 2 (detail_synced_at cleared) when it's new, or its Status
 * changed since the last detail fetch (catching e.g. a late VOID).
 */
async function syncAssemblyBuildsList(db: SupabaseClient, orgId: string, instanceId: string, creds: Cin7Credentials): Promise<number> {
  const entries = await fetchAllFinishedGoodsList(creds);
  const completed = entries.filter((e) => e.Status === "COMPLETED");
  if (!completed.length) return 0;

  const ids = completed.map((e) => e.TaskID);
  const { data: existingRows } = await db
    .from("assembly_builds")
    .select("cin7_task_id, status, detail_synced_at")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .in("cin7_task_id", ids);
  const existingByTaskId = new Map(
    (existingRows ?? []).map((r: { cin7_task_id: string; status: string | null; detail_synced_at: string | null }) => [r.cin7_task_id, r])
  );

  const rows = completed.map((e) => {
    const prior = existingByTaskId.get(e.TaskID);
    const changed = !prior || prior.status !== (e.Status ?? null);
    return {
      org_id: orgId,
      instance_id: instanceId,
      cin7_task_id: e.TaskID,
      assembly_number: e.AssemblyNumber ?? null,
      product_sku: e.ProductCode ?? null,
      product_name: e.ProductName ?? null,
      status: e.Status ?? null,
      quantity: e.Quantity ?? null,
      completion_date: toDateOnly(e.Date),
      detail_synced_at: changed ? null : (prior?.detail_synced_at ?? null),
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await db.from("assembly_builds").upsert(rows, { onConflict: "org_id,instance_id,cin7_task_id" });
  if (error) throw new Error(`assembly_builds upsert: ${error.message}`);

  return completed.length;
}

/**
 * Phase 2: for builds queued by phase 1, fetches full detail (rate-limited,
 * capped at DETAIL_FETCH_BATCH_SIZE per run) to get the authoritative
 * completion_date and the actual consumed components (PickLines — real
 * as-built consumption, not the BOM's planned OrderLines). Replaces
 * (delete + reinsert) a build's consumption lines wholesale on each
 * (re-)fetch, same convention as sale_lines/purchase_receipt_lines.
 */
async function syncAssemblyBuildDetails(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials
): Promise<{ synced: number; failed: number; errors: { taskId: string; error: string }[] }> {
  const { data: pending } = await db
    .from("assembly_builds")
    .select("cin7_task_id")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .is("detail_synced_at", null)
    .order("completion_date", { ascending: false })
    .limit(DETAIL_FETCH_BATCH_SIZE);

  let synced = 0;
  const errors: { taskId: string; error: string }[] = [];

  for (const row of (pending ?? []) as { cin7_task_id: string }[]) {
    try {
      const detail = await fetchFinishedGoodsDetail(creds, row.cin7_task_id);

      const { error: deleteError } = await db
        .from("assembly_consumption_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_task_id", row.cin7_task_id);
      if (deleteError) throw new Error(`assembly_consumption_lines delete: ${deleteError.message}`);

      const lineRows = (detail.PickLines ?? []).map((line, i) => ({
        org_id: orgId,
        instance_id: instanceId,
        cin7_task_id: row.cin7_task_id,
        line_number: i,
        product_sku: line.ProductCode ?? null,
        product_name: line.Name ?? null,
        quantity: line.Quantity ?? null,
        unit_cost: line.Cost ?? null,
        batch_sn: line.BatchSN ?? null,
      }));
      if (lineRows.length) {
        const { error: insertError } = await db.from("assembly_consumption_lines").insert(lineRows);
        if (insertError) throw new Error(`assembly_consumption_lines insert: ${insertError.message}`);
      }

      const { error: updateError } = await db
        .from("assembly_builds")
        .update({ completion_date: toDateOnly(detail.CompletionDate), detail_synced_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_task_id", row.cin7_task_id);
      if (updateError) throw new Error(`assembly_builds update: ${updateError.message}`);

      synced++;
    } catch (e) {
      errors.push({ taskId: row.cin7_task_id, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return { synced, failed: errors.length, errors };
}

/** Runs both sync phases for one instance. */
export async function syncInstanceAssemblyBuilds(db: SupabaseClient, orgId: string, instanceId: string): Promise<AssemblyBuildsSyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const listSynced = await syncAssemblyBuildsList(db, orgId, instanceId, creds);
  const { synced, failed, errors } = await syncAssemblyBuildDetails(db, orgId, instanceId, creds);
  return { instanceId, listSynced, detailSynced: synced, detailFailed: failed, errors };
}

/**
 * Syncs assembly build movement for active instances — every one for the
 * org, or just the given subset — mirroring sync-purchases.ts's shape.
 * Per-instance failures are caught so one bad instance doesn't stop others.
 */
export async function syncOrgAssemblyBuilds(db: SupabaseClient, orgId?: string, instanceIds?: string[]): Promise<AssemblyBuildsSyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results: AssemblyBuildsSyncSummary[] = [];
  for (const instance of (instances ?? []) as { id: string; org_id: string }[]) {
    try {
      results.push(await syncInstanceAssemblyBuilds(db, instance.org_id, instance.id));
    } catch (e) {
      results.push({
        instanceId: instance.id,
        listSynced: 0,
        detailSynced: 0,
        detailFailed: 0,
        errors: [{ taskId: "-", error: e instanceof Error ? e.message : "Unknown error" }],
      });
    }
  }
  return results;
}
