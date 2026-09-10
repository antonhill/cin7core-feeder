import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchesSearch } from "../../text-search";
import {
  getOrderFulfillmentPage,
  getOrderFulfillmentTabCounts,
  getOrderFulfillmentLinesForSales,
  ORDER_FULFILLMENT_PAGE_SIZE,
  ReportQueryError,
  type OrderFulfillmentTab,
} from "@/reports/query";
import type { SupabaseClient } from "@supabase/supabase-js";

function stubPageRpc(result: { data: unknown; error: { message: string } | null }) {
  const single = vi.fn(() => Promise.resolve(result));
  const rpc = vi.fn(() => ({ single }));
  return { rpc, single };
}
function stubCountsRpc(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(() => Promise.resolve(result));
  const rpc = vi.fn(() => ({ maybeSingle }));
  return { rpc };
}

const envelope = (rows: unknown[], total?: number) => ({
  data: { total_count: total ?? rows.length, rows },
  error: null,
});

describe("getOrderFulfillmentPage — which SQL function each tab uses", () => {
  it.each([
    ["pick", "report_order_fulfillment_queue_page_json", "pick"],
    ["ship", "report_order_fulfillment_queue_page_json", "ship"],
    ["readyToInvoice", "report_order_fulfillment_queue_page_json", "invoice"],
    ["boxLabel", "report_order_fulfillment_queue_page_json", "box_label"],
  ] as [OrderFulfillmentTab, string, string][])(
    "%s -> %s with p_queue=%s",
    async (tab, fn, queueArg) => {
      const { rpc } = stubPageRpc(envelope([]));
      const db = { rpc } as unknown as SupabaseClient;
      await getOrderFulfillmentPage(db, "org1", { tab });
      expect(rpc).toHaveBeenCalledWith(fn, expect.objectContaining({ p_queue: queueArg }));
    }
  );

  it("All Orders uses the unbounded path with no queue predicate", async () => {
    // Measured: routing All Orders through the id-driven path was 2,459ms
    // against 1,369ms. This assertion is the guard on that decision.
    const { rpc } = stubPageRpc(envelope([]));
    const db = { rpc } as unknown as SupabaseClient;
    await getOrderFulfillmentPage(db, "org1", { tab: "all" });
    expect(rpc).toHaveBeenCalledWith("report_order_fulfillment_all_page_json", expect.objectContaining({ p_queue: null }));
  });

  it("defaults to a 100-row page at offset 0", async () => {
    const { rpc } = stubPageRpc(envelope([]));
    const db = { rpc } as unknown as SupabaseClient;
    await getOrderFulfillmentPage(db, "org1", { tab: "pick" });
    expect(ORDER_FULFILLMENT_PAGE_SIZE).toBe(100);
    expect(rpc).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ p_limit: 100, p_offset: 0 }));
  });

  it("forwards every filter, the search and the sort", async () => {
    const { rpc } = stubPageRpc(envelope([]));
    const db = { rpc } as unknown as SupabaseClient;
    await getOrderFulfillmentPage(db, "org1", {
      tab: "all",
      instanceIds: ["i1"],
      fromDate: "2025-09-10",
      search: "widget",
      paymentStatus: "PAID",
      shipByFrom: "2026-01-01",
      shipByTo: "2026-02-01",
      backorder: "backorder",
      backorderPo: "no_po",
      invoiceCoverage: "partially_invoiced",
      sort: "shipBy",
      sortDir: "desc",
      limit: 25,
      offset: 50,
    });
    expect(rpc).toHaveBeenCalledWith("report_order_fulfillment_all_page_json", {
      p_org_id: "org1",
      p_instance_ids: ["i1"],
      p_from_date: "2025-09-10",
      p_queue: null,
      p_search: "widget",
      p_payment_status: "PAID",
      p_ship_by_from: "2026-01-01",
      p_ship_by_to: "2026-02-01",
      p_backorder: "backorder",
      p_backorder_po: "no_po",
      p_invoice_coverage: "partially_invoiced",
      p_sort: "shipBy",
      p_sort_dir: "desc",
      p_limit: 25,
      p_offset: 50,
    });
  });

  it("sends nulls for absent filters, and treats backorder='all' as no filter", async () => {
    const { rpc } = stubPageRpc(envelope([]));
    const db = { rpc } as unknown as SupabaseClient;
    await getOrderFulfillmentPage(db, "org1", { tab: "all", backorder: "all", search: "   " });
    expect(rpc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ p_backorder: null, p_search: null, p_payment_status: null, p_sort: null })
    );
  });

  it("returns the filtered total alongside the page, so the pager is not derived from row count", async () => {
    const { rpc } = stubPageRpc(envelope([{ cin7_sale_id: "s1" }], 8556));
    const db = { rpc } as unknown as SupabaseClient;
    const page = await getOrderFulfillmentPage(db, "org1", { tab: "all" });
    expect(page.rows).toHaveLength(1);
    expect(page.totalCount).toBe(8556);
  });

  it("hides a raw failure but keeps it for the log", async () => {
    const { rpc } = stubPageRpc({ data: null, error: { message: "canceling statement due to statement timeout" } });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getOrderFulfillmentPage(db, "org1", { tab: "pick" })).rejects.toThrow(ReportQueryError);
    await getOrderFulfillmentPage(db, "org1", { tab: "pick" }).catch((e) => {
      expect((e as ReportQueryError).message).toBe("The report could not be loaded. Please try again.");
      expect((e as ReportQueryError).technicalMessage).toContain("statement timeout");
    });
  });
});

