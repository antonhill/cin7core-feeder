import { readyDraft } from "./golden";

/** The synced Cin7 catalogue rows the golden draft's confirmed mappings point at, so a fixture quote can pass the sign-off mapping check. */
export function seedGoldenCatalogue(db: { rows(table: string): Array<Record<string, unknown>> }, orgId: string, extra: Array<{ sku: string; active?: boolean }> = []): void {
  const skus = new Set([...Object.values(readyDraft().estimator.confirmedMappings), ...extra.map((e) => e.sku)]);
  if (!db.rows("newquip_package_mappings").some((m) => m.org_id === orgId)) seedGoldenLibrary(db, orgId);
  for (const sku of skus) {
    if (!sku) continue;
    const override = extra.find((e) => e.sku === sku);
    db.rows("products").push({ org_id: orgId, sku, name: sku, active: override?.active ?? true });
  }
}

/**
 * UX-006 S3: an Estimator-priced system without a Cin7 SKU (M75, penning) needs the Manager's recorded baseline exception, and a typed-price package (LED) must be mapped, before a
 * quotation can be approved. The golden quotation has all three, so a fixture that is not ABOUT that rule maps them in the reusable library (like a real estimator would). Use
 * `managerExceptionOpts` (baseline-exception-fixture) instead when the test is about the exception itself.
 */
export function seedGoldenLibrary(db: { rows(table: string): Array<Record<string, unknown>> }, orgId: string): void {
  const one = (key: string, sku: string) => ({ id: `map-${key}`, org_id: orgId, package_key: key, version: 1, status: "ACTIVE", lines: [{ sku, factor: 1, unit: "each", role: "FINISHED_GOOD" }], reason: "fixture", created_by_email: "fixture@nq", created_at: "2026-01-01T00:00:00.000Z", superseded_at: null });
  db.rows("newquip_package_mappings").push(one("flex_auger", "FIXTURE-M75"), one("penning_package", "FIXTURE-PENNING"), one("led_light", "FIXTURE-LED"));
}

/** The same three mappings as a pure library, for fixtures that call `buildAcceptedBaseline` directly (pass as `mappingLibrary`). */
export const GOLDEN_LIBRARY: ReadonlyMap<string, { packageKey: string; version: number; lines: Array<{ sku: string; factor: number; unit: string; role: "FINISHED_GOOD" }> }> = new Map(
  [["flex_auger", "FIXTURE-M75"], ["penning_package", "FIXTURE-PENNING"], ["led_light", "FIXTURE-LED"]].map(([k, sku]) => [k, { packageKey: k, version: 1, lines: [{ sku, factor: 1, unit: "each", role: "FINISHED_GOOD" as const }] }]),
);
