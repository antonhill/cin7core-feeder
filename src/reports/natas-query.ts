import type { SupabaseClient } from "@supabase/supabase-js";
import { CASA_DAS_NATAS_ORG_ID } from "@/lib/casa-das-natas";
import {
  buildBomCostIndex,
  buildNatasReport,
  PACKAGING_PATCH_SKU_PATTERN,
  type NatasSaleLineInput,
  type BomLineInput,
  type NatasReportResult,
} from "@/reports/natas-report";

export interface NatasReportFilters {
  instanceIds?: string[];
  location?: string;
  /** "YYYY-MM-DD" — inclusive. */
  dateFrom?: string;
  dateTo?: string;
}

interface RawSaleLineRow {
  instance_id: string;
  cin7_sale_id: string;
  product_sku: string | null;
  product_name: string | null;
  quantity: number | null;
  total: number | null;
  average_cost: number | null;
  invoice_date: string | null;
  sales: { location: string | null } | null;
}

interface RawBomLineRow {
  product_sku: string;
  component_sku: string;
  quantity: number;
  estimated_unit_cost: number | null;
}

/**
 * Fetches this org's Nata-category sale lines (predefined packs and
 * individual singles alike) plus any "patch" packaging lines sold
 * alongside them, joins in category/BOM data, and runs buildNatasReport.
 * Single-org by design (see CASA_DAS_NATAS_ORG_ID) — every query here is
 * hardcoded to that org, not parameterized, matching the rest of this
 * report's scope.
 */
export async function getNatasReport(db: SupabaseClient, filters: NatasReportFilters): Promise<NatasReportResult> {
  const orgId = CASA_DAS_NATAS_ORG_ID;

  // This org's whole catalog is small — cheaper to fetch once for a
  // sku -> category lookup than to join per sale line or per BOM line.
  const { data: productsData, error: productsError } = await db.from("products").select("sku, category_code").eq("org_id", orgId);
  if (productsError) throw new Error(`products: ${productsError.message}`);
  const categoryBySku = new Map(
    (productsData ?? []).map((p: { sku: string; category_code: string | null }) => [p.sku, p.category_code])
  );

  let saleLinesQuery = db
    .from("sale_lines")
    .select("instance_id, cin7_sale_id, product_sku, product_name, quantity, total, average_cost, invoice_date, sales!inner(location)")
    .eq("org_id", orgId);
  if (filters.instanceIds?.length) saleLinesQuery = saleLinesQuery.in("instance_id", filters.instanceIds);
  if (filters.dateFrom) saleLinesQuery = saleLinesQuery.gte("invoice_date", filters.dateFrom);
  if (filters.dateTo) saleLinesQuery = saleLinesQuery.lte("invoice_date", filters.dateTo);
  if (filters.location) saleLinesQuery = saleLinesQuery.eq("sales.location", filters.location);

  const { data: saleLinesData, error: saleLinesError } = await saleLinesQuery;
  if (saleLinesError) throw new Error(`sale_lines: ${saleLinesError.message}`);

  const saleLines: NatasSaleLineInput[] = ((saleLinesData ?? []) as unknown as RawSaleLineRow[])
    .filter((row) => row.product_sku)
    .map((row) => {
      const sku = row.product_sku as string;
      return {
        instanceId: row.instance_id,
        cin7SaleId: row.cin7_sale_id,
        productSku: sku,
        productName: row.product_name,
        categoryCode: categoryBySku.get(sku) ?? null,
        quantity: row.quantity ?? 0,
        total: row.total ?? 0,
        averageCost: row.average_cost,
        invoiceDate: row.invoice_date,
        location: row.sales?.location ?? null,
      };
    })
    .filter((line) => line.categoryCode === "Nata" || PACKAGING_PATCH_SKU_PATTERN.test(line.productSku));

  const relevantSkus = [...new Set(saleLines.map((l) => l.productSku))];
  let bomLines: BomLineInput[] = [];
  if (relevantSkus.length) {
    const { data: bomData, error: bomError } = await db
      .from("assembly_bom_lines")
      .select("product_sku, component_sku, quantity, estimated_unit_cost")
      .eq("org_id", orgId)
      .in("product_sku", relevantSkus);
    if (bomError) throw new Error(`assembly_bom_lines: ${bomError.message}`);
    bomLines = ((bomData ?? []) as RawBomLineRow[]).map((row) => ({
      productSku: row.product_sku,
      componentSku: row.component_sku,
      quantity: row.quantity,
      estimatedUnitCost: row.estimated_unit_cost,
      componentCategoryCode: categoryBySku.get(row.component_sku) ?? null,
    }));
  }

  return buildNatasReport(saleLines, buildBomCostIndex(bomLines));
}

export interface NatasFilterOptions {
  instances: { id: string; name: string }[];
  locations: string[];
}

export async function getNatasFilterOptions(db: SupabaseClient): Promise<NatasFilterOptions> {
  const orgId = CASA_DAS_NATAS_ORG_ID;
  const [instancesRes, locationsRes] = await Promise.all([
    db.from("cin7_instances").select("id, name").eq("org_id", orgId).order("name"),
    db.from("sales").select("location").eq("org_id", orgId).not("location", "is", null),
  ]);
  if (instancesRes.error) throw new Error(instancesRes.error.message);
  if (locationsRes.error) throw new Error(locationsRes.error.message);

  const locations = [...new Set((locationsRes.data ?? []).map((r: { location: string }) => r.location).filter(Boolean))].sort();
  return { instances: instancesRes.data ?? [], locations };
}
