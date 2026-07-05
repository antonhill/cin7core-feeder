import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProductSalesReport, getProductSalesPivotData, getSaleLineDetails, getReportFilterOptions, getSalesSyncStatus } from "@/reports/query";

describe("getProductSalesReport", () => {
  it("calls the report_sales_by_product RPC with null defaults for unset filters", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ product_sku: "SKU-1", revenue: 100 }], error: null });
    const db = { rpc } as unknown as SupabaseClient;

    const rows = await getProductSalesReport(db, "org1", {});

    expect(rows).toEqual([{ product_sku: "SKU-1", revenue: 100 }]);
    expect(rpc).toHaveBeenCalledWith("report_sales_by_product", {
      p_org_id: "org1",
      p_instance_ids: null,
      p_location: null,
      p_category_code: null,
      p_date_from: null,
      p_date_to: null,
    });
  });

  it("passes through every provided filter", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { rpc } as unknown as SupabaseClient;

    await getProductSalesReport(db, "org1", {
      instanceIds: ["inst-1", "inst-2"],
      location: "Main Warehouse",
      categoryCode: "WIDGETS",
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
    });

    expect(rpc).toHaveBeenCalledWith("report_sales_by_product", {
      p_org_id: "org1",
      p_instance_ids: ["inst-1", "inst-2"],
      p_location: "Main Warehouse",
      p_category_code: "WIDGETS",
      p_date_from: "2026-01-01",
      p_date_to: "2026-06-30",
    });
  });

  it("throws with the underlying error message on failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getProductSalesReport(db, "org1", {})).rejects.toThrow("report_sales_by_product: boom");
  });
});

function makeSaleLinesChain(rows: unknown[]) {
  const calls: { op: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {
    eq: (...args: unknown[]) => {
      calls.push({ op: "eq", args });
      return chain;
    },
    in: (...args: unknown[]) => {
      calls.push({ op: "in", args });
      return chain;
    },
    gte: (...args: unknown[]) => {
      calls.push({ op: "gte", args });
      return chain;
    },
    lte: (...args: unknown[]) => {
      calls.push({ op: "lte", args });
      return chain;
    },
    order: (...args: unknown[]) => {
      calls.push({ op: "order", args });
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { chain, calls };
}

describe("getProductSalesPivotData", () => {
  it("maps groupBy to the two boolean RPC params", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { rpc } as unknown as SupabaseClient;

    await getProductSalesPivotData(db, "org1", {}, "location");
    expect(rpc).toHaveBeenCalledWith("report_sales_pivot", expect.objectContaining({ p_group_by_location: true, p_group_by_category: false }));

    await getProductSalesPivotData(db, "org1", {}, "category");
    expect(rpc).toHaveBeenCalledWith("report_sales_pivot", expect.objectContaining({ p_group_by_location: false, p_group_by_category: true }));

    await getProductSalesPivotData(db, "org1", {}, "both");
    expect(rpc).toHaveBeenCalledWith("report_sales_pivot", expect.objectContaining({ p_group_by_location: true, p_group_by_category: true }));
  });

  it("passes through filters the same way as getProductSalesReport", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = { rpc } as unknown as SupabaseClient;

    await getProductSalesPivotData(db, "org1", { instanceIds: ["inst-1"], dateFrom: "2026-01-01", dateTo: "2026-06-30" }, "location");

    expect(rpc).toHaveBeenCalledWith("report_sales_pivot", {
      p_org_id: "org1",
      p_instance_ids: ["inst-1"],
      p_location: null,
      p_category_code: null,
      p_date_from: "2026-01-01",
      p_date_to: "2026-06-30",
      p_group_by_location: true,
      p_group_by_category: false,
    });
  });

  it("throws with the underlying error message on failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getProductSalesPivotData(db, "org1", {}, "location")).rejects.toThrow("report_sales_pivot: boom");
  });
});

describe("getSaleLineDetails", () => {
  it("maps the joined sales.location/customer_name onto flat rows", async () => {
    const { chain } = makeSaleLinesChain([
      {
        invoice_number: "INV-1",
        invoice_date: "2026-06-01",
        product_sku: "SKU-1",
        product_name: "Widget",
        quantity: 2,
        price: 10,
        total: 20,
        average_cost: 4,
        instance_id: "inst-1",
        sales: { location: "Main Warehouse", customer_name: "Acme" },
      },
    ]);
    const db = { from: () => ({ select: () => chain }) } as unknown as SupabaseClient;

    const rows = await getSaleLineDetails(db, "org1", {});

    expect(rows).toEqual([
      {
        invoiceNumber: "INV-1",
        invoiceDate: "2026-06-01",
        productSku: "SKU-1",
        productName: "Widget",
        quantity: 2,
        price: 10,
        total: 20,
        averageCost: 4,
        instanceId: "inst-1",
        location: "Main Warehouse",
        customerName: "Acme",
      },
    ]);
  });

  it("applies instance/product/date/location filters when provided", async () => {
    const { chain, calls } = makeSaleLinesChain([]);
    const db = { from: () => ({ select: () => chain }) } as unknown as SupabaseClient;

    await getSaleLineDetails(db, "org1", {
      instanceIds: ["inst-1"],
      productSku: "SKU-1",
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
      location: "Main Warehouse",
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        { op: "in", args: ["instance_id", ["inst-1"]] },
        { op: "eq", args: ["product_sku", "SKU-1"] },
        { op: "gte", args: ["invoice_date", "2026-01-01"] },
        { op: "lte", args: ["invoice_date", "2026-06-30"] },
        { op: "eq", args: ["sales.location", "Main Warehouse"] },
      ])
    );
  });

  it("handles a row with no joined sales record gracefully", async () => {
    const { chain } = makeSaleLinesChain([
      { invoice_number: "INV-1", invoice_date: null, product_sku: null, product_name: null, quantity: null, price: null, total: null, average_cost: null, instance_id: "inst-1", sales: null },
    ]);
    const db = { from: () => ({ select: () => chain }) } as unknown as SupabaseClient;

    const rows = await getSaleLineDetails(db, "org1", {});
    expect(rows[0].location).toBeNull();
    expect(rows[0].customerName).toBeNull();
  });
});

describe("getReportFilterOptions", () => {
  it("dedupes and sorts locations, passes through instances/categories", async () => {
    const db = {
      from: (table: string) => {
        if (table === "cin7_instances") {
          return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [{ id: "inst-1", name: "Spark Demo" }], error: null }) }) }) };
        }
        if (table === "sales") {
          return {
            select: () => ({
              eq: () => ({
                not: () => Promise.resolve({ data: [{ location: "Main Warehouse" }, { location: "Main Warehouse" }, { location: "Secondary" }], error: null }),
              }),
            }),
          };
        }
        if (table === "categories") {
          return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [{ code: "WIDGETS", name: "Widgets" }], error: null }) }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const options = await getReportFilterOptions(db, "org1");

    expect(options.instances).toEqual([{ id: "inst-1", name: "Spark Demo" }]);
    expect(options.locations).toEqual(["Main Warehouse", "Secondary"]);
    expect(options.categories).toEqual([{ code: "WIDGETS", name: "Widgets" }]);
  });
});

describe("getSalesSyncStatus", () => {
  it("returns total and pending-detail counts", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => Promise.resolve({ count: 3, error: null }),
            then: (resolve: (v: unknown) => void) => resolve({ count: 10, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const status = await getSalesSyncStatus(db, "org1");
    expect(status).toEqual({ totalSales: 10, pendingDetail: 3 });
  });
});
