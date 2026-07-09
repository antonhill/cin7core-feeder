import type { DimensionDef, MeasureDef } from "@/reports/custom/aggregate";
import type { SalesFactRow, InventoryMovementFactRow } from "@/reports/custom/facts";

export type ReportSourceKey = "sales" | "inventory_movement";

export interface ReportSourceConfig<Row> {
  label: string;
  dimensions: DimensionDef<Row>[];
  measures: MeasureDef<Row>[];
}

function monthOf(dateStr: string | null): string {
  return dateStr ? dateStr.slice(0, 7) : "Unknown";
}

export const SALES_SOURCE: ReportSourceConfig<SalesFactRow> = {
  label: "Sales",
  dimensions: [
    { key: "product", label: "Product", getGroupKey: (r) => r.product_sku, getDisplayValue: (r) => r.product_name ?? r.product_sku },
    { key: "category", label: "Category", getGroupKey: (r) => r.category_code ?? "Uncategorized" },
    { key: "location", label: "Location", getGroupKey: (r) => r.location ?? "Unknown" },
    { key: "customer", label: "Customer", getGroupKey: (r) => r.customer_name ?? "Unknown" },
    { key: "month", label: "Month", getGroupKey: (r) => monthOf(r.invoice_date) },
  ],
  measures: [
    { key: "quantity_sold", label: "Qty sold", getValue: (r) => r.quantity ?? 0 },
    { key: "revenue", label: "Revenue", getValue: (r) => r.revenue ?? 0 },
    { key: "cogs", label: "COGS", getValue: (r) => r.cogs ?? 0 },
    { key: "profit", label: "Profit", getValue: (r) => r.profit ?? 0 },
    {
      key: "margin_percent",
      label: "Margin %",
      dependsOn: ["revenue", "profit"],
      compute: (sums) => (sums.revenue ? Math.round((sums.profit / sums.revenue) * 10000) / 100 : null),
    },
  ],
};

export const INVENTORY_MOVEMENT_SOURCE: ReportSourceConfig<InventoryMovementFactRow> = {
  label: "Inventory Movement",
  dimensions: [
    { key: "product", label: "Product", getGroupKey: (r) => r.product_sku, getDisplayValue: (r) => r.product_name ?? r.product_sku },
    { key: "month", label: "Month", getGroupKey: (r) => monthOf(r.movement_date) },
  ],
  measures: [
    { key: "qty_in_purchases", label: "Purchased In", getValue: (r) => (r.source === "purchases" ? (r.quantity ?? 0) : 0) },
    { key: "qty_in_assemblies", label: "Assembly In", getValue: (r) => (r.source === "assembly_in" ? (r.quantity ?? 0) : 0) },
    { key: "qty_out_sales", label: "Sold Out", getValue: (r) => (r.source === "sales" ? (r.quantity ?? 0) : 0) },
    { key: "qty_out_consumption", label: "Consumed Out", getValue: (r) => (r.source === "assembly_consumption" ? (r.quantity ?? 0) : 0) },
    {
      key: "net_change",
      label: "Net Change",
      getValue: (r) => (r.source === "purchases" || r.source === "assembly_in" ? (r.quantity ?? 0) : -(r.quantity ?? 0)),
    },
  ],
};

export const REPORT_SOURCES = {
  sales: SALES_SOURCE,
  inventory_movement: INVENTORY_MOVEMENT_SOURCE,
} as const;

export const REPORT_SOURCE_KEYS = Object.keys(REPORT_SOURCES) as ReportSourceKey[];
