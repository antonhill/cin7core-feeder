import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstance } from "@/sync/run-sync";
import { pushProduct } from "@/cin7/products";
import { pushProductionBom } from "@/cin7/production-bom";
import { Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/products", () => ({ pushProduct: vi.fn() }));
vi.mock("@/cin7/production-bom", () => ({
  pushProductionBom: vi.fn(),
  createProductionBomRefCaches: () => ({ workCentres: new Map(), resources: new Map() }),
}));
vi.mock("@/cin7/crypto", () => ({ decrypt: (v: string) => `decrypted:${v}` }));

/** Minimal in-memory stand-in for the chained query shapes run-sync.ts actually issues. */
function createFakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const upserts: Record<string, Record<string, unknown>[]> = {};

  function builder(table: string) {
    const rows = tables[table] ?? [];
    const filters: [string, unknown][] = [];
    const matching = () => rows.filter((r) => filters.every(([col, val]) => r[col] === val));

    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      single: async () => {
        const found = matching();
        return found.length ? { data: found[0], error: null } : { data: null, error: { message: "not found" } };
      },
      upsert: async (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...(Array.isArray(payload) ? payload : [payload])];
        return { error: null };
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        resolve({ data: matching(), error: null });
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, upserts };
}

beforeEach(() => {
  vi.mocked(pushProduct).mockReset();
  vi.mocked(pushProductionBom).mockReset();
});

const instanceRow = {
  id: "inst-1",
  org_id: "org1",
  name: "Spark Demo",
  account_id: "acct-1",
  application_key_encrypted: "cipher",
  base_url: "https://example.test",
  active: true,
};

