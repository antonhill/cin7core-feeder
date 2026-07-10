import type { SupabaseClient } from "@supabase/supabase-js";
import type { PivotGroupBy, PivotSourceRow } from "@/reports/pivot";

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
  instances: { id: string; name: string }[];
  locations: string[];
  categories: { code: string; name: string }[];
}

/** Options for the report's filter dropdowns — every connected instance, every distinct location a synced sale carries, and every known category. */
export async function getReportFilterOptions(db: SupabaseClient, orgId: string): Promise<ReportFilterOptions> {
  const [instancesRes, locationsRes, categoriesRes] = await Promise.all([
    db.from("cin7_instances").select("id, name").eq("org_id", orgId).order("name"),
    db.from("sales").select("location").eq("org_id", orgId).not("location", "is", null),
    db.from("categories").select("code, name").eq("org_id", orgId).order("name"),
  ]);
  if (instancesRes.error) throw new Error(instancesRes.error.message);
  if (locationsRes.error) throw new Error(locationsRes.error.message);
  if (categoriesRes.error) throw new Error(categoriesRes.error.message);

  const locations = [...new Set((locationsRes.data ?? []).map((r: { location: string }) => r.location).filter(Boolean))].sort();

  return {
    instances: instancesRes.data ?? [],
    locations,
    categories: categoriesRes.data ?? [],
  };
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
  const { data, error } = await db.rpc("report_order_fulfillment", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
  });
  if (error) throw new Error(`report_order_fulfillment: ${error.message}`);
  return data ?? [];
}

/** Per-SKU detail behind an order's row (report_order_fulfillment_lines, 0033) — fetched for every order in the current result set up front (a plain DB read, not a rate-limited Cin7 call), so expanding a row is instant. */
export async function getOrderFulfillmentLines(db: SupabaseClient, orgId: string, filters: OrderFulfillmentFilters): Promise<OrderFulfillmentLineRow[]> {
  const { data, error } = await db.rpc("report_order_fulfillment_lines", {
    p_org_id: orgId,
    p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
  });
  if (error) throw new Error(`report_order_fulfillment_lines: ${error.message}`);
  return data ?? [];
}
