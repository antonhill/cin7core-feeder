import { describe, expect, it, vi } from "vitest";
import { Cin7ReadOnlyGate, DiagnosticError, inspectSkus, validateSkus, type GetTransport } from "../readonly-diagnostic";

vi.mock("server-only", () => ({}));
const CANARY = "CANARY-APP-KEY-9f3a";

type Handler = (path: string, query: Record<string, string | number>) => unknown | Promise<unknown>;
function rig(handler: Handler) {
  const calls: Array<{ method: string; path: string; query: Record<string, string | number> }> = [];
  const transport: GetTransport = async (method, path, query) => { calls.push({ method, path, query }); return handler(path, query); };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  return { gate: new Cin7ReadOnlyGate(transport), calls, sleeps, sleep };
}
const prod = (sku: string, extra: Record<string, unknown> = {}) => ({ Products: [{ SKU: sku, Name: `N ${sku}`, Status: "Active", Type: "Stock", UOM: "Item", CostingMethod: "FIFO", AverageCost: 1.5, Suppliers: [], ...extra }] });
const sup = (name: string, extra: Record<string, unknown> = {}) => ({ SupplierName: name, SupplierID: `id-${name}`, Cost: 10, FixedCost: 2, SupplierInventoryCode: "SC1", LastSupplied: "2026-10-01", ...extra });
const master = (name: string, currency: string | null) => ({ SupplierList: [{ ID: "x", Name: name, Currency: currency, Status: "Active" }] });

describe("Cin7ReadOnlyGate", () => {
  const ok = () => rig(() => ({}));
  it("only issues GET (the method is hard-coded; there is no way to pass one)", async () => {
    const r = ok(); await r.gate.get("/Product", { SKU: "A" });
    expect(r.calls[0].method).toBe("GET");
    expect(r.gate.get.length).toBeLessThanOrEqual(2);
    // a smuggled method key is just a non-allowlisted query key
    await expect(r.gate.get("/Product", { method: "POST" })).rejects.toThrow("query_key_not_allowed");
    for (const m of ["POST", "PUT", "DELETE"]) expect((r.gate as unknown as Record<string, unknown>)[m.toLowerCase()]).toBeUndefined();
  });
  it.each(["/Sale", "/purchase", "/product/anything-else", "/product", "/Product/", "/Product/../Sale", "../Product", "https://api.cin7.com/Product", "//evil.example/Product", "Product", "/Supplier?x=1"])("rejects path %s", async (p) => {
    const r = ok();
    await expect(r.gate.get(p, {})).rejects.toThrow("path_not_allowed");
    expect(r.calls).toHaveLength(0);
  });
  it("rejects non-allowlisted query keys before any request, and bad values", async () => {
    const r = ok();
    await expect(r.gate.get("/Product", { SKU: "A", Fields: "x" })).rejects.toThrow("query_key_not_allowed");
    await expect(r.gate.get("/Product", { SKU: "a".repeat(200) })).rejects.toThrow("query_value_invalid");
    await expect(r.gate.get("/Product", { SKU: "a\nb" })).rejects.toThrow("query_value_invalid");
    expect(r.calls).toHaveLength(0);
    await r.gate.get("/Supplier", { Name: "X", ID: "1", IncludeSuppliers: true, IncludeBOM: false, page: 1, limit: 1 });
    expect(r.calls[0].query).toMatchObject({ IncludeSuppliers: "true", IncludeBOM: "false" });
  });
});

describe("validateSkus", () => {
  it("trims, dedupes, drops blanks; enforces count, length and charset", () => {
    expect(validateSkus([" A ", "A", "", "B-1/x.y_z w"])).toEqual({ ok: true, skus: ["A", "B-1/x.y_z w"] });
    expect(validateSkus([])).toMatchObject({ ok: false });
    expect(validateSkus(["a".repeat(65)])).toMatchObject({ ok: false });
    expect(validateSkus(["A;B"])).toMatchObject({ ok: false });
    expect(validateSkus(["A?x=1"])).toMatchObject({ ok: false });
    expect(validateSkus([5 as never])).toMatchObject({ ok: false });
    expect(validateSkus(Array.from({ length: 151 }, (_, i) => `S${i}`))).toMatchObject({ ok: false });
    expect(validateSkus(Array.from({ length: 150 }, (_, i) => `S${i}`))).toMatchObject({ ok: true });
  });
});

