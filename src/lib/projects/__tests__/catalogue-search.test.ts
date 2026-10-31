import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { resolveVariationProducts, searchCatalogue } from "../catalogue-search";

const ORG = "org-a";
const prod = (sku: string, name: string, over: Record<string, unknown> = {}) => ({ org_id: ORG, sku, name, cin7_type: "Stock", active: true, status: "Active", ...over });
function seed(db: FakeDb) {
  db.maxRows = 1000; // Supabase's silent cap
  for (let i = 0; i < 2500; i++) db.rows("products").push(prod(`A${String(i).padStart(5, "0")}`, `Filler ${i}`));
  db.rows("products").push(prod("KNQPP014", "Ventilation controller"), prod("KNQPP0140", "Ventilation controller XL"), prod("SVC-INSTALL", "Installation labour", { cin7_type: "Service" }), prod("OLD-1", "Ventilation legacy", { active: false }));
  db.rows("products").push({ ...prod("KNQPP014", "foreign org copy"), org_id: "org-b" });
  for (let i = 0; i < 2500; i++) db.rows("products").push(prod(`Z${String(i).padStart(5, "0")}`, `Tail ${i}`));
  db.rows("product_availability").push(
    { org_id: ORG, product_sku: "KNQPP014", location: "MSTR", available: 4 }, { org_id: ORG, product_sku: "KNQPP014", location: "PROJ", available: 2 },
    { org_id: ORG, product_sku: "KNQPP0140", location: "MSTR", available: 0 }, { org_id: ORG, product_sku: "OLD-1", location: "MSTR", available: null },
  );
}

describe("variation product search (Cin7 catalogue)", () => {
  it("finds a product by SKU or description in a >1,000-row catalogue, exact SKU first, scoped to the org", async () => {
    const db = new FakeDb(); seed(db);
    const r = await searchCatalogue(db as never, ORG, "knqpp014");
    expect(r.outcome).toBe("FOUND");
    expect(r.products.map((p) => p.sku)).toEqual(["KNQPP014", "KNQPP0140"]);
    expect(r.products[0].name).toBe("Ventilation controller"); // not the foreign org's copy
    expect((await searchCatalogue(db as never, ORG, "ventilation")).products.map((p) => p.sku)).toEqual(expect.arrayContaining(["KNQPP014", "KNQPP0140", "OLD-1"]));
  });
  it("shows stock when known (summed over locations) and null - never zero - when no stock row exists; stock never filters results", async () => {
    const db = new FakeDb(); seed(db);
    const r = await searchCatalogue(db as never, ORG, "ventilation");
    const by = Object.fromEntries(r.products.map((p) => [p.sku, p]));
    expect(by["KNQPP014"].available).toBe(6);
    expect(by["KNQPP0140"].available).toBe(0);   // known zero is still offered
    expect(by["OLD-1"].available).toBeNull();     // unknown
    expect((await searchCatalogue(db as never, ORG, "installation")).products[0].available).toBeNull();
  });
  it("reports product type, whether it is stocked, and inactive products; non-stock services are findable", async () => {
    const db = new FakeDb(); seed(db);
    const svc = (await searchCatalogue(db as never, ORG, "SVC-INSTALL")).products[0];
    expect(svc).toMatchObject({ type: "Service", stocked: false, active: true });
    expect((await searchCatalogue(db as never, ORG, "OLD-1")).products[0].active).toBe(false);
  });
  it("distinguishes too-short and not-found, truncates with a count, and treats LIKE metacharacters as text", async () => {
    const db = new FakeDb(); seed(db);
    expect((await searchCatalogue(db as never, ORG, "k")).outcome).toBe("TOO_SHORT");
    expect((await searchCatalogue(db as never, ORG, "zzzzqq")).outcome).toBe("NOT_FOUND");
    const many = await searchCatalogue(db as never, ORG, "Filler", 10);
    expect(many.products).toHaveLength(10); expect(many.truncated).toBe(true); expect(many.detail).toMatch(/of 2500/);
    expect((await searchCatalogue(db as never, ORG, "%_%")).outcome).toBe("NOT_FOUND");
  });
});

describe("variation product resolution", () => {
  it("describes picks from the catalogue, ignores stock, and allows a service-only variation (no lines)", async () => {
    const db = new FakeDb(); seed(db);
    expect(await resolveVariationProducts(db as never, ORG, [])).toEqual([]);
    expect(await resolveVariationProducts(db as never, ORG, [{ sku: "KNQPP0140", quantity: 2 }, { sku: "KNQPP014", quantity: 1 }])).toEqual([
      { sku: "KNQPP0140", description: "Ventilation controller XL", quantity: 2 }, { sku: "KNQPP014", description: "Ventilation controller", quantity: 1 }, // zero stock never blocks
    ]);
  });
  it("refuses typos, duplicates, bad quantities, services, inactive products and another org's SKU", async () => {
    const db = new FakeDb(); seed(db);
    const err = (s: Array<{ sku: string; quantity: number }>) => resolveVariationProducts(db as never, ORG, s).then(() => "ok", (e: Error) => e.message);
    expect(await err([{ sku: "KNQPP01", quantity: 1 }])).toMatch(/not in the synced Cin7 catalogue/);
    expect(await err([{ sku: "KNQPP014", quantity: 1 }, { sku: "KNQPP014", quantity: 1 }])).toMatch(/twice/);
    expect(await err([{ sku: "KNQPP014", quantity: 0 }])).toMatch(/positive/);
    expect(await err([{ sku: " ", quantity: 1 }])).toMatch(/Pick a product/);
    expect(await err([{ sku: "SVC-INSTALL", quantity: 1 }])).toMatch(/not a stocked product/);
    expect(await err([{ sku: "OLD-1", quantity: 1 }])).toMatch(/inactive/);
    const other = new FakeDb(); other.rows("products").push({ ...prod("ONLY-B", "b"), org_id: "org-b" });
    expect(await resolveVariationProducts(other as never, ORG, [{ sku: "ONLY-B", quantity: 1 }]).then(() => "ok", (e: Error) => e.message)).toMatch(/not in the synced/);
  });
});
