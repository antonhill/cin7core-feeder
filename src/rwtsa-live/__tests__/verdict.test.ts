import { describe, expect, it } from "vitest";
import { contractVerdict } from "@/rwtsa-live/verdict";
import type { Snapshot } from "@/rwtsa-live/snapshot";

const good = (): Snapshot => ({
  schemaVersion: 1, takenAt: "t", source: { instanceLabel: "i", apiOrigin: "https://inventory.dearsystems.com/ExternalApi/v2", method: "GET", readOnly: true, identity: { status: "VERIFIED", fingerprint: "f", locationCount: 5, accountIdSha256: "a" } },
  verification: { methodsUsed: ["GET"], requests: 4, fieldTypes: { SKU: "string", Location: "string", OnHand: "number", Allocated: "number", Available: "number", OnOrder: "number", InTransit: "number" }, skuLocationDuplicatesFound: 0 },
  endpoints: [{ path: "/ref/location", pages: 1, records: 5, reportedTotal: 5, complete: true }, { path: "/ref/productavailability", pages: 2, records: 1500, reportedTotal: 1500, complete: true }, { path: "/product", pages: 1, records: 40, reportedTotal: 40, complete: true }],
  contract: { availabilityFields: [], locationFields: [], productFields: [] }, completeness: { status: "COMPLETE", problems: [] },
  locationMapping: { bond: { id: "b", verifiedInLocationList: true, observedName: "Bond" }, roles: {}, unmappedLocationCount: 0, joinKey: "location name, unique within this snapshot's location list, resolved to the verified ID" },
  counts: { products: 40, locations: 5, availabilityRows: 1500, skus: 48 }, stock: [], contentHash: "x",
});
const fail = (s: Snapshot) => contractVerdict(s).checks.filter((c) => !c.pass).map((c) => c.name);

describe("API contract verdict", () => {
  it("PASS only when every check passes", () => { const v = contractVerdict(good()); expect(v.overall).toBe("PASS"); expect(v.checks.length).toBeGreaterThanOrEqual(10); });
  it("FAILS when identity is not verified", () => { const s = good(); s.source.identity.status = "NOT_APPROVED"; expect(fail(s)).toContain("account identity"); expect(contractVerdict(s).overall).toBe("FAIL"); });
  it("FAILS when the Bond ID is not verified in the location list", () => { const s = good(); s.locationMapping.bond.verifiedInLocationList = false; expect(fail(s)).toContain("Bond location ID"); });
  it("FAILS when a required quantity field is missing or not numeric", () => {
    for (const f of ["OnHand", "Allocated", "Available", "OnOrder", "InTransit"]) { const s = good(); delete s.verification.fieldTypes[f]; expect(fail(s), f).toContain("stock quantity fields"); const t = good(); t.verification.fieldTypes[f] = "string"; expect(fail(t), f).toContain("stock quantity fields"); }
  });
  it("FAILS on any method other than GET, or a snapshot that does not declare read-only", () => { const s = good(); s.verification.methodsUsed = ["GET", "POST"]; expect(fail(s)).toContain("GET only, no writes"); const t = good(); t.source.readOnly = false as never; expect(fail(t)).toContain("GET only, no writes"); });
  it("FAILS on duplicates, an incomplete endpoint, a total mismatch, or a missing reported total", () => {
    const d = good(); d.verification.skuLocationDuplicatesFound = 1; expect(fail(d)).toContain("SKU/location uniqueness");
    const i = good(); i.endpoints[1].complete = false; expect(fail(i)).toContain("pagination");
    const m = good(); m.endpoints[1].records = 1400; expect(fail(m)).toContain("pagination");
    const n = good(); n.endpoints[1].reportedTotal = null; expect(fail(n)).toContain("pagination");
  });
  it("FAILS when the products endpoint returned nothing or is incomplete", () => {
    const e = good(); e.endpoints[2].records = 0; e.endpoints[2].reportedTotal = 0; expect(fail(e)).toContain("products endpoint");
    const m = good(); m.endpoints = m.endpoints.filter((x) => x.path !== "/product"); expect(fail(m)).toContain("products endpoint");
  });
  it("FAILS when the snapshot is INCOMPLETE", () => { const s = good(); s.completeness.status = "INCOMPLETE"; expect(fail(s)).toContain("completeness"); });
  it("the Bond classification check requires Bond stock to be excluded from usable stock", () => {
    const s = good(); s.stock = [{ sku: "A", byRole: {}, physical: 10, bond: 4, unrestricted: 6, allocatedUnrestricted: 1, usable: 5, unmapped: 0, reportedAvailable: 0, onOrder: 0, inTransit: 0 }]; expect(contractVerdict(s).overall).toBe("PASS");
    s.stock[0].usable = 9; expect(fail(s)).toContain("Bond classification");
  });
});
