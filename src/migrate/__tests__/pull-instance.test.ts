import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pullInstanceGroup } from "@/migrate/pull-instance";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllCustomers } from "@/cin7/customers";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import { runImport } from "@/import/run-import";
import { stampPulledState } from "@/migrate/stamp-pulled-state";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/products", () => ({ fetchAllProductsWithBom: vi.fn() }));
vi.mock("@/cin7/customers", () => ({ fetchAllCustomers: vi.fn() }));
vi.mock("@/cin7/suppliers", () => ({ fetchAllSuppliers: vi.fn() }));
vi.mock("@/import/run-import", () => ({ runImport: vi.fn() }));
vi.mock("@/migrate/stamp-pulled-state", () => ({ stampPulledState: vi.fn() }));

const db = {} as SupabaseClient;
const creds = { name: "Source Instance", accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(stampPulledState).mockReset().mockResolvedValue(0);
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue(creds);
  vi.mocked(fetchAllProductsWithBom).mockReset().mockResolvedValue([{ SKU: "SKU1" }]);
  vi.mocked(fetchAllCustomers).mockReset().mockResolvedValue([{ Name: "Woolworths" }]);
  vi.mocked(fetchAllSuppliers).mockReset().mockResolvedValue([{ Name: "ABC Suppliers" }]);
  vi.mocked(runImport).mockReset().mockResolvedValue({
    batchId: "b1",
    kind: "products",
    rowCount: 1,
    errorCount: 0,
    committed: true,
    invalidRows: [],
    warnings: [],
  });
});

describe("pullInstanceGroup", () => {
  it("runs the products group's parent-before-child kinds in order", async () => {
    await pullInstanceGroup(db, "org1", "inst-1", "products");
    const kinds = vi.mocked(runImport).mock.calls.map((call) => call[2]);
    expect(kinds).toEqual(["products", "assembly_bom"]);
  });

  it("runs the customers group's parent-before-child kinds in order", async () => {
    await pullInstanceGroup(db, "org1", "inst-1", "customers");
    const kinds = vi.mocked(runImport).mock.calls.map((call) => call[2]);
    expect(kinds).toEqual(["customers", "customer_addresses"]);
  });

  it("runs the suppliers group's parent-before-child kinds in order", async () => {
    await pullInstanceGroup(db, "org1", "inst-1", "suppliers");
    const kinds = vi.mocked(runImport).mock.calls.map((call) => call[2]);
    expect(kinds).toEqual(["suppliers", "supplier_addresses"]);
  });

  it("only fetches the one Cin7 endpoint relevant to the requested group", async () => {
    await pullInstanceGroup(db, "org1", "inst-1", "products");
    expect(fetchAllProductsWithBom).toHaveBeenCalledWith(creds);
    expect(fetchAllCustomers).not.toHaveBeenCalled();
    expect(fetchAllSuppliers).not.toHaveBeenCalled();
  });

  it("fetches from the source instance's credentials, not a hardcoded one", async () => {
    await pullInstanceGroup(db, "org1", "inst-1", "suppliers");
    expect(loadCin7Credentials).toHaveBeenCalledWith(db, "org1", "inst-1");
    expect(fetchAllSuppliers).toHaveBeenCalledWith(creds);
  });

  it("returns per-kind results for the requested group", async () => {
    const results = await pullInstanceGroup(db, "org1", "inst-1", "customers");
    expect(results.customers).toMatchObject({ committed: true });
    expect(results.customer_addresses).toMatchObject({ committed: true });
    expect(results.products).toBeUndefined();
  });

  it("throws when credentials can't be loaded", async () => {
    vi.mocked(loadCin7Credentials).mockRejectedValueOnce(new Error("Instance not found"));
    await expect(pullInstanceGroup(db, "org1", "inst-1", "products")).rejects.toThrow("Instance not found");
  });

  it("throws before importing anything if the group's live fetch fails", async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValueOnce(new Error("Rate limited"));
    await expect(pullInstanceGroup(db, "org1", "inst-1", "suppliers")).rejects.toThrow("Rate limited");
    expect(runImport).not.toHaveBeenCalled();
  });

  // Behavior change from the old all-in-one pullInstanceData: that version
  // Promise.all'd all 3 Cin7 fetches up front, so one group's fetch failure
  // (e.g. suppliers rate-limited) meant NOTHING committed, even an already-
  // fetched products group. Each group is now its own independent call —
  // pull-jobs.ts's runNextPullChunk persists a completed group's commit
  // before moving to the next, so a later group's failure no longer erases
  // an earlier group's already-committed data. That's the point of chunking
  // by group (partial progress survives a mid-migration failure), not a
  // regression.
  it("does not require other groups to succeed — this group's failure doesn't touch data outside it", async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValueOnce(new Error("Rate limited"));
    await pullInstanceGroup(db, "org1", "inst-1", "products").catch(() => undefined);
    await expect(pullInstanceGroup(db, "org1", "inst-1", "suppliers")).rejects.toThrow("Rate limited");
    // products group's own runImport calls happened independently of suppliers' failure
    const kinds = vi.mocked(runImport).mock.calls.map((call) => call[2]);
    expect(kinds).toContain("products");
    expect(kinds).toContain("assembly_bom");
  });
});

describe("a pull records what it read as already in sync with its SOURCE instance (so it can never trigger a writeback)", () => {
  it("products: stamps the pulled SKUs against the source instance only, after BOTH products and assembly_bom were imported", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValue([{ SKU: "A" }, { SKU: "B" }, { SKU: "" }, { NoSku: 1 }]);
    await pullInstanceGroup(db, "org1", "inst-src", "products");
    expect(stampPulledState).toHaveBeenCalledTimes(1);
    expect(stampPulledState).toHaveBeenCalledWith(db, "org1", "inst-src", "products", ["A", "B"], expect.objectContaining({ committed: true }));
    // after both imports: the product hash includes its BOM lines
    expect(vi.mocked(runImport).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(stampPulledState).mock.invocationCallOrder[0]);
  });

  it("customers and suppliers: stamp the pulled Names against the source instance", async () => {
    await pullInstanceGroup(db, "org1", "inst-src", "customers");
    await pullInstanceGroup(db, "org1", "inst-src", "suppliers");
    expect(stampPulledState).toHaveBeenNthCalledWith(1, db, "org1", "inst-src", "customers", ["Woolworths"], expect.anything());
    expect(stampPulledState).toHaveBeenNthCalledWith(2, db, "org1", "inst-src", "suppliers", ["ABC Suppliers"], expect.anything());
  });

  it("never stamps any other instance: the instance id passed is always the pull's source", async () => {
    await pullInstanceGroup(db, "org1", "inst-src", "products");
    await pullInstanceGroup(db, "org1", "inst-src", "customers");
    await pullInstanceGroup(db, "org1", "inst-src", "suppliers");
    for (const call of vi.mocked(stampPulledState).mock.calls) expect(call[2]).toBe("inst-src");
  });

  it("a failed fetch stamps nothing", async () => {
    vi.mocked(fetchAllCustomers).mockRejectedValueOnce(new Error("Rate limited"));
    await expect(pullInstanceGroup(db, "org1", "inst-src", "customers")).rejects.toThrow("Rate limited");
    expect(stampPulledState).not.toHaveBeenCalled();
  });
});
