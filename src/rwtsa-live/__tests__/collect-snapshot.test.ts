import { describe, expect, it } from "vitest";
import { createReadOnlyClient } from "@/rwtsa-live/client";
import { collectAvailability, collectLocations, collectProducts } from "@/rwtsa-live/collect";
import { buildSnapshot, verifySnapshotIntegrity } from "@/rwtsa-live/snapshot";
import { ACCOUNT, APPKEY, LOC, fakeFetch, noSleep } from "./helpers";

const creds = { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "rwtsa-demo-instance" };
const client = (routes: Parameters<typeof fakeFetch>[0]) => { const f = fakeFetch(routes); return { f, c: createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: noSleep, now: () => 0, minIntervalMs: 0 }) }; };
const LOCS = [{ ID: LOC.JHB, Name: "JHB" }, { ID: LOC.DURBAN, Name: "Durban" }, { ID: LOC.CAPE_TOWN, Name: "Cape Town" }, { ID: LOC.FACTORY_STORE, Name: "Factory Store" }, { ID: LOC.BOND, Name: "Bond" }];
const av = (sku: string, Location: string, OnHand: number, Allocated = 0, extra: Record<string, unknown> = {}) => ({ ID: `p-${sku}`, SKU: sku, Location, Bin: null, Batch: null, OnHand, Allocated, Available: OnHand - Allocated, OnOrder: 0, InTransit: 0, ...extra });

describe("pagination and completeness", () => {
  it("walks every page until a short page and reports COMPLETE when the reported total matches", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => av(`S${i}`, "JHB", 1));
    const { f, c } = client({ "/ref/productavailability": (p) => ({ body: { Total: 2500, Page: p, ProductAvailabilityList: rows.slice((p - 1) * 1000, p * 1000) } }) });
    const r = await collectAvailability(c);
    expect(r.rows).toHaveLength(2500); expect(r.pages).toBe(3); expect(r.complete).toBe(true); expect(f.calls.map((x) => new URL(x.url).searchParams.get("Limit"))).toEqual(["1000", "1000", "1000"]);
  });
  it("flags INCOMPLETE when fewer rows arrive than the reported total (a missing page)", async () => {
    const { c } = client({ "/ref/productavailability": (p) => ({ body: { Total: 1500, ProductAvailabilityList: p === 1 ? Array.from({ length: 1000 }, (_, i) => av(`S${i}`, "JHB", 1)) : [] } }) });
    const r = await collectAvailability(c);
    expect(r.complete).toBe(false); expect(r.problems.join()).toMatch(/total/i);
  });
  it("flags INCOMPLETE when the server repeats a page (a looping cursor) instead of looping forever", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => av(`S${i}`, "JHB", 1));
    const { c } = client({ "/ref/productavailability": () => ({ body: { ProductAvailabilityList: page } }) });
    const r = await collectAvailability(c);
    expect(r.complete).toBe(false); expect(r.problems.join()).toMatch(/repeat/i);
  });
  it("flags a duplicated SKU/location/bin/batch row instead of double counting it", async () => {
    const { c } = client({ "/ref/productavailability": () => ({ body: { ProductAvailabilityList: [av("A", "JHB", 5), av("A", "JHB", 5)] } }) });
    const r = await collectAvailability(c);
    expect(r.complete).toBe(false); expect(r.problems.join()).toMatch(/duplicate/i);
  });
  it("collects products and locations, and records the field names it saw (contract evidence, no values)", async () => {
    const { c } = client({ "/product": () => ({ body: { Total: 1, Products: [{ ID: "1", SKU: "A", Name: "n", UOM: "Each" }] } }), "/ref/location": () => ({ body: { Total: 5, LocationList: LOCS } }) });
    const p = await collectProducts(c); const l = await collectLocations(c);
    expect(p.rows).toHaveLength(1); expect(p.observedFields).toEqual(["ID", "Name", "SKU", "UOM"]); expect(l.rows).toHaveLength(5); expect(l.complete).toBe(true);
  });
});

const snap = async (avRows: unknown[], locs: unknown[] = LOCS, mapOverride = LOC) => {
  const { c } = client({ "/ref/productavailability": () => ({ body: { Total: avRows.length, ProductAvailabilityList: avRows } }), "/ref/location": () => ({ body: { Total: locs.length, LocationList: locs } }), "/product": () => ({ body: { Total: 2, Products: [{ ID: "p-A", SKU: "A" }, { ID: "p-B", SKU: "B" }] } }) });
  return buildSnapshot({ creds, locationMap: mapOverride, locations: await collectLocations(c), availability: await collectAvailability(c), products: await collectProducts(c), takenAt: "2026-11-04T10:00:00.000Z" });
};