describe("getOrderFulfillmentTabCounts", () => {
  it("maps all nine counts", async () => {
    const { rpc } = stubCountsRpc({
      data: {
        all_count: 8556, pick_count: 52, ship_count: 281, ready_to_invoice_count: 33, box_label_count: 70,
        pick_floor_count: 1, ship_floor_count: 2, ready_to_invoice_floor_count: 3, box_label_floor_count: 4,
      },
      error: null,
    });
    const db = { rpc } as unknown as SupabaseClient;
    const counts = await getOrderFulfillmentTabCounts(db, "org1", { fromDate: "2025-09-10" });
    expect(counts).toEqual({
      allCount: 8556, pickCount: 52, shipCount: 281, readyToInvoiceCount: 33, boxLabelCount: 70,
      pickFloorCount: 1, shipFloorCount: 2, readyToInvoiceFloorCount: 3, boxLabelFloorCount: 4,
    });
    expect(rpc).toHaveBeenCalledWith("report_order_fulfillment_tab_counts", {
      p_org_id: "org1", p_instance_ids: null, p_from_date: "2025-09-10",
    });
  });

  it("throws rather than reporting zeros when no row comes back", async () => {
    const { rpc } = stubCountsRpc({ data: null, error: null });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getOrderFulfillmentTabCounts(db, "org1", {})).rejects.toThrow(ReportQueryError);
  });
});

describe("getOrderFulfillmentLinesForSales", () => {
  it("asks for the explicit sale ids only", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ cin7_sale_id: "s1" }], error: null });
    const db = { rpc } as unknown as SupabaseClient;
    await getOrderFulfillmentLinesForSales(db, "org1", ["s1", "s2"], ["i1"]);
    expect(rpc).toHaveBeenCalledWith("report_order_fulfillment_lines_fs", {
      p_org_id: "org1", p_instance_ids: ["i1"], p_sale_ids: ["s1", "s2"],
    });
  });

  it("short-circuits an empty list without a round trip — never fetches the whole org", async () => {
    const rpc = vi.fn();
    const db = { rpc } as unknown as SupabaseClient;
    await expect(getOrderFulfillmentLinesForSales(db, "org1", [])).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("search contract: the SQL implements matchesSearch, not ILIKE", () => {
  const raw = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "0091_order_fulfillment_server_paging.sql"),
    "utf8"
  );
  const sql = raw;
  /** Statement bodies only — the file's comments discuss ILIKE deliberately, to say why it is not used. */
  const executable = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("matches all four fields the client matched", () => {
    for (const field of ["r.order_number", "r.customer_name", "ol.product_sku", "ol.product_name"]) {
      expect(sql, `${field} is not searched`).toContain(`lower(coalesce(${field}, ''))`);
    }
  });

  it("uses position()/lower(), never ILIKE — so % and _ stay literal", () => {
    // matchesSearch is `field.toLowerCase().includes(needle)`. ILIKE '%..%'
    // would silently give a user's `%` wildcard meaning it never had.
    expect(executable).toContain("position(lower(btrim(p_search)) in lower(coalesce(");
    expect(executable).not.toMatch(/ilike/i);
  });

  it("treats a blank or whitespace-only search as no filter, like matchesSearch does", () => {
    expect(matchesSearch("   ", "anything")).toBe(true);
    expect(sql).toContain("p_search is null or btrim(p_search) = ''");
  });

  it("matchesSearch is a plain case-insensitive substring — the behaviour SQL must copy", () => {
    expect(matchesSearch("WIDGET", "Blue widget XL")).toBe(true);
    expect(matchesSearch("idge", "Blue widget XL")).toBe(true);
    expect(matchesSearch("%", "Blue widget XL")).toBe(false);
    expect(matchesSearch("x", null)).toBe(false);
  });
});
