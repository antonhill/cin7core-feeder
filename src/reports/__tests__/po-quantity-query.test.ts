import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPoQuantityReport } from "@/reports/po-quantity-query";

type Row = Record<string, unknown>;

/** Minimal in-memory PostgREST stand-in: applies eq/in filters and range() so tenant scoping is actually exercised. */
function fakeDb(tables: Record<string, Row[]>) {
  const queried: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      const filters: ((r: Row) => boolean)[] = [];
      let slice: [number, number] | null = null;
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
        order: () => b,
        range: (f: number, t: number) => ((slice = [f, t]), b),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
          let data = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (slice) data = data.slice(slice[0], slice[1] + 1);
          return Promise.resolve(resolve({ data, error: null }));
        },
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, queried };
}

const purchase = (org: string, inst: string, id: string, extra: Row = {}) => ({
  org_id: org,
  instance_id: inst,
  cin7_purchase_id: id,
  order_number: `PO-${id}`,
  supplier_name: "S",
  status: "AUTHORISED",
  combined_receiving_status: "NOT RECEIVED",
  order_date: "2026-05-01",
  is_drop_ship: false,
  detail_synced_at: "2026-06-01T10:00:00Z",
  created_at: "2026-05-02T00:00:00Z",
  updated_at: "2026-06-01T09:00:00Z",
  ...extra,
});
const line = (org: string, inst: string, id: string, sku: string, qty: number) => ({ org_id: org, instance_id: inst, cin7_purchase_id: id, product_sku: sku, product_name: sku, quantity: qty });

const tables = () => ({
  cin7_instances: [
    { id: "a1", org_id: "orgA", name: "A1" },
    { id: "b1", org_id: "orgB", name: "B1" },
  ],
  purchases: [purchase("orgA", "a1", "p1"), purchase("orgB", "b1", "p9"), purchase("orgA", "a1", "p2", { order_date: null })],
  purchase_order_lines: [line("orgA", "a1", "p1", "X", 5), line("orgB", "b1", "p9", "Y", 77)],
  purchase_receipt_lines: [line("orgA", "a1", "p1", "X", 2), line("orgB", "b1", "p9", "Y", 77)],
  purchases_sync_state: [{ org_id: "orgA", instance_id: "a1", last_list_synced_at: "2026-07-01T00:00:00Z" }],
});

describe("getPoQuantityReport", () => {
  it("returns only the caller org's data", async () => {
    const { db } = fakeDb(tables());
    const r = await getPoQuantityReport(db, "orgA", {});
    expect(r.rows.map((x) => x.cin7PurchaseId).sort()).toEqual(["p1", "p2"]);
    expect(r.rows.find((x) => x.cin7PurchaseId === "p1")).toMatchObject({ ordered: 5, received: 2, outstanding: 3 });
    expect(r.sync.map((s) => s.instanceId)).toEqual(["a1"]);
  });

  it("ignores another org's instance id passed in the filter and queries nothing further", async () => {
    const { db, queried } = fakeDb(tables());
    const r = await getPoQuantityReport(db, "orgA", { instanceIds: ["b1"] });
    expect(r).toEqual({ rows: [], sync: [], excludedNoOrderDate: 0 });
    expect(queried).toEqual(["cin7_instances"]);
  });

  it("applies the date filter and counts POs excluded for having no order date", async () => {
    const { db } = fakeDb(tables());
    const r = await getPoQuantityReport(db, "orgA", { dateFrom: "2026-01-01" });
    expect(r.rows.map((x) => x.cin7PurchaseId)).toEqual(["p1"]);
    expect(r.excludedNoOrderDate).toBe(1);
  });

  it("pages past 1000 purchase rows instead of truncating", async () => {
    const t = tables();
    t.purchases = Array.from({ length: 1500 }, (_, i) => purchase("orgA", "a1", `p${i}`, { detail_synced_at: null }));
    const { db } = fakeDb(t);
    const r = await getPoQuantityReport(db, "orgA", {});
    expect(r.rows).toHaveLength(1500);
    expect(r.rows.every((x) => x.dataQuality === "detail_not_synced")).toBe(true);
  });
});
