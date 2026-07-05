import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pullInstanceData } from "@/migrate/pull-instance";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllCustomers } from "@/cin7/customers";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import { runImport } from "@/import/run-import";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/products", () => ({ fetchAllProductsWithBom: vi.fn() }));
vi.mock("@/cin7/customers", () => ({ fetchAllCustomers: vi.fn() }));
vi.mock("@/cin7/suppliers", () => ({ fetchAllSuppliers: vi.fn() }));
vi.mock("@/import/run-import", () => ({ runImport: vi.fn() }));

const db = {} as SupabaseClient;
const creds = { name: "Source Instance", accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
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

describe("pullInstanceData", () => {
  it("runs every kind's import in parent-before-child order", async () => {
    await pullInstanceData(db, "org1", "inst-1");

    const kinds = vi.mocked(runImport).mock.calls.map((call) => call[2]);
    expect(kinds).toEqual(["products", "assembly_bom", "customers", "customer_addresses", "suppliers", "supplier_addresses"]);
  });

  it("fetches from the source instance's credentials, not a hardcoded one", async () => {
    await pullInstanceData(db, "org1", "inst-1");
    expect(loadCin7Credentials).toHaveBeenCalledWith(db, "org1", "inst-1");
    expect(fetchAllProductsWithBom).toHaveBeenCalledWith(creds);
    expect(fetchAllCustomers).toHaveBeenCalledWith(creds);
    expect(fetchAllSuppliers).toHaveBeenCalledWith(creds);
  });

  it("returns ok with per-kind results and the source instance's name", async () => {
    const result = await pullInstanceData(db, "org1", "inst-1");
    expect(result.ok).toBe(true);
    expect(result.instanceName).toBe("Source Instance");
    expect(result.results?.products).toMatchObject({ committed: true });
    expect(result.results?.supplier_addresses).toMatchObject({ committed: true });
  });

  it("returns ok: false with the error message when a step fails", async () => {
    vi.mocked(loadCin7Credentials).mockRejectedValueOnce(new Error("Instance not found"));
    const result = await pullInstanceData(db, "org1", "inst-1");
    expect(result).toEqual({ ok: false, error: "Instance not found" });
  });

  it("stops before importing anything if a live fetch fails", async () => {
    vi.mocked(fetchAllSuppliers).mockRejectedValueOnce(new Error("Rate limited"));
    const result = await pullInstanceData(db, "org1", "inst-1");
    expect(result.ok).toBe(false);
    expect(runImport).not.toHaveBeenCalled();
  });
});
