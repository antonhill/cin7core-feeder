import { defineFields, type FieldSpec, type RowOf, type ScenarioId } from "@/rwtsa-demo/contracts/fields";

/**
 * Structural contracts for the 11 named tabs of the RWTSA demonstration workbook (NDA-safe brief §4).
 *
 * The brief names 11 tabs but says "twelve"; the 12th is unnamed, so it is NOT invented here. Any tab that
 * is not one of these is reported as an unknown tab (a warning, never an error).
 *
 * The brief gives column CONCEPTS, not exact header strings, so each field lists plausible aliases. Real
 * header text is validated locally (`scripts/rwtsa-demo/validate.ts`) and any difference is resolved with a
 * local header-map file rather than by guessing here.
 *
 * Negative values: quantities, costs, prices, minutes and rates are inherently non-negative, so a negative is an ERROR
 * (`negativeIsError`). Only fields that are signed by nature declare `allowNegative` (variance columns; the file's own derived
 * Available, which is negative when over-committed). Sales history cells (credit notes) are a WARNING.
 *
 * Percent-scale fields (overhead, efficiency, margin, duty rate) are read as plain numbers; whether the
 * workbook uses 0.15 or 15 for 15% is UNKNOWN and is deliberately not decided in this layer.
 */

export const SIZE_ORDER = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"] as const;

export const ITEMS_FIELDS = defineFields([
  { key: "sku", headers: ["SKU", "Item code", "Product code"], kind: "str", required: true },
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: true },
  { key: "description", headers: ["Description"], kind: "str", required: false },
  { key: "productionCode", headers: ["Production code", "Prod code"], kind: "str", required: false },
  { key: "fabric", headers: ["Fabric"], kind: "str", required: false },
  { key: "colour", headers: ["Colour", "Color"], kind: "str", required: false },
  { key: "size", headers: ["Size"], kind: "str", required: true },
  { key: "source", headers: ["Source", "Sourcing"], kind: "enum", required: true, values: ["Import", "Local", "Both"] },
  { key: "unit", headers: ["Unit", "UoM"], kind: "str", required: false },
  { key: "minLevel", headers: ["Min level", "Minimum level", "Min stock", "Minimum stock"], kind: "num", required: false, critical: "A", negativeIsError: true },
  { key: "reorderPoint", headers: ["Reorder point", "Reorder level"], kind: "num", required: false, negativeIsError: true },
  { key: "standardCost", headers: ["Standard cost", "Std cost"], kind: "num", required: true, negativeIsError: true },
  { key: "standardSellPrice", headers: ["Standard sell price", "Std sell price", "Sell price"], kind: "num", required: false, negativeIsError: true },
  // Not listed in the brief's Items shape, but DP-16 needs a tender / customer-order-only marker. Optional until
  // the real workbook is inspected locally.
  { key: "isTender", headers: ["Tender", "Tender flag", "Customer order only", "Tender / customer order only"], kind: "bool", required: false, critical: "A" },
] as const);
export type ItemRow = RowOf<typeof ITEMS_FIELDS>;

/** SalesHistory is SKU rows x `YYYY-MM` month columns; the month columns are dynamic, so only fixed fields are declared. */
export const SALES_HISTORY_FIELDS = defineFields([
  { key: "sku", headers: ["SKU", "Item code", "Product code"], kind: "str", required: true },
  { key: "avg6", headers: ["6 month average", "6m average", "6 month avg", "Avg 6", "Average 6 months"], kind: "num", required: false },
  { key: "avg12", headers: ["12 month average", "12m average", "12 month avg", "Avg 12", "Average 12 months"], kind: "num", required: false },
] as const);

export const STOCK_FIELDS = defineFields([
  { key: "sku", headers: ["SKU", "Item code", "Product code"], kind: "str", required: true },
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: false },
  { key: "colour", headers: ["Colour", "Color"], kind: "str", required: false },
  { key: "size", headers: ["Size"], kind: "str", required: false },
  { key: "jhb", headers: ["JHB", "Johannesburg"], kind: "num", required: true, negativeIsError: true },
  { key: "durban", headers: ["Durban", "DBN"], kind: "num", required: true, negativeIsError: true },
  { key: "capeTown", headers: ["Cape Town", "CPT"], kind: "num", required: true, negativeIsError: true },
  { key: "bond", headers: ["Bond", "Bond (not available)"], kind: "num", required: true, negativeIsError: true },
  { key: "factoryStore", headers: ["Factory store", "Factory"], kind: "num", required: true, negativeIsError: true },
  { key: "inTransit", headers: ["In transit", "Transit"], kind: "num", required: true, negativeIsError: true },
  { key: "committed", headers: ["Committed"], kind: "num", required: true, negativeIsError: true },
  { key: "available", headers: ["Available", "Available (excl. Bond)"], kind: "num", required: false, allowNegative: true },
] as const);
export type StockFileRow = RowOf<typeof STOCK_FIELDS>;

