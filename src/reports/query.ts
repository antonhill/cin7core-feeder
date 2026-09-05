import type { SupabaseClient } from "@supabase/supabase-js";
import type { PivotGroupBy, PivotSourceRow } from "@/reports/pivot";
import type { InstancePickerItem } from "@/actions/instances";

const RPC_PAGE_SIZE = 1000;

/**
 * PostgREST caps any single response at its configured max-rows (1000 on
 * this project) regardless of how many rows the underlying function
 * actually returns — confirmed live 2026-08-04: Order Fulfillment's "All
 * Orders" count was silently stuck at exactly 1000 while the DB itself had
 * 9,915 orders, and none of the org's 32 real Pick Today orders happened to
 * fall in that arbitrary first slice. `.rpc()` needs explicit `.range()`
 * paging to get every row back; without it, this fails silently (no error,
 * just a truncated result) rather than throwing.
 */
// Security re-audit P1-7: this is the one report function in this file that
// deliberately pages PAST PostgREST's own implicit max-rows cap (see this
// function's own comment above) — every other `.rpc()` call in this file is
// accidentally bounded by that same 1000-row cap, but this one is genuinely
// unbounded without its own explicit ceiling. Order Fulfillment's own
// confirmed live scale was 9,915 orders for one instance when 25,000 was
// picked (~2.5x headroom on the ORDER count) — but the same cap also bounds
// report_order_fulfillment_LINES (per-SKU, several lines per order), and
// LBL's real growth hit that first: confirmed live 2026-08-18, "Lights by
// Linea" alone was at 28,365 line rows, already over the old cap, on 10,297
// orders. Rebased on that actual worst-observed number with the same ~2.5x
// multiplier (28,365 × 2.5 ≈ 70,900) rather than the order-count figure that
// undersized it. Paired with default date-range scoping on Order
// Fulfillment's own fetch (see OrderFulfillmentFilters.fromDate) so this
// ceiling is a backstop, not the primary defense against unbounded growth.
const MAX_RPC_ROWS = 75_000;