describe("snapshot", () => {
  it("separates Bond from unrestricted stock by the verified Bond location ID, and never counts Bond as usable", async () => {
    const s = await snap([av("A", "JHB", 10, 3), av("A", "Bond", 7, 2), av("A", "Durban", 4, 0), av("B", "Bond", 5)]);
    const a = s.stock.find((x) => x.sku === "A")!;
    expect(a.physical).toBe(21); expect(a.bond).toBe(7); expect(a.unrestricted).toBe(14); expect(a.allocatedUnrestricted).toBe(3); expect(a.usable).toBe(11);
    const b = s.stock.find((x) => x.sku === "B")!; expect(b.usable).toBe(0); expect(b.bond).toBe(5);
    expect(s.locationMapping.bond).toMatchObject({ id: LOC.BOND, verifiedInLocationList: true });
  });
  it("sums bins and batches of the same SKU/location once each (no duplicate counting)", async () => {
    const s = await snap([av("A", "JHB", 3, 0, { Bin: "b1" }), av("A", "JHB", 4, 0, { Bin: "b2" })]);
    expect(s.stock[0].physical).toBe(7); expect(s.completeness.status).toBe("COMPLETE");
  });
  it("is INCOMPLETE when the configured Bond ID is not in the account's location list (fail closed, no name guessing)", async () => {
    // No stock row mentions Bond, so the ONLY signal is the unverifiable configured ID.
    const s = await snap([av("A", "JHB", 7)], LOCS.filter((l) => l.ID !== LOC.BOND));
    expect(s.locationMapping.bond.verifiedInLocationList).toBe(false);
    expect(s.completeness.status).toBe("INCOMPLETE"); expect(s.completeness.problems.join()).toMatch(/Bond location ID/);
  });
  it("is INCOMPLETE when two locations share a display name, because the name->ID join would be ambiguous", async () => {
    const s = await snap([av("A", "Bond", 7)], [...LOCS, { ID: "00000000-0000-4000-8000-000000000099", Name: "Bond" }]);
    expect(s.completeness.status).toBe("INCOMPLETE"); expect(s.completeness.problems.join()).toMatch(/ambiguous/i);
  });
  it("reports stock rows at locations outside the five mapped roles instead of silently dropping them", async () => {
    const s = await snap([av("A", "Mystery", 9), av("A", "JHB", 1)], [...LOCS, { ID: "00000000-0000-4000-8000-000000000042", Name: "Mystery" }]);
    expect(s.locationMapping.unmappedLocationCount).toBe(1); expect(s.stock[0].unmapped).toBe(9); expect(s.stock[0].usable).toBe(1);
  });
  it("is INCOMPLETE if a stock row names a location that is not in the location list", async () => {
    const s = await snap([av("A", "Nowhere", 9)]);
    expect(s.completeness.status).toBe("INCOMPLETE");
  });
  it("carries provenance and counts, and contains no credential material", async () => {
    const s = await snap([av("A", "JHB", 1)]);
    expect(s.source).toMatchObject({ instanceLabel: "rwtsa-demo-instance", apiOrigin: "https://inventory.dearsystems.com/ExternalApi/v2" });
    expect(s.endpoints.map((e) => e.path).sort()).toEqual(["/product", "/ref/location", "/ref/productavailability"]);
    expect(s.counts).toMatchObject({ availabilityRows: 1, skus: 1, locations: 5, products: 2 });
    const text = JSON.stringify(s); expect(text).not.toContain(ACCOUNT); expect(text).not.toContain(APPKEY);
  });
  it("detects tampering through the content hash", async () => {
    const s = await snap([av("A", "JHB", 1)]);
    expect(verifySnapshotIntegrity(s)).toBe(true);
    expect(verifySnapshotIntegrity({ ...s, stock: s.stock.map((x) => ({ ...x, physical: x.physical + 1 })) })).toBe(false);
  });
});

describe("fail closed on schema drift and silent zeros (independent review P1)", () => {
  it("is INCOMPLETE when Cin7 reports no total (completeness cannot be confirmed)", async () => {
    const { c } = client({ "/ref/productavailability": () => ({ body: { ProductAvailabilityList: [av("A", "JHB", 1)] } }) });
    const r = await collectAvailability(c); expect(r.complete).toBe(false); expect(r.problems.join()).toMatch(/did not report a total/i);
  });
  it("is INCOMPLETE for an empty availability list or a missing list key, never an all-zero COMPLETE snapshot", async () => {
    for (const body of [{ Total: 0, ProductAvailabilityList: [] }, { Total: 3, SomethingElse: [{ x: 1 }] }]) {
      const { c } = client({ "/ref/productavailability": () => ({ body }) });
      expect((await collectAvailability(c)).complete).toBe(false);
    }
  });
  it("is INCOMPLETE when the expected stock fields are not among the observed fields", async () => {
    const { c } = client({ "/ref/productavailability": () => ({ body: { Total: 1, ProductAvailabilityList: [{ SKU: "A", Location: "JHB", QtyOnHand: 5 }] } }) });
    expect((await collectAvailability(c)).problems.join()).toMatch(/OnHand/);
  });
  it("is INCOMPLETE when a quantity is not a number or a row has no SKU (counted, never silently zero)", async () => {
    const s = await snap([av("A", "JHB", 1), { ...av("B", "JHB", 1), OnHand: "7" }, { ...av("", "JHB", 4), SKU: "" }]);
    expect(s.completeness.status).toBe("INCOMPLETE"); expect(s.completeness.problems.join()).toMatch(/non-numeric/i); expect(s.completeness.problems.join()).toMatch(/no SKU/i);
  });
  it("detects a server that caps the page size below the request (short first page, larger total)", async () => {
    const { c } = client({ "/product": (p) => ({ body: { Total: 900, Products: p === 1 ? Array.from({ length: 100 }, (_, i) => ({ ID: `p${i}`, SKU: `S${i}` })) : [] } }) });
    const r = await collectProducts(c); expect(r.complete).toBe(false);
  });
  it("detects duplicate location IDs and duplicate product IDs", async () => {
    const { c } = client({ "/ref/location": () => ({ body: { Total: 2, LocationList: [{ ID: LOC.JHB, Name: "A" }, { ID: LOC.JHB, Name: "B" }] } }), "/product": () => ({ body: { Total: 2, Products: [{ ID: "1", SKU: "A" }, { ID: "1", SKU: "A" }] } }) });
    expect((await collectLocations(c)).problems.join()).toMatch(/duplicate/i); expect((await collectProducts(c)).problems.join()).toMatch(/duplicate/i);
  });
});
