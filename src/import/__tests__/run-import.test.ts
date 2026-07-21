import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runImport } from "@/import/run-import";

/**
 * Minimal in-memory stand-in covering every chain runImport (+ commitCustomerRows,
 * the simplest commit path — no DB-querying reference checks unlike products/
 * assembly_bom/addresses) actually issues: import_batches insert+select+single,
 * import_rows chunked insert + status update, customers/customer_contacts
 * upsert/insert/delete.
 */
function createFakeDb() {
  const inserts: Record<string, Record<string, unknown>[][]> = {};
  const upserts: Record<string, Record<string, unknown>[]> = {};
  let batchSeq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "delete" | "update" | null = null;
    let updatePayload: Record<string, unknown> = {};
    const api = {
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        inserts[table] = [...(inserts[table] ?? []), rows];
        if (table === "import_batches") {
          batchSeq += 1;
          const id = `batch-${batchSeq}`;
          return {
            select: () => ({ single: async () => ({ data: { id }, error: null }) }),
          };
        }
        return Promise.resolve({ error: null });
      },
      upsert: async (payload: Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...payload];
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => {
        mode = "update";
        updatePayload = payload;
        return api;
      },
      delete: () => {
        mode = "delete";
        return api;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: unknown) => {
        filters[col] = vals;
        return api;
      },
      then: (resolve: (v: { error: null }) => void) => {
        void mode;
        void updatePayload;
        void filters;
        resolve({ error: null });
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, inserts, upserts };
}

/**
 * Builds CSV text for `n` minimal-but-valid Customers rows — only Name is
 * required (model/customers.ts). A second column is included since Papaparse
 * can't auto-detect a delimiter in a genuinely single-column file.
 */
function customersCsv(n: number): string {
  const lines = ["Name,Status"];
  for (let i = 1; i <= n; i++) lines.push(`Customer ${i},Active`);
  return lines.join("\n");
}

describe("runImport — import_rows chunked insert", () => {
  it("splits a large batch into multiple import_rows inserts, none exceeding the chunk size, covering every row", async () => {
    const { db, inserts } = createFakeDb();
    const rowCount = 1200;

    const result = await runImport(db, "org1", "customers", "customers.csv", customersCsv(rowCount));

    expect(result.rowCount).toBe(rowCount);
    expect(result.committed).toBe(true);

    const rowsCalls = inserts.import_rows ?? [];
    expect(rowsCalls.length).toBe(3); // 1200 rows / 500-per-chunk = 3 calls (500, 500, 200)
    for (const chunk of rowsCalls) expect(chunk.length).toBeLessThanOrEqual(500);
    const totalInserted = rowsCalls.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalInserted).toBe(rowCount);

    // Every row_number from 1..rowCount appears exactly once across all chunks.
    const allRowNumbers = rowsCalls.flatMap((chunk) => chunk.map((r) => r.row_number)).sort((a, b) => (a as number) - (b as number));
    expect(allRowNumbers).toEqual(Array.from({ length: rowCount }, (_, i) => i + 1));
  });

  it("still does just one import_rows insert for a small batch", async () => {
    const { db, inserts } = createFakeDb();
    await runImport(db, "org1", "customers", "customers.csv", customersCsv(3));
    expect(inserts.import_rows?.length).toBe(1);
    expect(inserts.import_rows?.[0]).toHaveLength(3);
  });
});