async function fetchAllRpcRows<T>(db: SupabaseClient, fn: string, params: Record<string, unknown>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += RPC_PAGE_SIZE) {
    const { data, error } = await db.rpc(fn, params).range(from, from + RPC_PAGE_SIZE - 1);
    if (error) throw new Error(`${fn}: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (all.length > MAX_RPC_ROWS) {
      throw new Error(`This report matched over ${MAX_RPC_ROWS.toLocaleString()} rows — narrow your filters (date range, instance selection) and try again.`);
    }
    if (rows.length < RPC_PAGE_SIZE) break;
  }
  return all;
}

export interface SalesReportFilters {
  instanceIds?: string[];
  location?: string;
  categoryCode?: string;
  /** "YYYY-MM-DD" — inclusive. */
  dateFrom?: string;
  dateTo?: string;
}

export interface ProductSalesReportRow {
  product_sku: string;
  product_name: string | null;
  category_code: string | null;
  quantity_sold: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin_percent: number | null;
}

/** Revenue/COGS/profit/margin% per product sold, aggregated in Postgres (report_sales_by_product) so sale_lines' group-by/sum work stays server-side as it grows. */
export async function getProductSalesReport(
  db: SupabaseClient,
  orgId: string,
  filters: SalesReportFilters
): Promise<ProductSalesReportRow[]> {
  const { data, error } = await db.rpc("report_sales_by_product", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_location: filters.location || null,
    p_category_code: filters.categoryCode || null,
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
  });
  if (error) throw new Error(`report_sales_by_product: ${error.message}`);
  return data ?? [];
}

/**
 * Same filters and metrics as getProductSalesReport, but grouped down to
 * (product, location?, category?) via report_sales_pivot (0020) so the app
 * can pivot Location and/or Category into columns — see reports/pivot.ts for
 * how this flat list turns into a grid.
 */
export async function getProductSalesPivotData(
  db: SupabaseClient,
  orgId: string,
  filters: SalesReportFilters,
  groupBy: PivotGroupBy
): Promise<PivotSourceRow[]> {
  const { data, error } = await db.rpc("report_sales_pivot", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_location: filters.location || null,
    p_category_code: filters.categoryCode || null,
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
    p_group_by_location: groupBy === "location" || groupBy === "both",
    p_group_by_category: groupBy === "category" || groupBy === "both",
  });
  if (error) throw new Error(`report_sales_pivot: ${error.message}`);
  return data ?? [];
}

export interface SaleLineDetailRow {
  invoiceNumber: string;
  invoiceDate: string | null;
  productSku: string | null;
  productName: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
  averageCost: number | null;
  instanceId: string;
  location: string | null;
  customerName: string | null;
}

interface RawSaleLineRow {
  invoice_number: string;
  invoice_date: string | null;
  product_sku: string | null;
  product_name: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
  average_cost: number | null;
  instance_id: string;
  sales: { location: string | null; customer_name: string | null } | null;
}

/**
 * Flat invoice-line rows matching the same filters, optionally narrowed to
 * one product — the drill-down behind the aggregated report (invoice
 * number/date, quantity, price, cost per line). No category filter here:
 * once a report row is expanded the product is already known, so a
 * products join just to re-filter by category would be redundant.
 */
export async function getSaleLineDetails(
  db: SupabaseClient,
  orgId: string,
  filters: SalesReportFilters & { productSku?: string }
): Promise<SaleLineDetailRow[]> {
  let query = db
    .from("sale_lines")
    .select(
      "invoice_number, invoice_date, product_sku, product_name, quantity, price, total, average_cost, instance_id, sales!inner(location, customer_name)"
    )
    .eq("org_id", orgId);

  if (filters.instanceIds?.length) query = query.in("instance_id", filters.instanceIds);
  if (filters.productSku) query = query.eq("product_sku", filters.productSku);
  if (filters.dateFrom) query = query.gte("invoice_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("invoice_date", filters.dateTo);
  if (filters.location) query = query.eq("sales.location", filters.location);

  const { data, error } = await query.order("invoice_date", { ascending: false });
  if (error) throw new Error(`sale_lines: ${error.message}`);

  return ((data ?? []) as unknown as RawSaleLineRow[]).map((row) => ({
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    productSku: row.product_sku,
    productName: row.product_name,
    quantity: row.quantity,
    price: row.price,
    total: row.total,
    averageCost: row.average_cost,
    instanceId: row.instance_id,
    location: row.sales?.location ?? null,
    customerName: row.sales?.customer_name ?? null,
  }));
}

export interface ReportFilterOptions {
  /** Reuses the same shape as listInstancesForPicker() — this used to omit `active` entirely, which broke auto-select logic for the fulfillment-cleanup page (the one caller that also uses this as its instance picker). */
  instances: InstancePickerItem[];
  locations: string[];
  categories: { code: string; name: string }[];
}

/**
 * Options for the report's filter dropdowns — every connected instance,
 * plus every distinct location/category actually present among the
 * selected instance(s)' own synced data. `instanceIds` is optional (every
 * caller that only needs `.instances` for its own picker, e.g. Order
 * Fulfillment/Stock Health/Inventory Movement/Custom Reports, can keep
 * omitting it) — only the Sales report surfaces Location/Category
 * dropdowns, so it's the only caller that needs to pass it through.
 *
 * Location comes straight off `sales` (already has `instance_id`), a plain
 * filtered query. Category has no `instance_id` of its own — the
 * `categories` table is a canonical org-wide taxonomy, not per-instance
 * data — so instead of an instance-blind "every category the org has ever
 * defined," this derives categories from products that actually appear in
 * a `sale_line` synced from the selected instance(s) (product_sku →
 * products.category_code → categories), so an ETEC-only view doesn't list
 * categories that only ever showed up in Spark Demo's test data.
 */
export async function getReportFilterOptions(db: SupabaseClient, orgId: string, instanceIds?: string[]): Promise<ReportFilterOptions> {
  const scopedInstanceIds = instanceIds?.length ? instanceIds : null;

  let locationsQuery = db.from("sales").select("location").eq("org_id", orgId).not("location", "is", null);
  if (scopedInstanceIds) locationsQuery = locationsQuery.in("instance_id", scopedInstanceIds);

  const [instancesRes, locationsRes] = await Promise.all([
    db.from("cin7_instances").select("id, name, active").eq("org_id", orgId).order("name"),
    locationsQuery,
  ]);
  if (instancesRes.error) throw new Error(instancesRes.error.message);
  if (locationsRes.error) throw new Error(locationsRes.error.message);

  const locations = [...new Set((locationsRes.data ?? []).map((r: { location: string }) => r.location).filter(Boolean))].sort();
  const categories = await getCategoriesForInstances(db, orgId, scopedInstanceIds);

  return {
    instances: instancesRes.data ?? [],
    locations,
    categories,
  };
}

async function getAllCategories(db: SupabaseClient, orgId: string): Promise<{ code: string; name: string }[]> {
  const categoriesRes = await db.from("categories").select("code, name").eq("org_id", orgId).order("name");
  if (categoriesRes.error) throw new Error(categoriesRes.error.message);
  return categoriesRes.data ?? [];
}

/**
 * Scopes categories via `category_instances` (0037) — recorded directly at
 * sync time (each instance's own `GET /ref/category` call, per
 * src/sync/sync-sales.ts's syncCategories), not derived after the fact from
 * `sale_lines`. An earlier version tried the `sale_lines` derivation
 * (product_sku → products.category_code → categories), but that table only
 * has rows for sales whose line-item detail sync has already finished —
 * rate-limited, and confirmed live 2026-07-11 to lag behind badly enough
 * (most of an org's sales still pending) that the derivation came back
 * empty and fell back to the full org-wide list every time, silently
 * defeating the whole point of scoping by instance.
 */
async function getCategoriesForInstances(
  db: SupabaseClient,
  orgId: string,
  scopedInstanceIds: string[] | null
): Promise<{ code: string; name: string }[]> {
  if (!scopedInstanceIds) return getAllCategories(db, orgId);

  const codesRes = await db.from("category_instances").select("code").eq("org_id", orgId).in("instance_id", scopedInstanceIds);
  if (codesRes.error) throw new Error(codesRes.error.message);
  const codes = [...new Set((codesRes.data ?? []).map((r: { code: string }) => r.code))];
  if (codes.length === 0) return getAllCategories(db, orgId);

  const categoriesRes = await db.from("categories").select("code, name").eq("org_id", orgId).in("code", codes).order("name");
  if (categoriesRes.error) throw new Error(categoriesRes.error.message);
  const categories = categoriesRes.data ?? [];
  return categories.length > 0 ? categories : getAllCategories(db, orgId);
}

export interface InventoryMovementFilters {
  instanceIds?: string[];
  /** "YYYY-MM-DD" — inclusive. */
  dateFrom?: string;
  dateTo?: string;
}

export interface InventoryMovementRow {
  product_sku: string;
  product_name: string | null;
  qty_in_purchases: number;
  qty_in_assemblies: number;
  qty_out_sales: number;
  qty_out_consumption: number;
  total_in: number;
  total_out: number;
  net_change: number;
  mover_category: "Fast" | "Medium" | "Slow" | "No movement";
}

/**
 * Per-product in/out movement over a period (report_inventory_movement, 0027)
 * — combines Purchases + Assembly Builds (in) with Sales + Assembly
 * Consumption (out) and classifies each product Fast/Medium/Slow/No movement
 * by outbound velocity, same "aggregate in Postgres" convention as the sales
 * report RPCs.
 */
export async function getInventoryMovementReport(
  db: SupabaseClient,
  orgId: string,
  filters: InventoryMovementFilters
): Promise<InventoryMovementRow[]> {
  const { data, error } = await db.rpc("report_inventory_movement", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_date_from: filters.dateFrom || null,
    p_date_to: filters.dateTo || null,
  });
  if (error) throw new Error(`report_inventory_movement: ${error.message}`);
  return data ?? [];
}

export interface StockHealthFilters {
  instanceIds?: string[];
  /** Velocity lookback window used for days-of-cover/mover classification — "YYYY-MM-DD", inclusive. */
  velocityDateFrom?: string;
  velocityDateTo?: string;
}

export interface StockHealthRow {
  product_sku: string;
  product_name: string | null;
  on_hand: number;
  available: number;
  stock_value: number;
  total_out: number;
  days_of_cover: number | null;
  mover_category: "Fast" | "Medium" | "Slow" | "No movement";
  status: "Stockout risk" | "Excess" | "Healthy";
}

/**
 * Current stock levels (product_availability, 0030) combined with outbound
 * velocity (reusing report_inventory_movement_lines, 0028) to surface days
 * of cover and excess/stockout flags per product — see report_stock_health
 * (0031) for the full combination logic.
 */
export async function getStockHealthReport(db: SupabaseClient, orgId: string, filters: StockHealthFilters): Promise<StockHealthRow[]> {
  const { data, error } = await db.rpc("report_stock_health", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_velocity_date_from: filters.velocityDateFrom || null,
    p_velocity_date_to: filters.velocityDateTo || null,
  });
  if (error) throw new Error(`report_stock_health: ${error.message}`);
  return data ?? [];
}

export interface ReorderReportFilters {
  instanceIds?: string[];
  /** Velocity lookback window used for the sales-over-period threshold — "YYYY-MM-DD", inclusive. */
  velocityDateFrom?: string;
  velocityDateTo?: string;
  /** Extra headroom on top of the period's total sales, e.g. 10 for +10%. */
  bufferPercent?: number;
}

export interface ReorderReportRow {
  product_sku: string;
  product_name: string | null;
  on_hand: number;
  available: number;
  on_order: number;
  avg_unit_cost: number | null;
  total_out: number;
  weeks_of_cover: number | null;
  reorder_threshold: number;
  needs_reorder: boolean;
  mover_category: "Fast" | "Medium" | "Slow" | "No movement";
  status: "Stockout risk" | "Excess" | "Healthy";
}

/**
 * The "Local" procurement workflow — flags a SKU once on-hand stock has
 * dropped to or below its recent sales velocity plus a selectable buffer %.
 * Deliberately separate from Stock Health/getStockHealthReport (its own
 * established column contract/export) and from the lead-time-based
 * Supplier Planner — see report_reorder (0048) for why these stay apart.
 */
export async function getReorderReport(db: SupabaseClient, orgId: string, filters: ReorderReportFilters): Promise<ReorderReportRow[]> {
  const { data, error } = await db.rpc("report_reorder", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_velocity_date_from: filters.velocityDateFrom || null,
    p_velocity_date_to: filters.velocityDateTo || null,
    p_buffer_percent: filters.bufferPercent ?? 0,
  });
  if (error) throw new Error(`report_reorder: ${error.message}`);
  return data ?? [];
}

export interface SupplierPlanLocationDemandFilters {
  instanceIds?: string[];
  velocityDateFrom?: string;
  velocityDateTo?: string;
}

export interface SupplierPlanLocationDemandRow {
  product_sku: string;
  location: string;
  on_hand: number;
  on_order: number;
  total_out: number;
}

/**
 * Genuine per-location on-hand/on-order/sales-velocity for Supplier Planner
 * (src/reports/supplier-planner/build.ts) — a NEW function rather than
 * widening report_reorder (0048), same discipline as
 * report_inventory_movement_lines sitting alongside report_inventory_movement.
 * See migration 0049 for why assembly-consumption demand isn't included
 * here (not location-tagged in this schema today).
 */
export async function getSupplierPlanLocationDemand(
  db: SupabaseClient,
  orgId: string,
  filters: SupplierPlanLocationDemandFilters
): Promise<SupplierPlanLocationDemandRow[]> {
  const { data, error } = await db.rpc("report_supplier_plan_location_demand", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_velocity_date_from: filters.velocityDateFrom || null,
    p_velocity_date_to: filters.velocityDateTo || null,
  });
  if (error) throw new Error(`report_supplier_plan_location_demand: ${error.message}`);
  return data ?? [];
}

export interface ProductAvailabilitySyncStatus {
  totalRows: number;
  lastSyncedAt: string | null;
}

/** Lets the report page show when stock levels were last refreshed — this is a full snapshot replace, not an incremental sync, so "last synced" is simply the newest synced_at across every row. Scoped to one instance when given (e.g. the Fulfillment Cleanup Helper, which only ever works against a single chosen instance) — an org-wide "last synced" would otherwise mask one stale instance behind another that happened to sync more recently. */
export async function getProductAvailabilitySyncStatus(db: SupabaseClient, orgId: string, instanceId?: string): Promise<ProductAvailabilitySyncStatus> {
  let countQuery = db.from("product_availability").select("*", { count: "exact", head: true }).eq("org_id", orgId);
  let latestQuery = db.from("product_availability").select("synced_at").eq("org_id", orgId);
  if (instanceId) {
    countQuery = countQuery.eq("instance_id", instanceId);
    latestQuery = latestQuery.eq("instance_id", instanceId);
  }
  const [countRes, latestRes] = await Promise.all([countQuery, latestQuery.order("synced_at", { ascending: false }).limit(1).maybeSingle()]);
  if (countRes.error) throw new Error(countRes.error.message);
  if (latestRes.error) throw new Error(latestRes.error.message);
  return { totalRows: countRes.count ?? 0, lastSyncedAt: latestRes.data?.synced_at ?? null };
}

export interface SalesSyncStatus {
  totalSales: number;
  pendingDetail: number;
}

/**
 * Lets the report page explain why very recent invoices might not have
 * revenue/COGS yet — detail fetch is rate-limited and queued (see
 * sync/sync-sales.ts). Scoped to one instance when given — the Fulfillment
 * Cleanup Helper needs this so a user isn't left guessing whether a
 * specific test order's customer_reference/backorder line has synced yet,
 * without an org-wide count (which could span several instances) masking
 * how close THIS instance's queue is to done.
 */
export async function getSalesSyncStatus(db: SupabaseClient, orgId: string, instanceId?: string): Promise<SalesSyncStatus> {
  let totalQuery = db.from("sales").select("*", { count: "exact", head: true }).eq("org_id", orgId);
  let pendingQuery = db.from("sales").select("*", { count: "exact", head: true }).eq("org_id", orgId).is("detail_synced_at", null);
  if (instanceId) {
    totalQuery = totalQuery.eq("instance_id", instanceId);
    pendingQuery = pendingQuery.eq("instance_id", instanceId);
  }
  const [totalRes, pendingRes] = await Promise.all([totalQuery, pendingQuery]);
  if (totalRes.error) throw new Error(totalRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  return { totalSales: totalRes.count ?? 0, pendingDetail: pendingRes.count ?? 0 };
}

export interface OrderFulfillmentFilters {
  instanceIds?: string[];
  /**
   * "YYYY-MM-DD", inclusive — filters both report_order_fulfillment and
   * report_order_fulfillment_lines server-side to orders whose ship_by
   * (falling back to order_date, same effective-date convention the
   * qualification logic itself uses) is on or after this date; an order
   * with neither date set is never excluded by this filter (nothing
   * disappears just because its date is unknown). Omitted/undefined means
   * no date filter — the original unbounded behavior every caller except
   * Order Fulfillment's own default UI state still gets. Added 2026-08-18
   * after LBL's real data volume hit MAX_RPC_ROWS on the unfiltered lines
   * fetch — see that constant's own comment.
   */
  fromDate?: string;
}

/**
 * One entry per fulfilment on this order that currently has a positive
 * ready-to-invoice quantity (LBL fulfilment-grain requirement) — invoiced_qty
 * is attributed to THIS fulfilment only via its own linked invoice number,
 * not summed across the whole sale (see migration 0081's header comment for
 * why: the same SKU can appear in more than one sibling fulfilment).
 */
export interface ReadyToInvoiceFulfilment {
  fulfilment_task_id: string;
  fulfilment_number: number | null;
  linked_invoice_number: string | null;
  packed_authorised_qty: number;
  invoiced_qty: number;
  ready_to_invoice_qty: number;
}

export interface OrderFulfillmentRow {
  cin7_sale_id: string;
  instance_id: string;
  order_number: string | null;
  customer_name: string | null;
  /** The customer's own PO/reference number for this sale, if they gave one — often the clearest way for a human to recognize an order (e.g. in the Fulfillment Cleanup Helper's exclusion checklist). */
  customer_reference: string | null;
  order_date: string | null;
  /** Null when order_date itself is unknown — distinct from 0, which means "opened today." */
  days_open: number | null;
  ship_by: string | null;
  is_overdue: boolean;
  order_status: string | null;
  combined_picking_status: string | null;
  combined_packing_status: string | null;
  combined_shipping_status: string | null;
  combined_invoice_status: string | null;
  combined_payment_status: string | null;
  paid_amount: number;
  invoice_amount: number;
  total_ordered_qty: number;
  total_backorder_qty: number;
  total_pickable_qty: number;
  total_picked_qty: number;
  is_pick_today: boolean;
  is_ship_today: boolean;
  /** True when this order would otherwise be pick-today but its effective date (ship_by, falling back to order_date) falls before the instance's fulfilment_view_start_date setting (P5.3) — lets the UI show "N older orders hidden" without re-deriving the qualification rule client-side. */
  pick_today_hidden_by_floor: boolean;
  /** Same as pick_today_hidden_by_floor, for the shipping queue. */
  ship_today_hidden_by_floor: boolean;
  /** Sum of every line's ready_to_invoice_qty (P1, "Ready to Invoice" queue) — authorised-packed quantity not yet covered by an AUTHORISED/PAID invoice, summed across every fulfilment/invoice on the order. */
  total_ready_to_invoice_qty: number;
  is_ready_to_invoice: boolean;
  /** Same floor semantics as pick_today_hidden_by_floor/ship_today_hidden_by_floor, for the Ready to Invoice queue. */
  ready_to_invoice_hidden_by_floor: boolean;
  /** Null when no fulfilment on this sale currently has a positive ready-to-invoice quantity, or the sale hasn't been re-synced since fulfilment identity started being captured (migration 0081) — self-heals on next detail sync. */
  ready_to_invoice_fulfilments: ReadyToInvoiceFulfilment[] | null;
  /** Comma-joined FulfillmentNumber(s) from ready_to_invoice_fulfilments, e.g. "1" or "1, 3" — a quick display string so the UI doesn't need to parse the jsonb array just to show which fulfilment(s) are ready. */
  ready_to_invoice_fulfilment_numbers: string | null;
  /** Distinct AUTHORISED/PAID invoice numbers on this order, comma-joined — null when nothing's been finally invoiced yet (P2, "Box Label Queue"). */
  invoice_numbers: string | null;
  /** Requirement 3's shipping-view filter: "not_invoiced" | "partially_invoiced" | "invoiced", computed from real invoiced-vs-ordered quantities rather than trusting Cin7's own combined_invoice_status string. */
  invoice_coverage_status: "not_invoiced" | "partially_invoiced" | "invoiced";
  /** Sum of every line's ready_for_box_label_qty (P2) — authorised-packed quantity now fully covered by a final invoice, the exact complement of total_ready_to_invoice_qty. */
  total_ready_for_box_label_qty: number;
  /** False once a local box_label_print_state row exists for this sale — that flag, not Cin7 attachment detection, is the real "drops off the queue" mechanism (see migration 0063's own comment on why bulk attachment auto-clear isn't built). */
  is_ready_for_box_label: boolean;
  box_label_hidden_by_floor: boolean;
  /** Null unless someone has clicked "Mark as printed" for this sale — a Toolbox-local record, never written to Cin7. */
  box_label_printed_at: string | null;
  box_label_printed_by_email: string | null;
  /** P5.2: true when ≥1 backordered line has a linked open PO (with ETA) covering it. Independent of has_backorder_no_po — a mixed order (one line covered, another not) can be true for both. */
  has_backorder_with_po: boolean;
  /** P5.2: true when ≥1 backordered line has NO linked open PO — the actionable procurement list ("nothing's on order for this yet"), as distinct from Cin7's own status fields. */
  has_backorder_no_po: boolean;
  /** P5.5: sum of every line's packed_qty (every attempted pack, regardless of authorisation) — broader than total_pickable_qty/total_picked_qty, added as a pickable export column. */
  total_packed_qty: number;
  /** P5.5: sum of every line's packed_qty_authorised — narrower than total_packed_qty above, same "AUTHORISED fulfilment only" scope total_ready_to_invoice_qty already uses. */
  total_packed_qty_authorised: number;
  /** P5.5: sum of every line's invoiced_qty. Was already computed internally for invoice_coverage_status but never exposed as its own column until this. */
  total_invoiced_qty: number;
  /** P5.5: sum of every line's backorder_po_outstanding_qty — the remaining qty on each line's own linked PO, summed. Not a single coherent "PO balance" when different lines are covered by different POs, but still a reasonable "how much is still outstanding across every PO covering this order" export figure; a line with no linked PO contributes 0. */
  total_backorder_po_outstanding_qty: number;
}

export interface OrderFulfillmentLineRow {
  cin7_sale_id: string;
  product_sku: string;
  product_name: string | null;
  ordered_qty: number;
  backorder_qty: number;
  picked_qty: number;
  packed_qty: number;
  pickable_qty: number;
  /** Where this SKU was actually picked from so far on this order (audit trail) — comma-joined, null if nothing's been picked yet. */
  picked_from_locations: string | null;
  /** Forward guidance for a still-outstanding line — the real stock location currently holding the most on-hand for this SKU (from Stock Health's product_availability), not a record of where anything was actually picked from. */
  suggested_pick_location: string | null;
  suggested_pick_location_on_hand: number | null;
  /** Which open (non-voided, non-drop-ship) purchase order this backordered SKU is expected on, if any — null when no open PO currently carries it. */
  backorder_po_number: string | null;
  /** The PO's RequiredBy date — confirmed live to be the ONLY ETA Cin7 exposes at all (no per-line date field exists); frequently null even on open orders, shown as-is rather than hidden. */
  backorder_eta: string | null;
  backorder_po_outstanding_qty: number | null;
  /** Packed quantity whose OWNING fulfilment's Pack.Status is AUTHORISED — narrower than packed_qty above, which counts every attempted pack regardless of authorisation (P1, "Ready to Invoice" queue). */
  packed_qty_authorised: number;
  /** Summed across every invoice on the order whose Status is AUTHORISED or PAID — a DRAFT or (if Cin7 ever shows one) VOIDED invoice's lines don't count, an allow-list not a deny-list since VOIDED has never been confirmed live. */
  invoiced_qty: number;
  /** greatest(packed_qty_authorised - invoiced_qty, 0) — the actual per-line qualifying quantity for Ready to Invoice. */
  ready_to_invoice_qty: number;
  /** packed_qty_authorised when invoiced_qty already covers it (else 0) — the exact complement of ready_to_invoice_qty, P2's per-line qualifying quantity for the Box Label Queue. */
  ready_for_box_label_qty: number;
}

/**
 * One row per order (report_order_fulfillment, 0033) — the Combined status
 * fields Phase 1 synced, plus is_pick_today/is_ship_today (plain booleans,
 * not a forced single "stage" label — confirmed live pick/pack/ship/invoice
 * don't gate each other in a fixed sequence on this account). "Today" is a
 * priority queue, not a strict date filter: overdue orders and undated
 * orders both stay in scope (sorted first / last respectively), not
 * excluded — nothing that needs action drops out of sight.
 */
export async function getOrderFulfillmentReport(db: SupabaseClient, orgId: string, filters: OrderFulfillmentFilters): Promise<OrderFulfillmentRow[]> {
  return fetchAllRpcRows<OrderFulfillmentRow>(db, "report_order_fulfillment", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_from_date: filters.fromDate ?? null,
  });
}

export interface ShipTodayCounts {
  shipToday: number;
  overdue: number;
}

/**
 * The home page's "Ship Today" card needs exactly two numbers. It used to get
 * them from getOrderFulfillmentReport(db, orgId, {}) — an unfiltered fetch of
 * every order row, which for a real client (LBL, 10,887 orders) meant 11 paged
 * PostgREST calls, each one re-executing the whole ~4.4s report from scratch,
 * only to count two booleans and discard the other 40-odd columns. That is what
 * pushed individual calls past PostgREST's 8s statement_timeout and left the
 * home page rendering as a blank error screen (2026-09-05).
 *
 * report_ship_today_counts (0087) computes the same two numbers directly from
 * `sales` — neither is_ship_today nor is_overdue depends on any of the
 * line-level aggregation, so none of it needs to run. One call, ~12ms.
 */
export async function getShipTodayCounts(db: SupabaseClient, orgId: string, filters: OrderFulfillmentFilters = {}): Promise<ShipTodayCounts> {
  const { data, error } = await db
    .rpc("report_ship_today_counts", {
      p_org_id: orgId,
      p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    })
    .maybeSingle<{ ship_today_count: number; overdue_count: number }>();
  if (error) throw new Error(`report_ship_today_counts: ${error.message}`);
  return { shipToday: Number(data?.ship_today_count ?? 0), overdue: Number(data?.overdue_count ?? 0) };
}

/** Per-SKU detail behind an order's row (report_order_fulfillment_lines, 0033) — fetched for every order in the current result set up front (a plain DB read, not a rate-limited Cin7 call), so expanding a row is instant. */
export async function getOrderFulfillmentLines(db: SupabaseClient, orgId: string, filters: OrderFulfillmentFilters): Promise<OrderFulfillmentLineRow[]> {
  return fetchAllRpcRows<OrderFulfillmentLineRow>(db, "report_order_fulfillment_lines", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
    p_from_date: filters.fromDate ?? null,
  });
}

export interface StocktakeStagedStockRow {
  product_sku: string;
  product_name: string | null;
  picked_qty: number;
  packed_qty: number;
}

/** Every location this instance has any synced stock in (product_availability), for the Stocktake Assistant's location picker — a plain DB read, no live Cin7 call needed since a stocktake location by definition already has stock. */
export async function getStocktakeLocations(db: SupabaseClient, orgId: string, instanceId: string): Promise<string[]> {
  const { data, error } = await db
    .from("product_availability")
    .select("location")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .not("location", "is", null);
  if (error) throw new Error(`product_availability locations: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.location as string))].sort();
}

/** Per-SKU picked/packed quantity still staged (not yet shipped) at one instance+location (report_stocktake_staged_stock, 0053) — the stock a physical stocktake walk-through won't see on the shelf. */
export async function getStocktakeStagedStock(db: SupabaseClient, orgId: string, instanceId: string, location: string): Promise<StocktakeStagedStockRow[]> {
  const { data, error } = await db.rpc("report_stocktake_staged_stock", {
    p_org_id: orgId,
    p_instance_id: instanceId,
    p_location: location,
  });
  if (error) throw new Error(`report_stocktake_staged_stock: ${error.message}`);
  return data ?? [];
}
