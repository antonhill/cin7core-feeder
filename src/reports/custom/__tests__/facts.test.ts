import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSalesFacts, getInventoryMovementFacts } from "@/reports/custom/facts";

function makeRpcDb(rows: unknown[]) {
  const rpc = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: rows, error: null }) });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe("getSalesFacts", () => {
  it("calls report_sales_facts with null defaults for unset filters, capped at the row limit", async () => {
    const { db, rpc } = makeRpcDb([{ product_sku: "SKU-1" }]);

    const rows = await getSalesFacts(db, "org1", {});

    expect(rows).toEqual([{ product_sku: "SKU-1" }]);
    expect(rpc).toHaveBeenCalledWith("report_sales_facts", { p_org_id: "org1", p_instance_ids: null, p_date_from: null, p_date_to: null });
  });

  it("passes through provided filters", async () => {
    const { db, rpc } = makeRpcDb([]);
    await getSalesFacts(db, "org1", { instanceIds: ["inst-1"], dateFrom: "2026-01-01", dateTo: "2026-06-30" });
    expect(rpc).toHaveBeenCalledWith("report_sales_facts", {
      p_org_id: "org1",
      p_instance_ids: ["inst-1"],
      p_date_from: "2026-01-01",
      p_date_to: "2026-06-30",
    });
  });

  it("throws a clear error when the row cap is exceeded", async () => {
    const bigRows = Array.from({ length: 20001 }, (_, i) => ({ product_sku: `SKU-${i}` }));
    const { db } = makeRpcDb(bigRows);
    await expect(getSalesFacts(db, "org1", {})).rejects.toThrow(/narrow your date range/i);
  });

  it("throws with the underlying error message on failure", async () => {
    const rpc = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getSalesFacts(db, "org1", {})).rejects.toThrow("report_sales_facts: boom");
  });
});

describe("getInventoryMovementFacts", () => {
  it("calls report_inventory_movement_lines with the same filter shape", async () => {
    const { db, rpc } = makeRpcDb([{ product_sku: "SKU-1", source: "purchases" }]);
    const rows = await getInventoryMovementFacts(db, "org1", { instanceIds: ["inst-1"] });
    expect(rows).toEqual([{ product_sku: "SKU-1", source: "purchases" }]);
    expect(rpc).toHaveBeenCalledWith("report_inventory_movement_lines", {
      p_org_id: "org1",
      p_instance_ids: ["inst-1"],
      p_date_from: null,
      p_date_to: null,
    });
  });

  it("throws with the underlying error message on failure", async () => {
    const rpc = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getInventoryMovementFacts(db, "org1", {})).rejects.toThrow("report_inventory_movement_lines: boom");
  });
});