describe("syncInstance", () => {
  it("skips a product whose content_hash already matches sync_state", async () => {
    const { db, upserts } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [{ org_id: "org1", sku: "SKU1", name: "A", content_hash: "hash-a" }],
      sync_state: [{ org_id: "org1", instance_id: "inst-1", sku: "SKU1", synced_hash: "hash-a" }],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [],
    });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productsSkipped).toBe(1);
    expect(summary.productsCreated).toBe(0);
    expect(pushProduct).not.toHaveBeenCalled();
    expect(upserts.sync_state).toBeUndefined();
  });

  it("pushes a product whose content_hash changed and records sync_state", async () => {
    const { db, upserts } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [{ org_id: "org1", sku: "SKU1", name: "A", content_hash: "hash-b" }],
      sync_state: [{ org_id: "org1", instance_id: "inst-1", sku: "SKU1", synced_hash: "hash-a" }],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [],
    });
    vi.mocked(pushProduct).mockResolvedValueOnce({ cin7Id: "cin7-1", status: "updated" });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productsUpdated).toBe(1);
    expect(pushProduct).toHaveBeenCalledTimes(1);
    expect(upserts.sync_state).toEqual([
      expect.objectContaining({ sku: "SKU1", cin7_id: "cin7-1", synced_hash: "hash-b", last_status: "updated" }),
    ]);
  });

  it("continues to the next product after one fails, recording last_status failed", async () => {
    const { db, upserts } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [
        { org_id: "org1", sku: "BAD", name: "Bad", content_hash: "h1" },
        { org_id: "org1", sku: "GOOD", name: "Good", content_hash: "h2" },
      ],
      sync_state: [],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [],
    });
    vi.mocked(pushProduct)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ cin7Id: "cin7-2", status: "created" });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productsFailed).toBe(1);
    expect(summary.productsCreated).toBe(1);
    expect(summary.errors).toEqual([{ sku: "BAD", error: ["Product push failed", "boom"] }]);
    expect(upserts.sync_state).toEqual([
      expect.objectContaining({ sku: "BAD", last_status: "failed", last_error: "Product push failed; boom" }),
      expect.objectContaining({ sku: "GOOD", last_status: "created" }),
    ]);
  });

  it("formats a Cin7 validation error body as plain text instead of a raw JSON dump", async () => {
    const { db } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [{ org_id: "org1", sku: "BAD", name: "Bad", content_hash: "h1" }],
      sync_state: [],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [],
    });
    const body = JSON.stringify([
      { ErrorCode: 404, Exception: "Location 'Main Warehouse Nooo' was not found in Locations reference book" },
      { ErrorCode: 400, Exception: "Sales Representative 'Sparkie' was not found in Company Contacts reference book" },
    ]);
    vi.mocked(pushProduct).mockRejectedValueOnce(new Cin7ApiError(400, body, false));

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.errors).toEqual([
      {
        sku: "BAD",
        error: [
          "Product push failed",
          "Location 'Main Warehouse Nooo' was not found in Locations reference book",
          "Sales Representative 'Sparkie' was not found in Company Contacts reference book",
        ],
      },
    ]);
  });

  it("falls back to the raw body when a Cin7 error isn't the expected JSON shape", async () => {
    const { db } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [{ org_id: "org1", sku: "BAD", name: "Bad", content_hash: "h1" }],
      sync_state: [],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [],
    });
    vi.mocked(pushProduct).mockRejectedValueOnce(new Cin7ApiError(500, "<html>Internal Server Error</html>", false));

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.errors).toEqual([
      { sku: "BAD", error: ["Product push failed", "[500] <html>Internal Server Error</html>"] },
    ]);
  });

  it("passes a product's Assembly BOM lines into the same pushProduct call (no separate BOM endpoint)", async () => {
    const { db } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [{ org_id: "org1", sku: "PARENT", name: "Parent", content_hash: "h1" }],
      sync_state: [],
      price_tiers: [],
      assembly_bom_lines: [{ org_id: "org1", product_sku: "PARENT", component_sku: "COMP", quantity: 1 }],
      production_bom_versions: [],
    });
    vi.mocked(pushProduct).mockResolvedValueOnce({ cin7Id: "cin7-1", status: "created" });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productsCreated).toBe(1);
    expect(pushProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sku: "PARENT" }),
      expect.anything(),
      [expect.objectContaining({ product_sku: "PARENT", component_sku: "COMP", quantity: 1 })],
      expect.any(Map),
      expect.any(Set)
    );
  });

  it("pushes production BOM versions using the product's synced Cin7 ID", async () => {
    const { db } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [],
      sync_state: [
        { org_id: "org1", instance_id: "inst-1", sku: "FACEBULK001", synced_hash: "h", cin7_id: "cin7-guid-1" },
      ],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [
        { org_id: "org1", product_sku: "FACEBULK001", version: "1", quantity_to_produce: 1000 },
      ],
      production_bom_operations: [],
      production_bom_items: [],
    });
    vi.mocked(pushProductionBom).mockResolvedValueOnce({ status: "created" });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productionBomsPushed).toBe(1);
    expect(summary.productionBomsFailed).toBe(0);
    expect(pushProductionBom).toHaveBeenCalledWith(
      expect.anything(),
      "cin7-guid-1",
      expect.objectContaining({ product_sku: "FACEBULK001" }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("fails a Production BOM push when the product has no synced Cin7 ID yet", async () => {
    const { db } = createFakeDb({
      cin7_instances: [instanceRow],
      products: [],
      sync_state: [],
      price_tiers: [],
      assembly_bom_lines: [],
      production_bom_versions: [
        { org_id: "org1", product_sku: "FACEBULK001", version: "1", quantity_to_produce: 1000 },
      ],
      production_bom_operations: [],
      production_bom_items: [],
    });

    const summary = await syncInstance(db, "org1", "inst-1");

    expect(summary.productionBomsPushed).toBe(0);
    expect(summary.productionBomsFailed).toBe(1);
    expect(pushProductionBom).not.toHaveBeenCalled();
    expect(summary.errors[0].error[0]).toMatch(/no synced Cin7 ID/);
  });

  it("throws if the instance is inactive", async () => {
    const { db } = createFakeDb({ cin7_instances: [{ ...instanceRow, active: false }] });
    await expect(syncInstance(db, "org1", "inst-1")).rejects.toThrow("inactive");
  });
});