export const IMPORT_POS_FIELDS = defineFields([
  { key: "poNo", headers: ["PO no", "PO number", "PO"], kind: "str", required: true },
  { key: "supplier", headers: ["Supplier"], kind: "str", required: true },
  { key: "country", headers: ["Country"], kind: "str", required: false },
  { key: "currency", headers: ["Currency"], kind: "str", required: false },
  { key: "incoterm", headers: ["Incoterm"], kind: "str", required: false },
  // The brief says "SKU or style": quantities are by style but a SKU column may exist. At least one is required (cross-field rule).
  { key: "sku", headers: ["SKU"], kind: "str", required: false },
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: false },
  { key: "qty", headers: ["Qty", "Quantity"], kind: "num", required: true, negativeIsError: true },
  { key: "unitPriceUsd", headers: ["Unit price USD", "Unit price (USD)", "Unit price"], kind: "num", required: true, negativeIsError: true },
  { key: "etd", headers: ["ETD"], kind: "date", required: false },
  { key: "etaPort", headers: ["ETA port"], kind: "date", required: false },
  { key: "etaStores", headers: ["ETA stores", "ETA to stores"], kind: "date", required: true },
  { key: "status", headers: ["Status"], kind: "str", required: true },
  { key: "bondOnArrival", headers: ["Bond on arrival"], kind: "bool", required: false },
  { key: "shipmentRef", headers: ["Shipment", "Shipment ref", "Shipment reference"], kind: "str", required: false },
] as const);
export type ImportPoRow = RowOf<typeof IMPORT_POS_FIELDS>;

export const BOM_FIELDS = defineFields([
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: true },
  { key: "componentCode", headers: ["Component code", "Component", "Material code"], kind: "str", required: true },
  { key: "componentName", headers: ["Component name", "Description"], kind: "str", required: false },
  { key: "componentType", headers: ["Component type", "Type", "Category"], kind: "str", required: false },
  { key: "qtyPerUnit", headers: ["Qty per unit", "Quantity per unit", "Qty", "Quantity"], kind: "num", required: true, negativeIsError: true },
  { key: "unit", headers: ["Unit", "UoM"], kind: "str", required: false },
  { key: "unitCost", headers: ["Unit cost", "Cost"], kind: "num", required: false, negativeIsError: true },
  // Size-varying component (e.g. a longer zip from a given size up): either an explicit size or a from-size.
  { key: "size", headers: ["Size"], kind: "str", required: false },
  { key: "sizeFrom", headers: ["Size from", "From size", "Applies from size"], kind: "str", required: false },
] as const);
export type BomRow = RowOf<typeof BOM_FIELDS>;

export const ROUTING_SMV_FIELDS = defineFields([
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: true },
  { key: "operation", headers: ["Operation", "Operation name"], kind: "str", required: true },
  { key: "smv", headers: ["SMV", "Standard minute value", "Minutes"], kind: "num", required: true, negativeIsError: true },
  { key: "costPerMinute", headers: ["Cost per minute", "Cost/min", "Rate per minute"], kind: "num", required: true, negativeIsError: true },
  { key: "overhead", headers: ["Overhead", "Overhead %"], kind: "num", required: false, critical: "B", negativeIsError: true },
  { key: "efficiency", headers: ["Efficiency", "Efficiency %", "Efficiency allowance"], kind: "num", required: false, critical: "B", negativeIsError: true },
  { key: "margin", headers: ["Margin", "Margin %"], kind: "num", required: false, critical: "B", negativeIsError: true },
] as const);
export type RoutingRow = RowOf<typeof ROUTING_SMV_FIELDS>;

