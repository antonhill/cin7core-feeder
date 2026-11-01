import { readyDraft } from "./golden";

/** The synced Cin7 catalogue rows the golden draft's confirmed mappings point at, so a fixture quote can pass the sign-off mapping check. */
export function seedGoldenCatalogue(db: { rows(table: string): Array<Record<string, unknown>> }, orgId: string, extra: Array<{ sku: string; active?: boolean }> = []): void {
  const skus = new Set([...Object.values(readyDraft().estimator.confirmedMappings), ...extra.map((e) => e.sku)]);
  for (const sku of skus) {
    if (!sku) continue;
    const override = extra.find((e) => e.sku === sku);
    db.rows("products").push({ org_id: orgId, sku, name: sku, active: override?.active ?? true });
  }
}
