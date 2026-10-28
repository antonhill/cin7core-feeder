// Acceptance fixtures: the three known unresolved cases of the demo quotation (M75 feed system = flex_auger, PP penning by the running metre =
// penning_package, FORTIS LED lighting = led_light). The SKUs used below are TEST FIXTURES, labelled as such: no real SKU is invented or assumed.
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import type { BaselineCommercialLine } from "@/newquip/quote/baseline";
import { applyResolution, effectiveScope, packageKeyOf } from "../product-scope";
import { saveMappingVersion } from "../package-mapping-store";

const line = (itemKey: string, label: string, quantity: number, pricedBy: "penning_rate" | "estimator" | "workbook"): BaselineCommercialLine =>
  ({ itemKey, label, sku: null, quantity, unitPriceExVat: 100, revenueCents: quantity * 10_000, pricedBy: pricedBy as never, note: "" });
const QUOTE = [line("flex_auger", "M75 feed distribution system", 1, "estimator"), line("penning_package", "PP penning (per running metre)", 240, "penning_rate"), line("led_light", "FORTIS LED lighting", 38, "workbook")];
const at = "2026-10-28T10:00:00Z";
const okPort = { resolveProducts: async () => ({ missing: [] as string[] }) };

describe("acceptance: M75, PP penning and FORTIS LED resolve into real physical scope without inventing SKUs", () => {
  it("the approved quotation keeps them UNMAPPED (approval is not blocked), and Sale creation is blocked until each is resolved", () => {
    const scope = buildPhysicalScope(QUOTE);
    expect(scope.map((i) => i.mapping.status)).toEqual(["UNMAPPED", "UNMAPPED", "UNMAPPED"]);
    expect(scope.every((i) => i.sku === null)).toBe(true); // nothing invented
    const eff = effectiveScope(scope);
    expect(eff.lines).toEqual([]);
    expect(eff.blockers).toHaveLength(3); // these block the Cin7 Sale, not the quotation
    expect(scope.map(packageKeyOf)).toEqual(["flex_auger", "penning_package", "led_light"]);
  });
  it("resolving each (multi-SKU, unit conversion, BOM reference) unblocks the Sale with exact quantities; an audited exclusion also unblocks", () => {
    let items = buildPhysicalScope(QUOTE);
    const step = (itemId: string, r: Parameters<typeof applyResolution>[1] extends infer T ? Omit<Extract<T, object>, "itemId" | "by" | "at" | "reason"> : never) => {
      const res = applyResolution(items, { itemId, reason: "BOM sheet", by: "m@x", at, ...(r as object) } as never);
      if (!res.ok) throw new Error(res.error);
      items = res.items;
    };
    step("flex_auger:UNMAPPED", { kind: "MAP_LINES", lines: [{ sku: "TEST-M75-SYSTEM", factor: 1 }, { sku: "TEST-M75-MOTOR", factor: 2, role: "BOM_COMPONENT" }] } as never);
    step("penning_package:UNMAPPED", { kind: "MAP_LINES", lines: [{ sku: "TEST-PEN-ROLL", factor: 0.05, unit: "20 m roll" }, { sku: "TEST-PEN-POST", factor: 0.5, unit: "each" }] } as never);
    step("led_light:UNMAPPED", { kind: "EXCLUDE" } as never);
    const eff = effectiveScope(items);
    expect(eff.blockers).toEqual([]);
    expect(eff.lines.map((l) => [l.sku, l.quantity])).toEqual([["TEST-M75-SYSTEM", 1], ["TEST-PEN-ROLL", 12], ["TEST-PEN-POST", 120]]);
    expect(eff.referenceOnly.map((r) => [r.sku, r.quantity])).toEqual([["TEST-M75-MOTOR", 2]]); // internal component: never a Sale line, never double counted
    expect(eff.excluded.map((e) => e.id)).toEqual(["led_light:UNMAPPED"]);
    expect(items.every((i) => i.origin.label.length > 0)).toBe(true); // source package/section preserved on every resolved item
  });
  it("an item resolved from a saved version records where it came from, and stays frozen", () => {
    const items = buildPhysicalScope(QUOTE);
    const res = applyResolution(items, { itemId: "penning_package:UNMAPPED", kind: "MAP_LINES", lines: [{ sku: "TEST-PEN-ROLL", factor: 0.05 }], mappingRef: { packageKey: "penning_package", version: 3 }, reason: "saved v3", by: "m@x", at });
    if (!res.ok) throw new Error(res.error);
    const resolved = res.items.find((i) => i.id === "penning_package:UNMAPPED")!;
    expect(resolved.resolution).toMatchObject({ kind: "MAP_LINES", mappingRef: { packageKey: "penning_package", version: 3 } });
    // a later saved version cannot change it: an already-resolved item refuses a second resolution
    expect(applyResolution(res.items, { itemId: "penning_package:UNMAPPED", kind: "MAP_LINES", lines: [{ sku: "TEST-OTHER", factor: 1 }], reason: "v4", by: "m@x", at })).toMatchObject({ ok: false });
  });
});

describe("saving a reusable mapping version", () => {
  const input = { orgId: "o", packageKey: "penning_package", lines: [{ sku: "TEST-PEN-ROLL", factor: 0.05, unit: "20 m roll" }], reason: "per BOM sheet" };
  it("is manager-only, needs a reason, valid lines, and SKUs that exist in Cin7 (checked before anything is stored)", async () => {
    const db = new FakeDb();
    const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
    expect(await err(saveMappingVersion(db as never, okPort, { isManager: false }, "m@x", input))).toMatch(/Only a manager/);
    expect(await err(saveMappingVersion(db as never, okPort, { isManager: true }, "m@x", { ...input, reason: " " }))).toMatch(/reason/);
    expect(await err(saveMappingVersion(db as never, okPort, { isManager: true }, "m@x", { ...input, packageKey: " " }))).toMatch(/package key/);
    expect(await err(saveMappingVersion(db as never, okPort, { isManager: true }, "m@x", { ...input, lines: [] }))).toMatch(/at least one/);
    expect(await err(saveMappingVersion(db as never, okPort, { isManager: true }, "m@x", { ...input, lines: [{ sku: "A", factor: 1, role: "BOM_COMPONENT" }] }))).toMatch(/finished good/);
    expect(await err(saveMappingVersion(db as never, { resolveProducts: async () => ({ missing: ["TEST-PEN-ROLL"] }) }, { isManager: true }, "m@x", input))).toMatch(/does not exist in Cin7/);
    expect(db.rows("newquip_package_mappings")).toHaveLength(0);
  });
  it("stores the lines and leaves version numbering to the database (never trusted from the caller)", async () => {
    const db = new FakeDb();
    await saveMappingVersion(db as never, okPort, { isManager: true }, "m@x", input);
    const row = db.rows("newquip_package_mappings")[0];
    expect(row).toMatchObject({ org_id: "o", package_key: "penning_package", created_by_email: "m@x", reason: "per BOM sheet", lines: [{ sku: "TEST-PEN-ROLL", factor: 0.05, unit: "20 m roll", role: "FINISHED_GOOD" }] });
    expect(row).not.toHaveProperty("version");
  });
});