export const PRODUCTION_ORDERS_FIELDS = defineFields([
  { key: "orderNo", headers: ["Order", "Order no", "Production order"], kind: "str", required: true },
  { key: "styleCode", headers: ["Style code", "Style"], kind: "str", required: true },
  { key: "qty", headers: ["Qty", "Quantity", "Order qty"], kind: "num", required: true, negativeIsError: true },
  { key: "plannedSmv", headers: ["Planned SMV"], kind: "num", required: false, negativeIsError: true },
  { key: "plannedMinutes", headers: ["Planned minutes"], kind: "num", required: true, negativeIsError: true },
  { key: "actualMinutes", headers: ["Actual minutes"], kind: "num", required: true, negativeIsError: true },
  { key: "plannedFabricM", headers: ["Planned fabric (m)", "Planned fabric m", "Planned fabric"], kind: "num", required: true, negativeIsError: true },
  { key: "actualFabricM", headers: ["Actual fabric (m)", "Actual fabric m", "Actual fabric"], kind: "num", required: true, negativeIsError: true },
  { key: "standardPrice", headers: ["Planned price", "Standard price", "Std price", "Planned fabric price"], kind: "num", required: false, critical: "B", negativeIsError: true },
  { key: "actualPrice", headers: ["Actual price", "Actual fabric price"], kind: "num", required: false, critical: "B", negativeIsError: true },
  { key: "labourRecoveryPct", headers: ["Labour recovery %", "Labour recovery"], kind: "num", required: false, negativeIsError: true },
  { key: "usageVariance", headers: ["Usage variance"], kind: "num", required: false, allowNegative: true },
  { key: "priceVariance", headers: ["Price variance"], kind: "num", required: false, allowNegative: true },
  { key: "productionLine", headers: ["Production line", "Line"], kind: "str", required: true },
] as const);
export type ProductionOrderRow = RowOf<typeof PRODUCTION_ORDERS_FIELDS>;

