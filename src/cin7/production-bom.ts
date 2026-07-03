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
  unit_per_cycle: number | null;
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
 * Path and addressing confirmed 2026-07-03 against a primary-source
 * transcription of Cin7's Apiary spec (github.com/nnhansg/dear-openapi,
 * specification/dearinventory.apib): the resource lives at
 * `/production/productionBOM` (nested, camelCase — NOT `/ProductionBom`,
 * which returns an HTML fallback page rather than a 404), and it's
 * addressed by the product's Cin7 **ID** (GUID), not SKU. The exact body
 * field names for operations/routing/work-centres/resources below are
 * still best-effort — only the path and ID-based addressing are confirmed.
 * See docs/cin7-api-findings.md.
 */
const PRODUCTION_BOM_PATH = "/production/productionBOM";

export function toCin7ProductionBomPayload(
  cin7ProductId: string,
  version: CanonicalProductionBomVersionRow,
  operations: CanonicalProductionBomOperationRow[],
  items: CanonicalProductionBomItemRow[]
) {
  return {
    ProductID: cin7ProductId,
    Version: version.version,
    VersionName: version.version_name ?? undefined,
    QuantityToProduce: version.quantity_to_produce,
    // Confirmed via a live 400 ("Required property 'OutputQuantity' not
    // found") — kept alongside QuantityToProduce since it's unclear if the
    // latter is also used elsewhere, and extra fields are harmless.
    OutputQuantity: version.quantity_to_produce,
    OverwriteExistingProductionBOM: true,
    // Confirmed via live 400s ("Required property 'Position'/'Order'/
    // 'UnitsPerCycle' not found") on Operations, Components, and Resources —
    // each needs its ordinal index (Position) plus an explicit Order,
    // separate from our semantic OperationSequence.
    Operations: operations.map((op, opIndex) => ({
      Position: opIndex + 1,
      Order: opIndex + 1,
      OperationSequence: op.operation_sequence,
      OperationType: op.operation_type,
      OperationName: op.operation_name ?? undefined,
      CycleTime: op.cycle_time ?? undefined,
      UnitsPerCycle: op.unit_per_cycle ?? undefined,
      WorkCentreCode: op.work_centre_code ?? undefined,
      Components: items
        .filter((i) => i.operation_sequence === op.operation_sequence && i.item_type === "Component")
        .map((i, idx) => ({ Position: idx + 1, ComponentSKU: i.item_code, Quantity: i.quantity })),
      Resources: items
        .filter((i) => i.operation_sequence === op.operation_sequence && i.item_type === "Resource")
        .map((i, idx) => ({ Position: idx + 1, ResourceCode: i.item_code, Quantity: i.quantity })),
    })),
  };
}

async function findProductionBomVersion(creds: Cin7Credentials, cin7ProductId: string, version: string): Promise<boolean> {
  const response = await cin7Request<Cin7ProductionBomListResponse>(creds, PRODUCTION_BOM_PATH, {
    query: { ProductID: cin7ProductId },
  });
  return (response.ProductionBOMs ?? []).some((v) => v.Version === version);
}

export type ProductionBomPushStatus = "created" | "updated";

/**
 * Pushes one Production BOM version. Requires the product's Cin7 ID (GUID)
 * — the product must already have been synced (and have a cin7_id on
 * record) before its Production BOM can be pushed.
 */
export async function pushProductionBom(
  creds: Cin7Credentials,
  cin7ProductId: string,
  version: CanonicalProductionBomVersionRow,
  operations: CanonicalProductionBomOperationRow[],
  items: CanonicalProductionBomItemRow[]
): Promise<{ status: ProductionBomPushStatus }> {
  const payload = toCin7ProductionBomPayload(cin7ProductId, version, operations, items);
  const exists = await findProductionBomVersion(creds, cin7ProductId, version.version);

  // Confirmed via a live 400 ("Required attribute ProductionBOMs is not
  // provided"): the request body must be wrapped in a ProductionBOMs array,
  // not a flat object — the endpoint apparently supports batching like
  // /BillOfMaterials does.
  await cin7Request<Cin7ProductionBomResponse>(creds, PRODUCTION_BOM_PATH, {
    method: exists ? "PUT" : "POST",
    body: { ProductionBOMs: [payload] },
  });

  return { status: exists ? "updated" : "created" };
}
