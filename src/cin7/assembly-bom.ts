import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CanonicalAssemblyBomLineRow {
  product_sku: string;
  component_sku: string;
  quantity: number;
  wastage_quantity: number | null;
  wastage_percent: number | null;
  cost_percentage: number | null;
  price_tier: string | null;
  expense_account: string | null;
}

interface Cin7BomBatchResultItem {
  SKU?: string;
  OperationStatus?: string;
  Errors?: unknown[];
}

interface Cin7BomBatchResponse {
  BillOfMaterialsList?: Cin7BomBatchResultItem[];
}

// Cin7's documented batch limit for PUT /BillOfMaterials.
const MAX_PER_BATCH = 100;

/**
 * A line with PriceTier/ExpenseAccount set is a service line (per the
 * AssemblyBOM CSV template's *_ForServiceComponentOnly columns); otherwise
 * it's a stock component. Field names in the payload below are a best-effort
 * guess — verify against a live sandbox and correct per docs/cin7-api-findings.md.
 */
function isServiceLine(line: CanonicalAssemblyBomLineRow): boolean {
  return Boolean(line.price_tier || line.expense_account);
}

export function toCin7BomPayload(productSku: string, lines: CanonicalAssemblyBomLineRow[]) {
  const components = lines
    .filter((l) => !isServiceLine(l))
    .map((l) => ({
      ComponentSKU: l.component_sku,
      Quantity: l.quantity,
      Wastage: l.wastage_quantity ?? undefined,
      WastagePercentage: l.wastage_percent ?? undefined,
      CostAllocationPercentage: l.cost_percentage ?? undefined,
    }));
  const services = lines
    .filter(isServiceLine)
    .map((l) => ({
      ServiceName: l.component_sku,
      Quantity: l.quantity,
      PriceTier: l.price_tier ?? undefined,
      ExpenseAccount: l.expense_account ?? undefined,
    }));
  return { SKU: productSku, BOMComponents: components, BOMServices: services };
}

export interface BomPushResult {
  productSku: string;
  ok: boolean;
  error?: string;
}

/** Pushes Assembly BOMs in batches of up to 100 products per Cin7's documented limit. */
export async function pushAssemblyBoms(
  creds: Cin7Credentials,
  linesByProduct: Map<string, CanonicalAssemblyBomLineRow[]>
): Promise<BomPushResult[]> {
  const entries = [...linesByProduct.entries()];
  const results: BomPushResult[] = [];

  for (let i = 0; i < entries.length; i += MAX_PER_BATCH) {
    const batch = entries.slice(i, i + MAX_PER_BATCH);
    const payload = batch.map(([sku, lines]) => toCin7BomPayload(sku, lines));
    const response = await cin7Request<Cin7BomBatchResponse>(creds, "/BillOfMaterials", {
      method: "PUT",
      body: payload,
    });

    const bySku = new Map((response.BillOfMaterialsList ?? []).map((r) => [r.SKU, r]));
    for (const [sku] of batch) {
      const item = bySku.get(sku);
      const failed = item?.OperationStatus?.toLowerCase() === "failed";
      results.push({ productSku: sku, ok: !failed, error: failed ? JSON.stringify(item?.Errors ?? item) : undefined });
    }
  }
  return results;
}