/** Only the fields needed to prove structure and shipment scoping are required; the calculation PR will tighten this after local inspection. */
export const LANDED_COST_FIELDS = defineFields([
  { key: "shipmentRef", headers: ["Shipment", "Shipment ref", "Shipment reference"], kind: "str", required: true },
  { key: "sku", headers: ["SKU"], kind: "str", required: true },
  { key: "qty", headers: ["Qty", "Quantity"], kind: "num", required: true, negativeIsError: true },
  { key: "fobUsd", headers: ["FOB USD", "FOB (USD)", "FOB"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "planningFx", headers: ["Planning FX", "Planning rate"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "customsFx", headers: ["Customs FX", "Customs rate"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "dutyZar", headers: ["Duty", "Duty ZAR", "Duty (ZAR)"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "cbm", headers: ["CBM", "Volume (CBM)"], kind: "num", required: true, negativeIsError: true },
  { key: "freightTotalZar", headers: ["Freight", "Freight ZAR", "Shipment freight"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "freightAllocatedZar", headers: ["Freight allocated", "Allocated freight"], kind: "num", required: false, negativeIsError: true },
] as const);
export type LandedCostRow = RowOf<typeof LANDED_COST_FIELDS>;

export const PAYMENTS_FEC_FIELDS = defineFields([
  { key: "poNo", headers: ["PO no", "PO number", "PO"], kind: "str", required: true },
  { key: "supplier", headers: ["Supplier"], kind: "str", required: true },
  { key: "shipmentDate", headers: ["Shipment date"], kind: "date", required: false },
  { key: "termsDays", headers: ["Terms (days)", "Terms days", "Terms"], kind: "num", required: false, negativeIsError: true },
  { key: "dueDate", headers: ["Due date"], kind: "date", required: true },
  { key: "usdAmount", headers: ["USD amount", "Amount USD", "USD"], kind: "num", required: true, negativeIsError: true },
  { key: "fecRef", headers: ["FEC reference", "FEC ref", "FEC"], kind: "str", required: false, critical: "C" },
  { key: "lockedRate", headers: ["Locked rate", "FEC rate"], kind: "num", required: false, critical: "C", negativeIsError: true },
  { key: "zarValue", headers: ["ZAR value", "Amount ZAR", "ZAR"], kind: "num", required: false, negativeIsError: true },
  { key: "isDeposit", headers: ["Deposit", "Is deposit"], kind: "bool", required: false },
] as const);
export type PaymentFecRow = RowOf<typeof PAYMENTS_FEC_FIELDS>;

export const CUSTOMERS_FIELDS = defineFields([
  { key: "customer", headers: ["Customer", "Customer name", "Customer code"], kind: "str", required: true },
  { key: "contact", headers: ["Contact", "Contact name"], kind: "str", required: false },
  { key: "rep", headers: ["Rep", "Sales rep", "Sales representative"], kind: "str", required: false },
] as const);
export type CustomerRow = RowOf<typeof CUSTOMERS_FIELDS>;

export const QUOTES_FIELDS = defineFields([
  { key: "quoteNo", headers: ["Quote", "Quote no", "Quote number"], kind: "str", required: true },
  { key: "customer", headers: ["Customer", "Customer name", "Customer code"], kind: "str", required: true },
  { key: "rep", headers: ["Rep", "Sales rep", "Sales representative"], kind: "str", required: false },
  // Free text on purpose: an unrecognised status must reach the engine as UNCLASSIFIED and be reported, not fail the whole workbook.
  // Normalised by contracts/quote-status.ts.
  { key: "status", headers: ["Status"], kind: "str", required: true },
  { key: "value", headers: ["Value", "Quote value", "Amount"], kind: "num", required: true, negativeIsError: true },
  { key: "lostReason", headers: ["Lost reason", "Reason lost"], kind: "str", required: false, critical: "D" },
  { key: "convertedOrder", headers: ["Converted order", "Sales order", "Original SO", "Order no"], kind: "str", required: false, critical: "D" },
  { key: "quoteDate", headers: ["Quote date", "Date"], kind: "date", required: false },
  { key: "product", headers: ["Product", "Style", "Style code"], kind: "str", required: false },
] as const);
export type QuoteRow = RowOf<typeof QUOTES_FIELDS>;

export const TAB_NAMES = [
  "Items",
  "SalesHistory",
  "Stock",
  "ImportPOs",
  "BOM",
  "Routing_SMV",
  "ProductionOrders",
  "LandedCost",
  "Payments_FEC",
  "Customers",
  "Quotes",
] as const;
export type TabName = (typeof TAB_NAMES)[number];

export interface TabContract {
  readonly tab: TabName;
  readonly fields: readonly FieldSpec[];
  /** Keys that together identify a row; duplicates are an error. Optional key parts that are blank count as an empty segment. */
  readonly naturalKey: readonly string[];
  /** SalesHistory only: the tab carries dynamic `YYYY-MM` columns. */
  readonly monthColumns?: boolean;
}

export const TAB_CONTRACTS: Readonly<Record<TabName, TabContract>> = {
  Items: { tab: "Items", fields: ITEMS_FIELDS, naturalKey: ["sku"] },
  SalesHistory: { tab: "SalesHistory", fields: SALES_HISTORY_FIELDS, naturalKey: ["sku"], monthColumns: true },
  Stock: { tab: "Stock", fields: STOCK_FIELDS, naturalKey: ["sku"] },
  ImportPOs: { tab: "ImportPOs", fields: IMPORT_POS_FIELDS, naturalKey: ["poNo", "sku", "styleCode"] },
  BOM: { tab: "BOM", fields: BOM_FIELDS, naturalKey: ["styleCode", "componentCode", "size", "sizeFrom"] },
  Routing_SMV: { tab: "Routing_SMV", fields: ROUTING_SMV_FIELDS, naturalKey: ["styleCode", "operation"] },
  ProductionOrders: { tab: "ProductionOrders", fields: PRODUCTION_ORDERS_FIELDS, naturalKey: ["orderNo"] },
  LandedCost: { tab: "LandedCost", fields: LANDED_COST_FIELDS, naturalKey: ["shipmentRef", "sku"] },
  Payments_FEC: { tab: "Payments_FEC", fields: PAYMENTS_FEC_FIELDS, naturalKey: ["poNo", "dueDate", "usdAmount"] },
  Customers: { tab: "Customers", fields: CUSTOMERS_FIELDS, naturalKey: ["customer", "contact"] },
  Quotes: { tab: "Quotes", fields: QUOTES_FIELDS, naturalKey: ["quoteNo"] },
};

/** Tabs without which the workbook is not a usable demonstration dataset at all: empty => ERROR (not just "scenario not ready"). */
export const CORE_TABS: readonly TabName[] = ["Items", "SalesHistory", "Stock"];

/** Records each scenario needs; an empty/missing tab makes that scenario not ready (a warning for non-core tabs). */
export const SCENARIO_TABS: Readonly<Record<ScenarioId, readonly TabName[]>> = {
  A: ["Items", "SalesHistory", "Stock", "ImportPOs"],
  B: ["Items", "BOM", "Routing_SMV", "ProductionOrders"],
  C: ["ImportPOs", "LandedCost", "Payments_FEC"],
  D: ["Customers", "Quotes"],
};
