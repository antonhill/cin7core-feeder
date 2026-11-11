import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildPoQuantityRows,
  type SyncFailureMap,
  summariseInstanceSync,
  type InstanceSyncSummary,
  type OrderLineInput,
  type PoQuantityRow,
  type PurchaseHeader,
  type ReceiptLineInput,
} from "@/reports/po-quantity-comparison";

export interface PoQuantityFilters {
  instanceIds?: string[];
  /** "YYYY-MM-DD" inclusive; POs with no order date are excluded when either bound is set (and counted). */
  dateFrom?: string;
  dateTo?: string;
}

export interface PoQuantityReport {
  rows: PoQuantityRow[];
  sync: InstanceSyncSummary[];
  /** POs dropped from the result only because they have no order date and a date filter was set. */
  excludedNoOrderDate: number;
}

const PAGE = 1000;
const PO_ID_CHUNK = 100;

type PagedQuery<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** PostgREST caps responses (1000 rows by default) — pages until a short page so a large cache is never silently truncated. */
async function fetchAllPages<T>(label: string, run: PagedQuery<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Read-only Purchase Order Quantity Comparison. Every query is scoped by
 * `org_id` AND the org's own instance ids (requested ids that don't belong to
 * the org simply match nothing), so one tenant/instance can never see
 * another's rows even though this runs on the service-role client.
 */
export async function getPoQuantityReport(db: SupabaseClient, orgId: string, filters: PoQuantityFilters): Promise<PoQuantityReport> {
  const instRes = await db.from("cin7_instances").select("id, name").eq("org_id", orgId).order("name");
  if (instRes.error) throw new Error(`cin7_instances: ${instRes.error.message}`);
  const orgInstances = (instRes.data ?? []) as { id: string; name: string }[];
  const instanceNames = Object.fromEntries(orgInstances.map((i) => [i.id, i.name]));
  const orgInstanceIds = new Set(orgInstances.map((i) => i.id));
  const requested = filters.instanceIds?.length ? filters.instanceIds : [...orgInstanceIds];
  const instanceIds = requested.filter((id) => orgInstanceIds.has(id));
  if (instanceIds.length === 0) return { rows: [], sync: [], excludedNoOrderDate: 0 };

  const allPurchases = await fetchAllPages<PurchaseHeader>("purchases", (from, to) =>
    db
      .from("purchases")
      .select(
        "instance_id, cin7_purchase_id, order_number, supplier_name, status, combined_receiving_status, order_date, is_drop_ship, detail_synced_at, created_at, updated_at"
      )
      .eq("org_id", orgId)
      .in("instance_id", instanceIds)
      .order("instance_id")
      .order("cin7_purchase_id")
      .range(from, to)
  );

  const stateRes = await db.from("purchases_sync_state").select("instance_id, last_list_synced_at").eq("org_id", orgId).in("instance_id", instanceIds);
  if (stateRes.error) throw new Error(`purchases_sync_state: ${stateRes.error.message}`);
  const listSyncedAt = Object.fromEntries(
    ((stateRes.data ?? []) as { instance_id: string; last_list_synced_at: string | null }[]).map((r) => [r.instance_id, r.last_list_synced_at])
  );

  const sync = summariseInstanceSync({ purchases: allPurchases, listSyncedAt, instanceNames, instanceIds });

  const dateFiltered = Boolean(filters.dateFrom || filters.dateTo);
  let excludedNoOrderDate = 0;
  const purchases = allPurchases.filter((p) => {
    if (!dateFiltered) return true;
    if (!p.order_date) {
      excludedNoOrderDate += 1;
      return false;
    }
    if (filters.dateFrom && p.order_date < filters.dateFrom) return false;
    if (filters.dateTo && p.order_date > filters.dateTo) return false;
    return true;
  });

  // Only POs whose detail has synced contribute lines; the rest are shown as incomplete placeholders.
  const syncedIds = purchases.filter((p) => p.detail_synced_at).map((p) => p.cin7_purchase_id);
  const orderLines: OrderLineInput[] = [];
  const receiptLines: ReceiptLineInput[] = [];
  for (const ids of chunk(syncedIds, PO_ID_CHUNK)) {
    const [o, r] = await Promise.all([
      fetchAllPages<OrderLineInput>("purchase_order_lines", (from, to) =>
        db
          .from("purchase_order_lines")
          .select("instance_id, cin7_purchase_id, product_sku, product_name, quantity")
          .eq("org_id", orgId)
          .in("instance_id", instanceIds)
          .in("cin7_purchase_id", ids)
          .order("cin7_purchase_id")
          .order("line_number")
          .range(from, to)
      ),
      fetchAllPages<ReceiptLineInput>("purchase_receipt_lines", (from, to) =>
        db
          .from("purchase_receipt_lines")
          .select("instance_id, cin7_purchase_id, product_sku, product_name, quantity")
          .eq("org_id", orgId)
          .in("instance_id", instanceIds)
          .in("cin7_purchase_id", ids)
          .order("cin7_purchase_id")
          .order("card_id")
          .order("product_sku")
          .range(from, to)
      ),
    ]);
    orderLines.push(...o);
    receiptLines.push(...r);
  }

  // Persisted failed-detail-sync diagnostics (written by the purchase sync) — lets an unsynced PO show WHY.
  const syncFailures: SyncFailureMap = {};
  const incompleteIds = new Set(purchases.filter((p) => !p.detail_synced_at).map((p) => `${p.instance_id}|${p.cin7_purchase_id}`));
  if (incompleteIds.size > 0) {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const failRes = await db
      .from("activity_log")
      .select("instance_id, created_at, detail")
      .eq("org_id", orgId)
      .in("instance_id", instanceIds)
      .eq("action", "diagnostic.purchase_detail_sync_failed")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1000);
    // A missing/failed diagnostics read must never break the report — the PO still shows as Incomplete.
    if (!failRes.error) {
      for (const r of (failRes.data ?? []) as { instance_id: string; created_at: string; detail: { purchase_id?: string; message?: string } | null }[]) {
        const pid = r.detail?.purchase_id;
        if (!pid) continue;
        const key = `${r.instance_id}|${pid}`;
        if (incompleteIds.has(key) && !syncFailures[key]) syncFailures[key] = { at: r.created_at, message: String(r.detail?.message ?? "").slice(0, 240) };
      }
    }
  }

  return { rows: buildPoQuantityRows({ purchases, orderLines, receiptLines, instanceNames, syncFailures }), sync, excludedNoOrderDate };
}
