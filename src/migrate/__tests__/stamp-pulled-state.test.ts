import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PULLED_STATUS, stampPulledState } from "@/migrate/stamp-pulled-state";

type Row = Record<string, unknown>;

/** In-memory db: serves the canonical (key, content_hash) page read and records every upsert into the sync-state tables. */
function fakeDb(canonical: Record<string, Row[]>) {
  const upserts: { table: string; rows: Row[]; onConflict?: string }[] = [];
  const reads: string[] = [];
  const db = {
    from: (table: string) => ({
      select: () => {
        reads.push(table);
        const api = { eq: () => api, order: () => api, range: async (from: number, to: number) => ({ data: (canonical[table] ?? []).slice(from, to + 1), error: null }) };
        return api;
      },
      upsert: async (rows: Row[], opts?: { onConflict?: string }) => { upserts.push({ table, rows, onConflict: opts?.onConflict }); return { error: null }; },
    }),
  } as unknown as SupabaseClient;
  return { db, upserts, reads };
}
const clean = { committed: true, errorCount: 0 };

describe("stampPulledState", () => {
  it("records each pulled product as synced to the source instance at its CURRENT content hash, and nothing else", async () => {
    const { db, upserts } = fakeDb({ products: [{ sku: "A", content_hash: "h-a" }, { sku: "B", content_hash: "h-b" }, { sku: "LOCAL-ONLY", content_hash: "h-l" }] });
    const n = await stampPulledState(db, "org1", "inst-src", "products", ["A", "B", "NOT-CANONICAL"], clean);
    expect(n).toBe(2);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("sync_state");
    expect(upserts[0].onConflict).toBe("org_id,instance_id,sku");
    expect(upserts[0].rows.map((r) => [r.sku, r.synced_hash, r.instance_id, r.last_status])).toEqual([["A", "h-a", "inst-src", PULLED_STATUS], ["B", "h-b", "inst-src", PULLED_STATUS]]);
  });

  it("clears a pulled product's failure history, and never writes cin7_id (an existing id is kept for the push fast path)", async () => {
    const { db, upserts } = fakeDb({ products: [{ sku: "A", content_hash: "h" }] });
    await stampPulledState(db, "org1", "inst-src", "products", ["A"], clean);
    const row = upserts[0].rows[0];
    expect(row).toMatchObject({ failure_class: null, failure_fingerprint: null, consecutive_failures: 0, next_retry_at: null, last_error: null });
    expect("cin7_id" in row).toBe(false);
  });

  it("customers and suppliers use their own state tables keyed by name, without product-only failure columns", async () => {
    const c = fakeDb({ customers: [{ name: "Acme", content_hash: "h1" }] });
    await stampPulledState(c.db, "org1", "inst-src", "customers", ["Acme"], clean);
    expect(c.upserts[0]).toMatchObject({ table: "customer_sync_state", onConflict: "org_id,instance_id,name" });
    expect("failure_class" in c.upserts[0].rows[0]).toBe(false);
    const s = fakeDb({ suppliers: [{ name: "Sup", content_hash: "h2" }] });
    await stampPulledState(s.db, "org1", "inst-src", "suppliers", ["Sup"], clean);
    expect(s.upserts[0]).toMatchObject({ table: "supplier_sync_state", onConflict: "org_id,instance_id,name" });
  });

  it.each([
    ["the import did not commit", { committed: false, errorCount: 0 }],
    ["any row was invalid (it kept its old canonical content, so it does not match Cin7)", { committed: true, errorCount: 1 }],
    ["there is no import result", undefined],
  ])("records nothing when %s", async (_why, result) => {
    const { db, upserts, reads } = fakeDb({ products: [{ sku: "A", content_hash: "h" }] });
    expect(await stampPulledState(db, "org1", "inst-src", "products", ["A"], result)).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("records nothing and reads nothing when the pull returned no keys", async () => {
    const { db, upserts, reads } = fakeDb({ products: [{ sku: "A", content_hash: "h" }] });
    expect(await stampPulledState(db, "org1", "inst-src", "products", [], clean)).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("upserts a large pull in chunks of 500", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ sku: `S${i}`, content_hash: `h${i}` }));
    const { db, upserts } = fakeDb({ products: rows });
    const n = await stampPulledState(db, "org1", "inst-src", "products", rows.map((r) => r.sku), clean);
    expect(n).toBe(1200);
    expect(upserts.map((u) => u.rows.length)).toEqual([500, 500, 200]);
  });

  it("surfaces a failed upsert instead of reporting the pull as safe", async () => {
    const db = {
      from: () => ({
        select: () => { const api = { eq: () => api, order: () => api, range: async () => ({ data: [{ sku: "A", content_hash: "h" }], error: null }) }; return api; },
        upsert: vi.fn().mockResolvedValue({ error: { message: "boom" } }),
      }),
    } as unknown as SupabaseClient;
    await expect(stampPulledState(db, "org1", "inst-src", "products", ["A"], clean)).rejects.toThrow(/already in sync failed: boom/);
  });
});