describe("inspectSkus", () => {
  it("found / missing / inactive, exact-match rule, request shape, pacing", async () => {
    const r = rig((path, q) => {
      if (path === "/Product" && q.SKU === "A") return prod("A");
      if (path === "/Product" && q.SKU === "I") return prod("I", { Status: "Deprecated" });
      if (path === "/Product" && q.SKU === "WRONG") return prod("OTHER"); // Cin7 ignored the filter
      return { Products: [] };
    });
    const res = await inspectSkus(r.gate, ["A", "I", "WRONG", "NONE"], { sleep: r.sleep });
    expect(res.skus.map((s) => s.found)).toEqual([true, true, false, false]);
    expect(res.summary).toMatchObject({ requested: 4, found: 2, missing: 2, inactive: 1, noSupplier: 2, errors: 0 });
    expect(r.calls[0]).toEqual({ method: "GET", path: "/Product", query: { SKU: "A", IncludeSuppliers: "true", IncludeBOM: "true", page: 1, limit: 1 } });
    expect(r.sleeps.filter((ms) => ms === 1000)).toHaveLength(3); // paced between SKUs, not before the first
    expect(res.readOnly).toBe(true);
  });

  it("multiple suppliers, raw cost/fixedCost, record vs LIVE master currency, never inferred", async () => {
    const r = rig((path, q) => {
      if (path === "/Product") return prod("A", { Suppliers: [sup("S1", { Currency: "USD" }), sup("S2"), sup("S3", { Currency: "ZAR" }), sup("S4")] });
      return ({ S1: master("S1", "ZAR"), S2: master("S2", "EUR"), S3: master("S3", "ZAR"), S4: master("S4", null) } as Record<string, unknown>)[String(q.Name)];
    });
    const res = await inspectSkus(r.gate, ["A"], { sleep: r.sleep });
    const [s1, s2, s3, s4] = res.skus[0].suppliers;
    expect(s1).toMatchObject({ recordCurrency: "USD", masterCurrency: "ZAR", currencyConflict: true, currencyUnknown: false, cost: 10, fixedCost: 2, supplierInventoryCode: "SC1", lastSupplied: "2026-10-01" });
    expect(s2).toMatchObject({ recordCurrency: null, masterCurrency: "EUR", currencyConflict: false, currencyUnknown: false });
    expect(s3).toMatchObject({ currencyConflict: false });
    expect(s4).toMatchObject({ recordCurrency: null, masterCurrency: null, currencyConflict: false, currencyUnknown: true }); // not inferred
    expect(res.summary).toMatchObject({ multipleSuppliers: 1, currencyConflicts: 1, currencyUnknown: 1 });
    expect(res.skus[0].rawSupplierKeys).toEqual(expect.arrayContaining(["Cost", "Currency", "FixedCost"]));
    expect(res.skus[0].rawSupplierKeys).toEqual([...res.skus[0].rawSupplierKeys].sort());
    const supplierCalls = r.calls.filter((c) => c.path === "/Supplier");
    expect(supplierCalls.map((c) => c.query.Name).sort()).toEqual(["S1", "S2", "S3", "S4"]);
    expect(supplierCalls.every((c) => c.query.page === 1 && c.query.limit === 1)).toBe(true);
  });

  it("a supplier master that is not an exact name match is not used", async () => {
    const r = rig((path) => (path === "/Product" ? prod("A", { Suppliers: [sup("Acme")] }) : master("Acme Corp", "USD")));
    const res = await inspectSkus(r.gate, ["A"], { sleep: r.sleep });
    expect(res.skus[0].suppliers[0].masterCurrency).toBeNull();
    expect(res.supplierMasters[0].found).toBe(false);
  });

  it("BOM with extra keys including a Substitute field; substitution-like fields copied verbatim", async () => {
    const r = rig(() => prod("B", { BillOfMaterial: true, BOMType: "Assembly", AlternativeProduct: "ZZ",
      BillOfMaterialsProducts: [{ ProductCode: "C1", Name: "Comp", Quantity: 2, WastagePercent: 5, CostPercentage: 50, SubstituteProductCode: "C9" }, { ProductCode: "C2", Quantity: 1, Extra: "x" }],
      BillOfMaterialsServices: [{ Name: "Labour", Quantity: 1 }] }));
    const res = await inspectSkus(r.gate, ["B"], { sleep: r.sleep });
    const b = res.skus[0];
    expect(b.bom?.type).toBe("Assembly");
    expect(b.bom?.components[0]).toMatchObject({ code: "C1", name: "Comp", qty: 2, wastagePercent: 5, costPercentage: 50, substitutionFields: { SubstituteProductCode: "C9" } });
    expect(b.bom?.services).toHaveLength(1);
    expect(b.rawBomLineKeys).toEqual(["Extra", "Name", "ProductCode", "Quantity", "SubstituteProductCode", "CostPercentage", "WastagePercent"].sort());
    expect(b.substitutionFields).toEqual({ AlternativeProduct: "ZZ" });
    expect(res.summary.bomMissing).toBe(0);
    const plain = await inspectSkus(rig(() => prod("P")).gate, ["P"], { sleep: async () => {} });
    expect(plain.skus[0].bom).toBeNull();
    expect(plain.summary.bomMissing).toBe(1);
  });

  it("429 backs off (bounded) then succeeds; exhausted 429 becomes http_429", async () => {
    let n = 0;
    const r = rig(() => { if (n++ < 2) throw Object.assign(new Error(`secret ${CANARY}`), { status: 429 }); return prod("A"); });
    const res = await inspectSkus(r.gate, ["A"], { sleep: r.sleep });
    expect(res.skus[0].found).toBe(true);
    expect(r.sleeps).toEqual([2000, 4000]);
    const always = rig(() => { throw Object.assign(new Error("x"), { status: 429 }); });
    const res2 = await inspectSkus(always.gate, ["A"], { sleep: always.sleep });
    expect(res2.skus[0].error).toBe("http_429");
    expect(always.calls).toHaveLength(4); // 1 + 3 bounded retries
    expect(always.sleeps).toEqual([2000, 4000, 8000]);
  });

  it("aborts after 3 consecutive errors; a success in between resets the count", async () => {
    const r = rig(() => { throw Object.assign(new Error("boom"), { status: 500 }); });
    const res = await inspectSkus(r.gate, ["A", "B", "C", "D", "E"], { sleep: r.sleep });
    expect(r.calls).toHaveLength(3);
    expect(res.aborted).toBe(true);
    expect(res.skus.map((s) => s.error)).toEqual(["http_500", "http_500", "http_500", "skipped_after_abort", "skipped_after_abort"]);
    expect(res.summary.errors).toBe(5);
    let i = 0;
    const r2 = rig(() => { if (++i % 3 !== 0) throw Object.assign(new Error("e"), { status: 500 }); return prod("X"); });
    const res2 = await inspectSkus(r2.gate, ["A", "B", "C", "D", "E", "F"], { sleep: r2.sleep });
    expect(res2.aborted).toBe(false);
  });

  it("maps failures to short codes; no credentials, URLs or raw bodies anywhere in the output", async () => {
    const url = `https://api.cin7.com/ExternalApi/v2/Product?key=${CANARY}`;
    const errs = [Object.assign(new Error(`${CANARY} ${url} {"raw":"body"}`), { status: 401 }), new TypeError(`fetch failed ${CANARY}`), Object.assign(new Error(CANARY), { status: 0 })];
    let i = 0;
    const r = rig(() => { throw errs[i++ % 3]; });
    const res = await inspectSkus(r.gate, ["A", "B", "C"], { sleep: r.sleep });
    expect(res.skus.map((s) => s.error)).toEqual(["http_401", "network", "network"]);
    const text = JSON.stringify(res);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("body");
    // a gate refusal is also only a code
    await expect(new Cin7ReadOnlyGate(async () => ({})).get("/Sale")).rejects.toBeInstanceOf(DiagnosticError);
  });

  it("supplier master lookup failure is a code, not a crash", async () => {
    const r = rig((path) => { if (path === "/Product") return prod("A", { Suppliers: [sup("S1")] }); throw Object.assign(new Error(CANARY), { status: 500 }); });
    const res = await inspectSkus(r.gate, ["A"], { sleep: r.sleep });
    expect(res.supplierMasters[0].error).toBe("http_500");
    expect(res.summary.errors).toBe(1);
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });
});
