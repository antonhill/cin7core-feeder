import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../actor";

// The read-only Cin7 supplier actions: SUPPLIER SEARCH (active suppliers only, by name, with Cin7 id and currency), the SKU'S OWN supplier records first (price, currency, last-supplied date), the undated average cost
// shown as undated information, authority (cost-entitled only), and a Cin7 outage that says so without leaking internals. The Cin7 reads are fakes; the actions are the real ones.
vi.mock("server-only", () => ({}));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({}) }));
let quoteExists = true;
vi.mock("@/lib/newquip-quotes/quote-store", () => ({ loadQuote: vi.fn(async () => (quoteExists ? { id: "q1" } : null)) }));
let actor: Actor;
vi.mock("../actor", async (orig) => ({ ...(await orig<typeof import("../actor")>()), authoriseActor: vi.fn(async () => actor) }));

const ref = (id: string, name: string, currency: string | null, active = true) => ({ id, name, currency, active });
let directory: ReturnType<typeof ref>[] = [];
let product: { found: boolean; productName: string | null; averageCost: number | null; suppliers: Array<{ supplierId: string; supplierName: string; cost: number | null; currency: string | null; lastSupplied: string | null }> } = { found: true, productName: "Mat", averageCost: null, suppliers: [] };
let cin7Down = false;
vi.mock("@/lib/projects/latest-cost-adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects/latest-cost-adapter")>()),
  listCin7Suppliers: vi.fn(async () => { if (cin7Down) throw new Error("fetch failed: ECONNRESET api.cin7.com"); return directory; }),
  readProductSuppliers: vi.fn(async () => { if (cin7Down) throw new Error("Cin7 401 key sk_live_secret"); return product; }),
}));
import * as actions from "../supplier-actions";
import { toProductSupplierRefs, toSupplierRef } from "@/lib/projects/latest-cost-adapter";

const asActor = (over: Partial<Actor> = {}): Actor => ({ orgId: "org-nq", userId: "u1", email: "est@nq", tier: "member", roles: new Set(["estimator"]) as never, canSeeCost: true, activeRole: null, demo: null, ...over } as Actor);
beforeEach(() => {
  actor = asActor(); cin7Down = false; quoteExists = true;
  directory = [ref("S1", "Alpha Plastics", "ZAR"), ref("S2", "Alpine Imports", "EUR"), ref("S3", "Beta Alpha Steel", "USD"), ref("S4", "Alpha Retired", "ZAR", false), ref("S5", "Gamma Supplies", null)];
  product = { found: true, productName: "Feed saver mat", averageCost: 31.5, suppliers: [{ supplierId: "S2", supplierName: "Alpine Imports", cost: 26.8440995, currency: "EUR", lastSupplied: "2026-03-02" }] };
});

describe("supplier search over the active Cin7 catalogue", () => {
  it("returns active suppliers by name with their Cin7 id and currency, names that START with the search first", async () => {
    const r = await actions.searchCin7SuppliersAction("q1", "alp");
    expect(r.ok).toBe(true);
    expect(r.data!.hits.map((h) => h.name)).toEqual(["Alpha Plastics", "Alpine Imports", "Beta Alpha Steel"]);
    expect(r.data!.hits[1]).toEqual({ supplierId: "S2", name: "Alpine Imports", currency: "EUR" });
    expect(r.data!.hits.some((h) => h.name === "Alpha Retired")).toBe(false); // inactive suppliers are never offered
  });
  it("needs two characters, and a supplier with no Cin7 currency is returned with currency null (never defaulted)", async () => {
    expect((await actions.searchCin7SuppliersAction("q1", "a")).data).toEqual({ hits: [], total: 0, truncated: false });
    expect((await actions.searchCin7SuppliersAction("q1", "gamma")).data!.hits).toEqual([{ supplierId: "S5", name: "Gamma Supplies", currency: null }]);
  });
  it("shows at most 25 and says how many matched", async () => {
    directory = Array.from({ length: 40 }, (_, i) => ref(`X${i}`, `Supplier ${String(i).padStart(2, "0")}`, "ZAR"));
    const r = (await actions.searchCin7SuppliersAction("q1", "supplier")).data!;
    expect(r.hits).toHaveLength(25);
    expect(r.total).toBe(40);
    expect(r.truncated).toBe(true);
  });
});

