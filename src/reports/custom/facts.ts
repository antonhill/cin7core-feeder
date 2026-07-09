import type { SupabaseClient } from "@supabase/supabase-js";

export interface CustomReportFilters {
  instanceIds?: string[];
  /** "YYYY-MM-DD" — inclusive. */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Per-line-item rows are pulled uncapped-in-SQL but capped here — a full
 * generic query builder can't predict how wide a client's chosen date range
 * is, so this guards against an accidental multi-year, whole-catalog pull
 * rather than building real pagination for a bounded v1. Fetches one extra
 * row past the cap so overflow is detected without silently truncating.
 */
const FACTS_ROW_LIMIT = 20000;

function tooManyRowsError(count: number): Error {
  return new Error(`This report matched over ${count} rows — narrow your date range or instance selection.`);
}

export interface SalesFactRow {
  product_sku: string;
  product_name: string | null;
  category_code: string | null;
  location: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  quantity: number;
  revenue: number;
  cogs: number;
  profit: number;
}

/** Per-invoice-line facts (report_sales_facts, 0029) — same grain/joins as report_sales_by_product, just unaggregated so any dimension combination can be grouped afterward. */
export async function getSalesFacts(db: SupabaseClient, orgId: string, filters: CustomReportFilters): Promise<SalesFactRow[]> {
  const { data, error } = await db
    .rpc("report_sales_facts", {
      p_org_id: orgId,
      p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
      p_date_from: filters.dateFrom || null,
      p_date_to: filters.dateTo || null,
    })
    .limit(FACTS_ROW_LIMIT + 1);
  if (error) throw new Error(`report_sales_facts: ${error.message}`);
  const rows = (data ?? []) as SalesFactRow[];
  if (rows.length > FACTS_ROW_LIMIT) throw tooManyRowsError(FACTS_ROW_LIMIT);
  return rows;
}

export interface InventoryMovementFactRow {
  product_sku: string;
  product_name: string | null;
  quantity: number;
  source: "purchases" | "assembly_in" | "sales" | "assembly_consumption";
  movement_date: string | null;
}

/** Per-movement-line facts (report_inventory_movement_lines, 0028) — the same 4-source union report_inventory_movement aggregates internally, exposed unaggregated. */
export async function getInventoryMovementFacts(db: SupabaseClient, orgId: string, filters: CustomReportFilters): Promise<InventoryMovementFactRow[]> {
  const { data, error } = await db
    .rpc("report_inventory_movement_lines", {
      p_org_id: orgId,
      p_instance_ids: filters.instanceIds?.length ? filters.instanceIds : null,
      p_date_from: filters.dateFrom || null,
      p_date_to: filters.dateTo || null,
    })
    .limit(FACTS_ROW_LIMIT + 1);
  if (error) throw new Error(`report_inventory_movement_lines: ${error.message}`);
  const rows = (data ?? []) as InventoryMovementFactRow[];
  if (rows.length > FACTS_ROW_LIMIT) throw tooManyRowsError(FACTS_ROW_LIMIT);
  return rows;
}
