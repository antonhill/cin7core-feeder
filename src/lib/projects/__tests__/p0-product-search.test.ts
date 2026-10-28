// REGRESSION: "No products with free stock at MSTR match" for NQCP137 (10A 24V MOD Battery Charger, 1,000 available at MSTR).
// Root cause: the search read the WHOLE org's MSTR stock cache with no filter and no paging, and Supabase silently returns only the first 1,000
// rows of an unpaged read. MSTR holds >12,000 cache rows, so NQCP137 was never among the rows the code filtered.
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { createP0Project, searchProductStock, searchStockedProducts } from "../p0-project-store";
import { goldenFixtureBaseline } from "../baseline";
import { createProjectFromBaseline } from "../project-store";
import { OPERATIONAL_CUSTOMER_DENYLIST } from "@/newquip/access";
import { P0_DEFAULT_SCHEDULE } from "../p0-project";

const ORG = "org-a";
const row = (sku: string, name: string, location: string, available: number | null, over: Record<string, unknown> = {}) =>
  ({ org_id: ORG, product_sku: sku, product_name: name, location, on_hand: available, available, synced_at: "2026-10-28T14:53:53Z", ...over });

/** A cache shaped like the real one: thousands of MSTR rows sorting BEFORE the target ("A…") so a 1,000-row prefix can never contain it. */
function bigCache(db: FakeDb) {
  db.maxRows = 1000; // Supabase's silent cap on an unpaged read
  for (let i = 0; i < 2500; i++) db.rows("product_availability").push(row(`A${String(i).padStart(5, "0")}`, `Filler product ${i}`, "MSTR", 5));
  for (let i = 0; i < 40; i++) db.rows("product_availability").push(row(`NQCP${200 + i}`, `Charger variant ${i}`, "MSTR", 3));
  db.rows("product_availability").push(row("NQCP137", "10A 24V MOD Battery Charger", "MSTR", 1000));
  db.rows("product_availability").push(row("NQCP137", "10A 24V MOD Battery Charger", "PROJ", 7));
  for (let i = 0; i < 2500; i++) db.rows("product_availability").push(row(`Z${String(i).padStart(5, "0")}`, `Tail product ${i}`, "MSTR", 5));
  db.rows("product_availability").push({ ...row("NQCP137", "foreign org copy", "MSTR", 9999), org_id: "org-b" });
}

describe("NQCP137 is found in a large stock cache", () => {
  it("REPRODUCTION: the old unpaged, unfiltered read of MSTR returns exactly 1,000 rows and NQCP137 is not among them", async () => {
    const db = new FakeDb(); bigCache(db);
    const old = (await db.from("product_availability").select().eq("org_id", ORG).eq("location", "MSTR")) as unknown as { data: Array<{ product_sku: string }> };
    expect(old.data).toHaveLength(1000);
    expect(old.data.some((r) => r.product_sku === "NQCP137")).toBe(false);
  });
  it("exact SKU: returns the product with its MSTR free stock, ranked first", async () => {
    const db = new FakeDb(); bigCache(db);
    const r = await searchProductStock(db as never, ORG, "MSTR", "NQCP137");
    expect(r.outcome).toBe("FOUND");
    expect(r.products).toEqual([{ sku: "NQCP137", name: "10A 24V MOD Battery Charger", available: 1000, onHand: 1000, syncedAt: "2026-10-28T14:53:53Z" }]);
  });
  it("is case-insensitive, and partial SKU, description and word matches all find it; an exact SKU outranks a prefix match", async () => {
    const db = new FakeDb(); bigCache(db);
    for (const q of ["nqcp137", "NQCP13", "battery charger", "24v mod", "MOD Battery"]) expect((await searchStockedProducts(db as never, ORG, "MSTR", q)).map((p) => p.sku), q).toContain("NQCP137");
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "NQCP13")).map((p) => p.sku)).toEqual(["NQCP137"]);
    const prefix = await searchStockedProducts(db as never, ORG, "MSTR", "NQCP", 100);
    expect(prefix).toHaveLength(41);
    expect(prefix[0].sku).toBe("NQCP137"); // most free stock first among prefix matches
  });
  it("does not use another location's or another organisation's stock", async () => {
    const db = new FakeDb(); bigCache(db);
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "NQCP137"))[0].available).toBe(1000); // not 1007, not 10999
    expect((await searchStockedProducts(db as never, ORG, "PROJ", "NQCP137"))[0].available).toBe(7);
  });
  it("the unfiltered listing still works over the large cache (most stock first)", async () => {
    const db = new FakeDb(); bigCache(db);
    const all = await searchStockedProducts(db as never, ORG, "MSTR", "");
    expect(all[0]).toMatchObject({ sku: "NQCP137", available: 1000 });
  });
  it("sums batch/bin rows of one SKU at the location", async () => {
    const db = new FakeDb(); db.rows("product_availability").push(row("X1", "Split", "MSTR", 4, { bin: "A" }), row("X1", "Split", "MSTR", 6, { bin: "B" }));
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "X1"))[0]).toMatchObject({ available: 10, onHand: 10 });
  });
});

