import { z } from "zod";

/**
 * Mirrors Cin7 Core's "ProductionBOM" CSV export template
 * (docs/cin7-templates/ProductionBOM_*.csv). One CSV row = one component or
 * resource line within one operation; multiple rows share the same
 * (ProductSKU, Version, OperationSequence) to build up an operation's items.
 */
const yesNo = z.string().trim().toLowerCase().transform((v) => v === "yes");

export const productionBomCsvRowSchema = z.object({
  Action: z.string().trim().optional().default("Create/Update"),
  ProductSKU: z.string().trim().min(1, "ProductSKU is required"),
  ProductName: z.string().trim().optional().default(""),
  QuantityToProduce: z.coerce.number().default(1),
  BufferPercent: z.coerce.number().default(0),
  ProductionInstructionUrl: z.string().trim().optional().default(""),
  IgnoreCumulativeLeadTime: yesNo.optional().default(false),
  ProductionLeadTime: z.coerce.number().optional(),
  Version: z.string().trim().min(1, "Version is required"),
  VersionName: z.string().trim().optional().default(""),
  VersionDefault: yesNo.optional().default(false),
  MinQuantity: z.coerce.number().optional(),
  MaxQuantity: z.coerce.number().optional(),
  DeviationPercent: z.coerce.number().optional(),
  RunSize: z.coerce.number().optional(),
  OperationSequence: z.string().trim().min(1, "OperationSequence is required"),
  OperationType: z.string().trim().min(1, "OperationType is required"),
  OperationName: z.string().trim().optional().default(""),
  CycleTime: z.coerce.number().optional(),
  UnitPerCycle: z.coerce.number().optional(),
  WorkCentreCode: z.string().trim().optional().default(""),
  WorkCentreName: z.string().trim().optional().default(""),
  PreviousStep: z.string().trim().optional().default(""),
  ItemType: z.enum(["Component", "Resource"]),
  ComponentSKU_ResourceCode: z.string().trim().min(1, "ComponentSKU_ResourceCode is required"),
  ComponentName_ResourceName: z.string().trim().optional().default(""),
  Quantity: z.coerce.number().positive("Quantity must be > 0"),
  WastageQuantity_ForStockComponentOnly: z.coerce.number().optional(),
  WastagePercent_ForStockComponentOnly: z.coerce.number().optional(),
  CostAllocationType: z.string().trim().optional().default(""),
  SalesValue: z.coerce.number().optional(),
  CostOfWastage: z.coerce.number().optional(),
  DeliveryTo_LocationName: z.string().trim().optional().default(""),
  DeliveryTo_BinName: z.string().trim().optional().default(""),
  CoManPriceTier: z.string().trim().optional().default(""),
  Tracing: z.string().trim().optional().default(""),
  IssueMethodComponent: z.string().trim().optional().default(""),
  IssueMethodParameter: z.coerce.number().optional(),
  OperationIsBackflush: yesNo.optional().default(false),
  ComponentIsBackflush: yesNo.optional().default(false),
  ResourceCostType: z.string().trim().optional().default(""),
});

export type ProductionBomCsvRow = z.infer<typeof productionBomCsvRowSchema>;

export interface CanonicalProductionBomVersion {
  product_sku: string;
  version: string;
  version_name: string | null;
  version_default: boolean;
  min_quantity: number | null;
  max_quantity: number | null;
  deviation_percent: number | null;
  run_size: number | null;
  quantity_to_produce: number;
  buffer_percent: number;
  production_instruction_url: string | null;
  ignore_cumulative_lead_time: boolean;
  production_lead_time: number | null;
}

export interface CanonicalProductionBomOperation {
  product_sku: string;
  version: string;
  operation_sequence: string;
  operation_type: string;
  operation_name: string | null;
  cycle_time: number | null;
  unit_per_cycle: number | null;
  work_centre_code: string | null;
  work_centre_name: string | null;
  previous_step: string | null;
}

export interface CanonicalProductionBomItem {
  product_sku: string;
  version: string;
  operation_sequence: string;
  item_type: "Component" | "Resource";
  item_code: string;
  item_name: string | null;
  quantity: number;
  wastage_quantity: number | null;
  wastage_percent: number | null;
  cost_allocation_type: string | null;
  sales_value: number | null;
  cost_of_wastage: number | null;
  delivery_to_location: string | null;
  delivery_to_bin: string | null;
  coman_price_tier: string | null;
  tracing: string | null;
  issue_method_component: string | null;
  issue_method_parameter: number | null;
  operation_is_backflush: boolean;
  component_is_backflush: boolean;
  resource_cost_type: string | null;
}

export function toCanonicalVersion(row: ProductionBomCsvRow): CanonicalProductionBomVersion {
  return {
    product_sku: row.ProductSKU,
    version: row.Version,
    version_name: row.VersionName || null,
    version_default: row.VersionDefault,
    min_quantity: row.MinQuantity ?? null,
    max_quantity: row.MaxQuantity ?? null,
    deviation_percent: row.DeviationPercent ?? null,
    run_size: row.RunSize ?? null,
    quantity_to_produce: row.QuantityToProduce,
    buffer_percent: row.BufferPercent,
    production_instruction_url: row.ProductionInstructionUrl || null,
    ignore_cumulative_lead_time: row.IgnoreCumulativeLeadTime,
    production_lead_time: row.ProductionLeadTime ?? null,
  };
}

export function toCanonicalOperation(row: ProductionBomCsvRow): CanonicalProductionBomOperation {
  return {
    product_sku: row.ProductSKU,
    version: row.Version,
    operation_sequence: row.OperationSequence,
    operation_type: row.OperationType,
    operation_name: row.OperationName || null,
    cycle_time: row.CycleTime ?? null,
    unit_per_cycle: row.UnitPerCycle ?? null,
    work_centre_code: row.WorkCentreCode || null,
    work_centre_name: row.WorkCentreName || null,
    previous_step: row.PreviousStep || null,
  };
}

export function toCanonicalItem(row: ProductionBomCsvRow): CanonicalProductionBomItem {
  return {
    product_sku: row.ProductSKU,
    version: row.Version,
    operation_sequence: row.OperationSequence,
    item_type: row.ItemType,
    item_code: row.ComponentSKU_ResourceCode,
    item_name: row.ComponentName_ResourceName || null,
    quantity: row.Quantity,
    wastage_quantity: row.WastageQuantity_ForStockComponentOnly ?? null,
    wastage_percent: row.WastagePercent_ForStockComponentOnly ?? null,
    cost_allocation_type: row.CostAllocationType || null,
    sales_value: row.SalesValue ?? null,
    cost_of_wastage: row.CostOfWastage ?? null,
    delivery_to_location: row.DeliveryTo_LocationName || null,
    delivery_to_bin: row.DeliveryTo_BinName || null,
    coman_price_tier: row.CoManPriceTier || null,
    tracing: row.Tracing || null,
    issue_method_component: row.IssueMethodComponent || null,
    issue_method_parameter: row.IssueMethodParameter ?? null,
    operation_is_backflush: row.OperationIsBackflush,
    component_is_backflush: row.ComponentIsBackflush,
    resource_cost_type: row.ResourceCostType || null,
  };
}

/** Dedupe version/operation rows (many CSV rows share the same version or operation). */
export function dedupeBy<T, K>(items: T[], keyFn: (item: T) => K): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(JSON.stringify(keyFn(item)), item);
  }
  return [...seen.values()];
}
