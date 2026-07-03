import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CanonicalProductionBomVersionRow {
  product_sku: string;
  version: string;
  version_name: string | null;
  quantity_to_produce: number;
}

export interface CanonicalProductionBomOperationRow {
  operation_sequence: string;
  operation_type: string;
  operation_name: string | null;
  cycle_time: number | null;
  work_centre_code: string | null;
}

export interface CanonicalProductionBomItemRow {
  operation_sequence: string;
  item_type: "Component" | "Resource";
  item_code: string;
  quantity: number;
}

interface Cin7ProductionBomListResponse {
  ProductionBOMs?: { Version?: string }[];
}

interface Cin7ProductionBomResponse {
  ID?: string;
}

/**
 * Field names here are the LEAST verified of the three payload mappings —
 * Cin7's docs confirmed the ProductionBom resource's CRUD shape (GET/POST/
 * PUT/DELETE at product/product-family level) but not its exact field
 * schema. Treat this as a starting point to correct against a live sandbox
 * (400 responses should name the expected fields) before relying on it.
 * See docs/cin7-api-findings.md.
 */
export function toCin7ProductionBomPayload(
  version: CanonicalProductionBomVersionRow,
  operations: CanonicalProductionBomOperationRow[],
  items: CanonicalProductionBomItemRow[]
) {
  return {
    SKU: version.product_sku,
    Version: version.version,
    VersionName: version.version_name ?? undefined,
    QuantityToProduce: version.quantity_to_produce,
    OverwriteExistingProductionBOM: true,
    Operations: operations.map((op) => ({
      OperationSequence: op.operation_sequence,
      OperationType: op.operation_type,
      OperationName: op.operation_name ?? undefined,
      CycleTime: op.cycle_time ?? undefined,
      WorkCentreCode: op.work_centre_code ?? undefined,
      Components: items
        .filter((i) => i.operation_sequence === op.operation_sequence && i.item_type === "Component")
        .map((i) => ({ ComponentSKU: i.item_code, Quantity: i.quantity })),
      Resources: items
        .filter((i) => i.operation_sequence === op.operation_sequence && i.item_type === "Resource")
        .map((i) => ({ ResourceCode: i.item_code, Quantity: i.quantity })),
    })),
  };
}

async function findProductionBomVersion(creds: Cin7Credentials, sku: string, version: string): Promise<boolean> {
  const response = await cin7Request<Cin7ProductionBomListResponse>(creds, "/ProductionBom", {
    query: { SKU: sku },
  });
  return (response.ProductionBOMs ?? []).some((v) => v.Version === version);
}

export type ProductionBomPushStatus = "created" | "updated";

export async function pushProductionBom(
  creds: Cin7Credentials,
  version: CanonicalProductionBomVersionRow,
  operations: CanonicalProductionBomOperationRow[],
  items: CanonicalProductionBomItemRow[]
): Promise<{ status: ProductionBomPushStatus }> {
  const payload = toCin7ProductionBomPayload(version, operations, items);
  const exists = await findProductionBomVersion(creds, version.product_sku, version.version);

  await cin7Request<Cin7ProductionBomResponse>(creds, "/ProductionBom", {
    method: exists ? "PUT" : "POST",
    body: payload,
  });

  return { status: exists ? "updated" : "created" };
}