describe("the reason is stated: not found vs no stock vs elsewhere vs lookup failure", () => {
  const db = new FakeDb();
  db.rows("product_availability").push(row("HASSTOCK", "In stock", "MSTR", 4), row("ZEROSTOCK", "Out of stock", "MSTR", 0), row("NULLSTOCK", "Unknown stock", "MSTR", null), row("ELSE", "Elsewhere only", "PROJ", 12));
  it("SKU not in the catalogue at all", async () => {
    const r = await searchProductStock(db as never, ORG, "MSTR", "NOPE999");
    expect(r).toMatchObject({ outcome: "NOT_IN_CATALOGUE", products: [] }); expect(r.detail).toMatch(/No synced product/);
  });
  it("exists but has no free stock at the location (zero or unknown)", async () => {
    for (const q of ["ZEROSTOCK", "NULLSTOCK"]) expect(await searchProductStock(db as never, ORG, "MSTR", q)).toMatchObject({ outcome: "NO_STOCK_AT_LOCATION", products: [] });
  });
  it("exists, but its stock is at another location", async () => {
    const r = await searchProductStock(db as never, ORG, "MSTR", "ELSE");
    expect(r).toMatchObject({ outcome: "OTHER_LOCATIONS_ONLY", otherLocations: [{ location: "PROJ", available: 12 }] }); expect(r.detail).toMatch(/PROJ 12/);
  });
  it("a database failure throws - it is never reported as 'no products'", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ or: () => ({ order: () => ({ order: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) }) }) }) }) };
    await expect(searchProductStock(broken as never, ORG, "MSTR", "NQCP137")).rejects.toThrow(/search products: boom/);
  });
  it("a missing location is refused; special characters in the text are literal, not wildcards", async () => {
    await expect(searchProductStock(db as never, ORG, " ", "x")).rejects.toThrow(/location/);
    expect((await searchProductStock(db as never, ORG, "MSTR", "%")).outcome).toBe("NOT_IN_CATALOGUE");
    expect((await searchProductStock(db as never, ORG, "MSTR", "_")).outcome).toBe("NOT_IN_CATALOGUE");
    expect((await searchProductStock(db as never, ORG, "MSTR", "a,b)(")).outcome).toBe("NOT_IN_CATALOGUE");
  });
});

describe("quantity 1 of NQCP137 can be prepared as a disposable P0 project (read-only, safety checks kept)", () => {
  const port = {
    resolveProducts: async (s: string[]) => ({ ids: new Map(s.filter((k) => k === "NQCP137").map((k) => [k, "id"])), missing: s.filter((k) => k !== "NQCP137") }),
    stockAt: async (k: string) => (k === "NQCP137" ? [{ location: "MSTR", available: 1000 }] : []),
  };
  const make = (db: FakeDb, products = [{ sku: "NQCP137", name: "10A 24V MOD Battery Charger", quantity: 1 }], gates = { isManager: true }) =>
    createP0Project(db as never, port, gates, "m@x", OPERATIONAL_CUSTOMER_DENYLIST, { orgId: ORG, location: "MSTR", customerName: "NQ P0 Test Customer", contractRands: "100000", schedule: P0_DEFAULT_SCHEDULE.map((x) => ({ ...x })), products, now: new Date("2026-10-28T10:00:00Z") } as never);
  it("creates the project with quantity 1 at R0 and touches nothing else", async () => {
    const db = new FakeDb(); const demo = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "Demo" });
    const before = JSON.stringify(db.rows("projects").find((p) => p.id === demo));
    const r = await make(db);
    const snap = db.rows("projects").find((p) => p.id === r.projectId)!.baseline_snapshot as { lines: Array<{ sku: string; quantity: number; salesValueCents: number }> };
    expect(snap.lines).toMatchObject([{ sku: "NQCP137", quantity: 1, salesValueCents: 0 }]);
    expect(JSON.stringify(db.rows("projects").find((p) => p.id === demo))).toBe(before);
    expect(db.rows("project_cin7_sale_links")).toHaveLength(0);
  });
  it("the safety checks are unchanged: manager only, quantity above free stock refused, unknown SKU refused", async () => {
    const db = new FakeDb();
    await expect(make(db, undefined, { isManager: false })).rejects.toThrow(/manager/);
    await expect(make(db, [{ sku: "NQCP137", name: "x", quantity: 1001 }])).rejects.toThrow(/1000 available/);
    await expect(make(db, [{ sku: "NOPE", name: "x", quantity: 1 }])).rejects.toThrow(/do not exist in Cin7/);
    expect(db.rows("projects")).toHaveLength(0);
  });
});
