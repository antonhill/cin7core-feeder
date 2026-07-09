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

export interface SalesSyncStatus {
  totalSales: number;
  pendingDetail: number;
}

/** Lets the report page explain why very recent invoices might not have revenue/COGS yet — detail fetch is rate-limited and queued (see sync/sync-sales.ts). */
export async function getSalesSyncStatus(db: SupabaseClient, orgId: string): Promise<SalesSyncStatus> {
  const [totalRes, pendingRes] = await Promise.all([
    db.from("sales").select("*", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("sales").select("*", { count: "exact", head: true }).eq("org_id", orgId).is("detail_synced_at", null),
  ]);
  if (totalRes.error) throw new Error(totalRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  return { totalSales: totalRes.count ?? 0, pendingDetail: pendingRes.count ?? 0 };
}
