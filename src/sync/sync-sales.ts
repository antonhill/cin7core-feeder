import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllSalesList, fetchSaleDetail, type Cin7SaleFulfilment } from "@/cin7/sales";
import { fetchAllCategories } from "@/cin7/categories";
import type { Cin7Credentials } from "@/cin7/types";

const DEFAULT_BACKFILL_MONTHS = 12;
// Rate-limited detail fetch is one Cin7 call per sale — capped per run so a
// large backfill spreads across several sync runs instead of one timing out
// (Vercel's maxDuration; see api/sync-sales/route.ts).
const DETAIL_FETCH_BATCH_SIZE = 50;

export interface SalesSyncSummary {
  instanceId: string;
  listSynced: number;
  detailSynced: number;
  detailFailed: number;
  errors: { saleId: string; error: string }[];
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/** Cin7's date fields come as "2017-09-28T00:00:00" — trimmed to a plain date for range filtering. */
function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * Flattens the actually-picked/packed quantities across every Fulfilments[]
 * entry on a sale (confirmed live: a sale can have more than one, e.g. split
 * picks) into two independently-numbered line sequences — what matters for
 * "already picked" is the sum per SKU across the whole sale's fulfillment
 * history, not which specific fulfilment record a line came from.
 */
function extractPickPackLineRows(orgId: string, instanceId: string, saleId: string, fulfilments: Cin7SaleFulfilment[]) {
  const rows: {
    org_id: string;
    instance_id: string;
    cin7_sale_id: string;
    stage: "pick" | "pack";
    line_number: number;
    product_sku: string | null;
    product_name: string | null;
    quantity: number | null;
    location: string | null;
    batch_sn: string | null;
  }[] = [];

  let pickLineNumber = 0;
  let packLineNumber = 0;
  for (const fulfilment of fulfilments) {
    for (const line of fulfilment.Pick?.Lines ?? []) {
      rows.push({
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: saleId,
        stage: "pick",
        line_number: pickLineNumber++,
        product_sku: line.SKU ?? null,
        product_name: line.Name ?? null,
        quantity: line.Quantity ?? null,
        location: line.Location ?? null,
        batch_sn: line.BatchSN ?? null,
      });
    }
    for (const line of fulfilment.Pack?.Lines ?? []) {
      rows.push({
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: saleId,
        stage: "pack",
        line_number: packLineNumber++,
        product_sku: line.SKU ?? null,
        product_name: line.Name ?? null,
        quantity: line.Quantity ?? null,
        location: line.Location ?? null,
        batch_sn: line.BatchSN ?? null,
      });
    }
  }
  return rows;
}

/**
 * Phase 1: pulls /saleList (cheap, paginated) for every sale changed since
 * this instance's last synced watermark — the last `DEFAULT_BACKFILL_MONTHS`
 * months on first run (Anton confirmed 2026-07-06: a bounded initial
 * backfill, not full history, given the per-sale cost of phase 2 below).
 * Fetches every sale regardless of invoice status (not just invoiced ones)
 * — the Order Fulfillment Dashboard's whole point is seeing orders BEFORE
 * they're invoiced (ready to pick, partially picked), unlike the older
 * invoiced-only scope this used when only the revenue report needed it.
 * Upserts sale headers; a sale that's new or whose Cin7 `Updated` timestamp
 * changed is queued for phase 2 by clearing detail_synced_at — an unchanged
 * sale keeps whatever it already had.
 */
async function syncSalesList(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials
): Promise<number> {
  const { data: state } = await db
    .from("sales_sync_state")
    .select("last_list_synced_at")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .maybeSingle();

  const updatedSince: string = state?.last_list_synced_at ?? monthsAgoIso(DEFAULT_BACKFILL_MONTHS);
  // Captured before any calls, so a sale updated mid-run isn't missed by the next run's UpdatedSince.
  const syncStartedAt = new Date().toISOString();

  const entries = await fetchAllSalesList(creds, updatedSince);

  if (entries.length) {
    const ids = entries.map((e) => e.SaleID);
    const { data: existingRows } = await db
      .from("sales")
      .select("cin7_sale_id, cin7_updated_at, detail_synced_at")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .in("cin7_sale_id", ids);
    const existingByCin7Id = new Map(
      (existingRows ?? []).map((r: { cin7_sale_id: string; cin7_updated_at: string | null; detail_synced_at: string | null }) => [
        r.cin7_sale_id,
        r,
      ])
    );

    const rows = entries.map((e) => {
      const prior = existingByCin7Id.get(e.SaleID);
      const changed = !prior || prior.cin7_updated_at !== (e.Updated ?? null);
      return {
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: e.SaleID,
        order_number: e.OrderNumber ?? null,
        order_date: toDateOnly(e.OrderDate),
        invoice_number: e.InvoiceNumber ?? null,
        invoice_date: toDateOnly(e.InvoiceDate),
        customer_name: e.Customer ?? null,
        status: e.CombinedInvoiceStatus ?? e.Status ?? null,
        currency: e.CustomerCurrency ?? null,
        cin7_updated_at: e.Updated ?? null,
        order_status: e.OrderStatus ?? null,
        combined_invoice_status: e.CombinedInvoiceStatus ?? null,
        combined_picking_status: e.CombinedPickingStatus ?? null,
        combined_packing_status: e.CombinedPackingStatus ?? null,
        combined_shipping_status: e.CombinedShippingStatus ?? null,
        combined_payment_status: e.CombinedPaymentStatus ?? null,
        fulfilment_status: e.FulFilmentStatus ?? null,
        ship_by: toDateOnly(e.ShipBy),
        carrier: e.Carrier ?? null,
        tracking_numbers: e.CombinedTrackingNumbers ?? null,
        paid_amount: e.PaidAmount ?? null,
        invoice_amount: e.SaleInvoicesTotalAmount ?? null,
        detail_synced_at: changed ? null : (prior?.detail_synced_at ?? null),
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await db.from("sales").upsert(rows, { onConflict: "org_id,instance_id,cin7_sale_id" });
    if (error) throw new Error(`sales upsert: ${error.message}`);
  }

  const { error: stateError } = await db
    .from("sales_sync_state")
    .upsert({ org_id: orgId, instance_id: instanceId, last_list_synced_at: syncStartedAt }, { onConflict: "org_id,instance_id" });
  if (stateError) throw new Error(`sales_sync_state upsert: ${stateError.message}`);

  return entries.length;
}

/**
 * Phase 2: for sales queued by phase 1 (detail_synced_at is null), fetches
 * full line-item detail one at a time — rate-limited by the shared
 * cin7Request throttle — capped at DETAIL_FETCH_BATCH_SIZE per run. Replaces
 * (delete + reinsert) a sale's lines wholesale on each (re-)fetch rather
 * than diffing, since a re-synced sale's line count/order can genuinely
 * change (e.g. an amended invoice) and there's no cheaper way to reconcile
 * that against the natural key (invoice_number, line_number).
 */
async function syncSaleDetails(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials
): Promise<{ synced: number; failed: number; errors: { saleId: string; error: string }[] }> {
  const { data: pending } = await db
    .from("sales")
    .select("cin7_sale_id")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .is("detail_synced_at", null)
    .order("invoice_date", { ascending: false })
    .limit(DETAIL_FETCH_BATCH_SIZE);

  let synced = 0;
  const errors: { saleId: string; error: string }[] = [];

  for (const row of (pending ?? []) as { cin7_sale_id: string }[]) {
    try {
      const detail = await fetchSaleDetail(creds, row.cin7_sale_id);

      const { error: deleteError } = await db
        .from("sale_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_sale_id", row.cin7_sale_id);
      if (deleteError) throw new Error(`sale_lines delete: ${deleteError.message}`);

      const lineRows = (detail.Invoices ?? []).flatMap((invoice) =>
        (invoice.Lines ?? []).map((line, i) => ({
          org_id: orgId,
          instance_id: instanceId,
          cin7_sale_id: row.cin7_sale_id,
          invoice_number: invoice.InvoiceNumber ?? "",
          line_number: i,
          invoice_date: toDateOnly(invoice.InvoiceDate),
          product_sku: line.SKU ?? null,
          product_name: line.Name ?? null,
          quantity: line.Quantity ?? null,
          price: line.Price ?? null,
          discount: line.Discount ?? null,
          tax: line.Tax ?? null,
          total: line.Total ?? null,
          average_cost: line.AverageCost ?? null,
        }))
      );
      if (lineRows.length) {
        const { error: insertError } = await db.from("sale_lines").insert(lineRows);
        if (insertError) throw new Error(`sale_lines insert: ${insertError.message}`);
      }

      const { error: orderLinesDeleteError } = await db
        .from("sale_order_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_sale_id", row.cin7_sale_id);
      if (orderLinesDeleteError) throw new Error(`sale_order_lines delete: ${orderLinesDeleteError.message}`);

      const orderLineRows = (detail.Order?.Lines ?? []).map((line, i) => ({
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: row.cin7_sale_id,
        line_number: i,
        product_sku: line.SKU ?? null,
        product_name: line.Name ?? null,
        quantity: line.Quantity ?? null,
        backorder_quantity: line.BackorderQuantity ?? null,
      }));
      if (orderLineRows.length) {
        const { error: orderLinesInsertError } = await db.from("sale_order_lines").insert(orderLineRows);
        if (orderLinesInsertError) throw new Error(`sale_order_lines insert: ${orderLinesInsertError.message}`);
      }

      const { error: pickPackDeleteError } = await db
        .from("sale_pick_pack_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_sale_id", row.cin7_sale_id);
      if (pickPackDeleteError) throw new Error(`sale_pick_pack_lines delete: ${pickPackDeleteError.message}`);

      const pickPackRows = extractPickPackLineRows(orgId, instanceId, row.cin7_sale_id, detail.Fulfilments ?? []);
      if (pickPackRows.length) {
        const { error: pickPackInsertError } = await db.from("sale_pick_pack_lines").insert(pickPackRows);
        if (pickPackInsertError) throw new Error(`sale_pick_pack_lines insert: ${pickPackInsertError.message}`);
      }

      const { error: updateError } = await db
        .from("sales")
        .update({ location: detail.Location ?? null, customer_reference: detail.CustomerReference ?? null, detail_synced_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_sale_id", row.cin7_sale_id);
      if (updateError) throw new Error(`sales update: ${updateError.message}`);

      synced++;
    } catch (e) {
      errors.push({ saleId: row.cin7_sale_id, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return { synced, failed: errors.length, errors };
}

/**
 * Cin7's own categories (`GET /ref/category`, ID + Name — no "code" of its
 * own) have never been pulled into this app before; `categories` was
 * populated only incidentally, from whatever a product CSV import happened
 * to mention. Upserts by `code = Name` (Anton, 2026-07-11: merge same-named
 * categories across instances into one org-wide row rather than adding
 * instance_id to `categories` itself — two different Cin7 accounts having
 * their own separate "Accessories" is an edge case worth accepting for the
 * simpler shape). ALSO records which instance reported it in
 * `category_instances` (0037) — captured here, at the one point this app
 * actually knows it, rather than trying to reconstruct it later from
 * `sale_lines` (only populated once a sale's rate-limited detail sync has
 * finished, which can lag behind by most of an org's sales history — a
 * derivation that unreliable defeated the entire point of scoping by
 * instance). Failures here don't fail the whole sales sync — a
 * category-list hiccup shouldn't block the sales data this run cares about.
 */
async function syncCategories(db: SupabaseClient, orgId: string, instanceId: string, creds: Cin7Credentials): Promise<void> {
  const categories = await fetchAllCategories(creds);
  const names = categories.filter((c) => c.Name).map((c) => c.Name);
  if (!names.length) return;

  const categoryRows = names.map((name) => ({ org_id: orgId, code: name, name }));
  const { error: categoriesError } = await db.from("categories").upsert(categoryRows, { onConflict: "org_id,code" });
  if (categoriesError) throw new Error(`categories: ${categoriesError.message}`);

  const instanceRows = names.map((name) => ({ org_id: orgId, code: name, instance_id: instanceId }));
  const { error: instancesError } = await db.from("category_instances").upsert(instanceRows, { onConflict: "org_id,code,instance_id" });
  if (instancesError) throw new Error(`category_instances: ${instancesError.message}`);
}

/** Runs both sync phases for one instance, plus a lightweight pull of this instance's own category list. */
export async function syncInstanceSales(db: SupabaseClient, orgId: string, instanceId: string): Promise<SalesSyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  try {
    await syncCategories(db, orgId, instanceId, creds);
  } catch {
    // Best-effort — see syncCategories' own comment; the sales sync below is what actually matters for this run.
  }
  const listSynced = await syncSalesList(db, orgId, instanceId, creds);
  const { synced, failed, errors } = await syncSaleDetails(db, orgId, instanceId, creds);
  return { instanceId, listSynced, detailSynced: synced, detailFailed: failed, errors };
}

/**
 * Syncs sales for active instances — every one for the org, or just the
 * given subset — mirroring sync-org.ts's syncOrgInstances shape. Per-instance
 * failures are caught so one bad instance doesn't stop others.
 */
export async function syncOrgSales(db: SupabaseClient, orgId?: string, instanceIds?: string[]): Promise<SalesSyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results: SalesSyncSummary[] = [];
  for (const instance of (instances ?? []) as { id: string; org_id: string }[]) {
    try {
      results.push(await syncInstanceSales(db, instance.org_id, instance.id));
    } catch (e) {
      results.push({
        instanceId: instance.id,
        listSynced: 0,
        detailSynced: 0,
        detailFailed: 0,
        errors: [{ saleId: "-", error: e instanceof Error ? e.message : "Unknown error" }],
      });
    }
  }
  return results;
}
