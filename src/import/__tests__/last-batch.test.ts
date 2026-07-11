import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLastImportKeys } from "@/import/last-batch";

/** Minimal in-memory stand-in for the two-table lookup (import_batches then import_rows). */
function createFakeDb(
  batches: { id: string; org_id: string; kind: string; status: string; created_at: string }[],
  rowsByBatch: Record<string, Record<string, unknown>[]>
) {
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;

    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: readonly unknown[]) => {
        filters[col] = { __in: vals };
        return api;
      },
      order: (col: string, opts: { ascending: boolean }) => {
        orderCol = col;
        ascending = opts.ascending;
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      maybeSingle: async () => {
        let rows = batches.filter((b) =>
          Object.entries(filters).every(([k, v]) => {
            const actual = (b as Record<string, unknown>)[k];
            if (v && typeof v === "object" && "__in" in (v as object)) {
              return (v as { __in: readonly unknown[] }).__in.includes(actual);
            }
            return actual === v;
          })
        );
        const col = orderCol;
        if (col) {
          rows = [...rows].sort((a, b) => {
            const av = String((a as Record<string, unknown>)[col]);
            const bv = String((b as Record<string, unknown>)[col]);
            return ascending ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
          });
        }
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        if (table === "import_rows") {
          const batchId = filters.batch_id as string;
          const rows = (rowsByBatch[batchId] ?? []).filter((r) => filters.status === undefined || r.status === filters.status);
          resolve({ data: rows.map((r) => ({ raw: r.raw })), error: null });
        } else {
          resolve({ data: [], error: null });
        }
      },
    };
    void limitN;
    return api;
  }

  return { from: builder } as unknown as SupabaseClient;
}

describe("getLastImportKeys", () => {
  it("returns null when no committed batch of that kind exists yet", async () => {
    const db = createFakeDb([], {});
    expect(await getLastImportKeys(db, "org1", "customers")).toBeNull();
  });

  it("returns the distinct natural keys (Name) from the most recent committed batch", async () => {
    const db = createFakeDb(
      [{ id: "batch1", org_id: "org1", kind: "customers", status: "committed", created_at: "2026-07-01" }],
      {
        batch1: [
          { status: "committed", raw: { Name: "Corefeeder Customer" } },
          { status: "committed", raw: { Name: "Corefeeder Customer" } },
          { status: "committed", raw: { Name: "Zawadi" } },
        ],
      }
    );
    const keys = await getLastImportKeys(db, "org1", "customers");
    expect(keys).toEqual(["Corefeeder Customer", "Zawadi"]);
  });

  it("uses ProductCode as the natural key for products", async () => {
    const db = createFakeDb(
      [{ id: "batch1", org_id: "org1", kind: "products", status: "committed", created_at: "2026-07-01" }],
      { batch1: [{ status: "committed", raw: { ProductCode: "SKU-1" } }] }
    );
    expect(await getLastImportKeys(db, "org1", "products")).toEqual(["SKU-1"]);
  });

  it("real bug found 2026-07-11 (Casa das Natas): an Assembly BOM import is the real 'last import' for products, not a stale earlier Products batch", async () => {
    const db = createFakeDb(
      [
        { id: "products-batch", org_id: "org1", kind: "products", status: "committed", created_at: "2026-07-11T11:31:03Z" },
        { id: "bom-batch", org_id: "org1", kind: "assembly_bom", status: "committed", created_at: "2026-07-11T11:31:49Z" },
      ],
      {
        "products-batch": [{ status: "committed", raw: { ProductCode: "StaleSku" } }],
        "bom-batch": [
          { status: "committed", raw: { ProductSKU: "LisbonClassic1", ComponentSKU: "Napkin" } },
          { status: "committed", raw: { ProductSKU: "LisbonClassic1", ComponentSKU: "NatasCasingStd" } },
          { status: "committed", raw: { ProductSKU: "HappyBerry1", ComponentSKU: "Strawberries" } },
        ],
      }
    );
    const keys = await getLastImportKeys(db, "org1", "products");
    expect(keys).toEqual(["LisbonClassic1", "HappyBerry1"]);
  });

  it("falls back to a Products CSV batch when it really is the most recent (no BOM import since)", async () => {
    const db = createFakeDb(
      [
        { id: "bom-batch", org_id: "org1", kind: "assembly_bom", status: "committed", created_at: "2026-07-11T10:00:00Z" },
        { id: "products-batch", org_id: "org1", kind: "products", status: "committed", created_at: "2026-07-11T11:00:00Z" },
      ],
      {
        "bom-batch": [{ status: "committed", raw: { ProductSKU: "OldBomSku" } }],
        "products-batch": [{ status: "committed", raw: { ProductCode: "FreshSku" } }],
      }
    );
    expect(await getLastImportKeys(db, "org1", "products")).toEqual(["FreshSku"]);
  });

  it("uses ProductSKU as the natural key for a Production BOM batch", async () => {
    const db = createFakeDb(
      [{ id: "batch1", org_id: "org1", kind: "production_bom", status: "committed", created_at: "2026-07-01" }],
      { batch1: [{ status: "committed", raw: { ProductSKU: "SKU-1" } }] }
    );
    expect(await getLastImportKeys(db, "org1", "products")).toEqual(["SKU-1"]);
  });
});