describe("what Cin7 already holds for the product, before anything is entered", () => {
  it("lists the product's own suppliers with the exact Cin7 price, the SUPPLIER's own Cin7 currency and the last-supplied date", async () => {
    const r = await actions.getSkuCostContextAction("q1", "ERT053");
    expect(r.ok).toBe(true);
    expect(r.data!.found).toBe(true);
    expect(r.data!.suppliers).toEqual([{ supplierId: "S2", supplierName: "Alpine Imports", active: true, cost: "26.8440995", currency: "EUR", currencySource: "cin7_supplier", productCurrency: "EUR", lastSupplied: "2026-03-02" }]);
  });
  it("the currency is the supplier's own Cin7 currency, never the product record's: where they differ the record's is only information; where the supplier holds none it stays null (never ZAR)", async () => {
    product.suppliers = [
      { supplierId: "S2", supplierName: "Alpine Imports", cost: 10, currency: "USD", lastSupplied: null }, // supplier master says EUR
      { supplierId: "S5", supplierName: "Gamma Supplies", cost: 5, currency: "USD", lastSupplied: null }, // supplier master holds none
      { supplierId: "S1", supplierName: "Alpha Plastics", cost: 7, currency: null, lastSupplied: null },
    ];
    const s = (await actions.getSkuCostContextAction("q1", "ERT053")).data!.suppliers;
    expect(s[0]).toMatchObject({ currency: "EUR", currencySource: "cin7_supplier", productCurrency: "USD" });
    expect(s[1]).toMatchObject({ currency: null, currencySource: null, productCurrency: "USD", lastSupplied: null });
    expect(s[2]).toMatchObject({ currency: "ZAR", currencySource: "cin7_supplier", productCurrency: null }); // an undated cost stays undated
  });
  it("the supplier's Cin7 NAME wins over a stale name on the product record, and an inactive supplier is flagged", async () => {
    product.suppliers = [{ supplierId: "S2", supplierName: "Alpine Old Name", cost: 1, currency: null, lastSupplied: null }, { supplierId: "S4", supplierName: "Alpha Retired", cost: 2, currency: null, lastSupplied: null }];
    const s = (await actions.getSkuCostContextAction("q1", "ERT053")).data!.suppliers;
    expect(s[0]).toMatchObject({ supplierName: "Alpine Imports", active: true });
    expect(s[1]).toMatchObject({ supplierId: "S4", active: false });
  });
  it("when the supplier catalogue cannot be read the whole call fails: no currency is guessed", async () => {
    const mod = await import("@/lib/projects/latest-cost-adapter");
    vi.mocked(mod.listCin7Suppliers).mockRejectedValueOnce(new Error("fetch failed"));
    expect(await actions.getSkuCostContextAction("q1", "ERT053")).toMatchObject({ ok: false, error: "Cin7 supplier data is not available right now. Nothing was changed." });
  });
  it("the average cost is offered only as an UNDATED reference; it is never a supplier record", async () => {
    const d = (await actions.getSkuCostContextAction("q1", "ERT053")).data!;
    expect(d.averageCostUndated).toBe("31.5");
    expect(d.suppliers.every((s) => s.lastSupplied === null || /^\d{4}-\d{2}-\d{2}$/.test(s.lastSupplied))).toBe(true);
  });
  it("a product Cin7 does not return is reported as not found, with no suppliers", async () => {
    product = { found: false, productName: null, averageCost: null, suppliers: [] };
    expect((await actions.getSkuCostContextAction("q1", "NOPE")).data).toMatchObject({ found: false, suppliers: [], averageCostUndated: null });
  });
});

describe("authority and failure", () => {
  it("a viewer without cost visibility (a Rep) is refused both ways and reads nothing", async () => {
    actor = asActor({ canSeeCost: false, roles: new Set(["rep"]) as never });
    expect(await actions.searchCin7SuppliersAction("q1", "alp")).toMatchObject({ ok: false, error: expect.stringMatching(/internal/) });
    expect(await actions.getSkuCostContextAction("q1", "ERT053")).toMatchObject({ ok: false, error: expect.stringMatching(/internal/) });
  });
  it("Demo Mode is refused", async () => {
    actor = asActor({ demo: {} as never });
    expect((await actions.searchCin7SuppliersAction("q1", "alp")).error).toMatch(/Demo Mode/);
  });
  it("a Cin7 outage returns one safe message: no host, key or stack leaks", async () => {
    cin7Down = true;
    for (const r of [await actions.searchCin7SuppliersAction("q1", "alp"), await actions.getSkuCostContextAction("q1", "ERT053")]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Cin7 supplier data is not available right now. Nothing was changed.");
    }
  });
  it("a quotation that does not exist in this organisation is refused, for both reads", async () => {
    quoteExists = false;
    expect((await actions.searchCin7SuppliersAction("q1", "alp")).error).toBe("That quotation could not be found.");
    expect((await actions.getSkuCostContextAction("q1", "ERT053")).error).toBe("That quotation could not be found.");
  });
  it("only our own refusals are shown as written: an unexpected error that merely mentions a permission or module never reaches the browser", async () => {
    const mod = await import("@/lib/projects/latest-cost-adapter");
    vi.mocked(mod.listCin7Suppliers).mockRejectedValueOnce(new Error("Cin7 permission denied for module /supplier: key sk_live_x"));
    const r = await actions.searchCin7SuppliersAction("q1", "alp");
    expect(r.error).toBe("Cin7 supplier data is not available right now. Nothing was changed.");
  });
  it("malformed input is refused", async () => {
    expect((await actions.getSkuCostContextAction("q1", "bad sku;drop")).error).toBe("The request was not valid.");
    expect((await actions.searchCin7SuppliersAction("", "alp")).error).toBe("The request was not valid.");
  });
});

describe("mapping Cin7's raw records", () => {
  it("a supplier record keeps Cin7's id, name, status and a valid three-letter currency, else null", () => {
    expect(toSupplierRef({ ID: "a", Name: " Acme ", Status: "Active", Currency: "eur" })).toEqual({ id: "a", name: "Acme", currency: "EUR", active: true });
    expect(toSupplierRef({ ID: "b", Name: "Old", Status: "Deprecated", Currency: "" })).toEqual({ id: "b", name: "Old", currency: null, active: false });
    expect(toSupplierRef({ ID: "c", Name: "Odd", Currency: "RAND" })).toMatchObject({ currency: null });
    expect(toSupplierRef({ Name: "No id" })).toBeNull();
  });
  it("a product's supplier records keep the price, currency and the DATE part of last-supplied; a zero or missing price is null", () => {
    const r = toProductSupplierRefs([{ SupplierID: "S1", SupplierName: "A", Cost: 12.5, Currency: "USD", LastSupplied: "2026-03-02T10:15:00Z" }, { SupplierID: "S2", SupplierName: "B", Cost: 0 }, { SupplierName: "no id" }]);
    expect(r).toEqual([{ supplierId: "S1", supplierName: "A", cost: 12.5, currency: "USD", lastSupplied: "2026-03-02" }, { supplierId: "S2", supplierName: "B", cost: null, currency: null, lastSupplied: null }]);
  });
});
