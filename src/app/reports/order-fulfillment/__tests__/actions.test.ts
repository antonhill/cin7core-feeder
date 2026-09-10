import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  loadOrderFulfillmentPageAction,
  loadOrderFulfillmentLinesAction,
  exportOrderFulfillmentXlsxAction,
  markBoxLabelPrintedAction,
} from "../actions";
import { requireModuleAccess } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import {
  getOrderFulfillmentPage,
  getOrderFulfillmentTabCounts,
  getOrderFulfillmentLinesForSales,
  ReportQueryError,
  type OrderFulfillmentRow,
  type OrderFulfillmentTableQuery,
} from "@/reports/query";
import { buildOrderFulfillmentSheet } from "@/reports/order-fulfillment-export";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/sales", () => ({ fetchSaleDetail: vi.fn() }));
vi.mock("@/reports/order-fulfillment-export", () => ({ buildOrderFulfillmentSheet: vi.fn(() => ({ rows: [] })) }));
vi.mock("@/reports/xlsx-writer", () => ({ renderXlsxBase64: vi.fn(async () => "BASE64") }));
vi.mock("@/reports/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/reports/query")>();
  return {
    ...actual,
    getOrderFulfillmentPage: vi.fn(),
    getOrderFulfillmentTabCounts: vi.fn(),
    getOrderFulfillmentLinesForSales: vi.fn(),
  };
});

const row = (id: string) => ({ cin7_sale_id: id, ready_for_box_label_qty: 0 }) as unknown as OrderFulfillmentRow;
const COUNTS = {
  allCount: 8556, pickCount: 52, shipCount: 281, readyToInvoiceCount: 33, boxLabelCount: 70,
  pickFloorCount: 0, shipFloorCount: 0, readyToInvoiceFloorCount: 0, boxLabelFloorCount: 0,
};
const QUERY: OrderFulfillmentTableQuery = { tab: "pick" };

function fakeDb() {
  return { from: () => ({ upsert: async () => ({ error: null }) }) };
}

describe("loadOrderFulfillmentPageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "u1", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb() as never);
    vi.mocked(getOrderFulfillmentPage).mockResolvedValue({ totalCount: 52, rows: [row("s1"), row("s2")] });
    vi.mocked(getOrderFulfillmentTabCounts).mockResolvedValue(COUNTS);
    vi.mocked(getOrderFulfillmentLinesForSales).mockResolvedValue([]);
  });

  it("returns a page, the nine counts, and the page's lines", async () => {
    const result = await loadOrderFulfillmentPageAction(QUERY);
    expect(result.ok).toBe(true);
    expect(result.data?.page.totalCount).toBe(52);
    expect(result.data?.counts).toEqual(COUNTS);
  });

  it("fetches lines for the page's sale ids ONLY", async () => {
    await loadOrderFulfillmentPageAction(QUERY);
    // The whole point: never every line the org has.
    expect(getOrderFulfillmentLinesForSales).toHaveBeenCalledWith(expect.anything(), "org1", ["s1", "s2"], undefined);
  });

  it("does not derive counts from the page", async () => {
    // A 2-row page must still report the real tab counts.
    const result = await loadOrderFulfillmentPageAction(QUERY);
    expect(result.data?.page.rows).toHaveLength(2);
    expect(result.data?.counts.pickCount).toBe(52);
    expect(getOrderFulfillmentTabCounts).toHaveBeenCalledTimes(1);
  });

  it("takes the org from the session, never from the caller's query", async () => {
    // service_role bypasses RLS, so requireModuleAccess is the only tenant boundary.
    await loadOrderFulfillmentPageAction({ ...QUERY, orgId: "other-org" } as never);
    for (const call of [getOrderFulfillmentPage, getOrderFulfillmentTabCounts, getOrderFulfillmentLinesForSales]) {
      expect(vi.mocked(call).mock.calls[0][1]).toBe("org1");
    }
  });

  it("forwards the instance filter to every call", async () => {
    await loadOrderFulfillmentPageAction({ tab: "ship", instanceIds: ["i1"] });
    expect(getOrderFulfillmentPage).toHaveBeenCalledWith(expect.anything(), "org1", expect.objectContaining({ instanceIds: ["i1"] }));
    expect(getOrderFulfillmentLinesForSales).toHaveBeenCalledWith(expect.anything(), "org1", ["s1", "s2"], ["i1"]);
  });

  it("reports a database timeout as the safe message, not the raw text", async () => {
    vi.mocked(getOrderFulfillmentPage).mockRejectedValue(
      new ReportQueryError("report_order_fulfillment_queue_page_json: canceling statement due to statement timeout")
    );
    const result = await loadOrderFulfillmentPageAction(QUERY);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The report could not be loaded. Please try again.");
    expect(result.error).not.toContain("statement timeout");
    expect(result.error).not.toContain("report_order_fulfillment");
  });
});

describe("loadOrderFulfillmentLinesAction — expanded row / batch pick list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "u1", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb() as never);
    vi.mocked(getOrderFulfillmentLinesForSales).mockResolvedValue([]);
  });

  it("asks for one order when a row is expanded", async () => {
    await loadOrderFulfillmentLinesAction(["s7"]);
    expect(getOrderFulfillmentLinesForSales).toHaveBeenCalledWith(expect.anything(), "org1", ["s7"], undefined);
  });

  it("asks for exactly the selected orders for a batch pick list, which may span pages", async () => {
    await loadOrderFulfillmentLinesAction(["s1", "s40", "s99"], ["i1"]);
    expect(getOrderFulfillmentLinesForSales).toHaveBeenCalledWith(expect.anything(), "org1", ["s1", "s40", "s99"], ["i1"]);
  });

  it("uses the session org, not a caller-supplied one", async () => {
    await loadOrderFulfillmentLinesAction(["s1"]);
    expect(vi.mocked(getOrderFulfillmentLinesForSales).mock.calls[0][1]).toBe("org1");
  });
});

describe("exportOrderFulfillmentXlsxAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "u1", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb() as never);
  });

  it("exports the COMPLETE filtered set, not the visible page", async () => {
    // 4,500 rows across three 2,000-row chunks.
    const total = 4_500;
    vi.mocked(getOrderFulfillmentPage).mockImplementation(async (_db, _org, q) => {
      const offset = q.offset ?? 0;
      const size = Math.min(q.limit ?? 2000, Math.max(0, total - offset));
      return { totalCount: total, rows: Array.from({ length: size }, (_, i) => row(`s${offset + i}`)) };
    });

    const result = await exportOrderFulfillmentXlsxAction({ tab: "all" });

    expect(result.ok).toBe(true);
    expect(vi.mocked(buildOrderFulfillmentSheet).mock.calls[0][0]).toHaveLength(total);
    expect(getOrderFulfillmentPage).toHaveBeenCalledTimes(3);
  });

  it("chunks in bounded statements rather than one huge json_agg", async () => {
    vi.mocked(getOrderFulfillmentPage).mockResolvedValue({ totalCount: 1, rows: [row("s1")] });
    await exportOrderFulfillmentXlsxAction({ tab: "all" });
    // Each call is its own bounded statement — an 8,500-row json_agg measured
    // 2,075-6,936ms, i.e. at the 8s ceiling this stream exists to clear.
    expect(getOrderFulfillmentPage).toHaveBeenCalledWith(expect.anything(), "org1", expect.objectContaining({ limit: 2000, offset: 0 }));
  });

  it("uses the SAME query contract as the table", async () => {
    vi.mocked(getOrderFulfillmentPage).mockResolvedValue({ totalCount: 0, rows: [] });
    await exportOrderFulfillmentXlsxAction({ tab: "ship", search: "widget", paymentStatus: "PAID", invoiceCoverage: "invoiced" });
    expect(getOrderFulfillmentPage).toHaveBeenCalledWith(
      expect.anything(), "org1",
      expect.objectContaining({ tab: "ship", search: "widget", paymentStatus: "PAID", invoiceCoverage: "invoiced" })
    );
  });

  it("refuses past the row ceiling instead of building an unbounded file", async () => {
    vi.mocked(getOrderFulfillmentPage).mockImplementation(async (_db, _org, q) => ({
      totalCount: 200_000,
      rows: Array.from({ length: q.limit ?? 2000 }, (_, i) => row(`s${(q.offset ?? 0) + i}`)),
    }));
    const result = await exportOrderFulfillmentXlsxAction({ tab: "all" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("narrow your filters");
  });

  it("never receives rows from the browser", async () => {
    // The old signature took the client's filtered array (hence
    // next.config.ts's 10mb bodySizeLimit). The query is all it takes now.
    vi.mocked(getOrderFulfillmentPage).mockResolvedValue({ totalCount: 0, rows: [] });
    await exportOrderFulfillmentXlsxAction({ tab: "all" });
    expect(exportOrderFulfillmentXlsxAction.length).toBeLessThanOrEqual(2);
  });
});

describe("markBoxLabelPrintedAction — targeted, not a full scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "u1", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb() as never);
  });

  it("reads line quantities for the ONE sale id, scoped to its instance", async () => {
    // It used to call report_order_fulfillment_lines with no date filter and
    // narrow with PostgREST .eq() — ~30,510 rows computed to read one order.
    vi.mocked(getOrderFulfillmentLinesForSales).mockResolvedValue([
      { cin7_sale_id: "s5", ready_for_box_label_qty: 4 },
      { cin7_sale_id: "s5", ready_for_box_label_qty: 2 },
    ] as never);

    const result = await markBoxLabelPrintedAction("i1", "s5");

    expect(result.ok).toBe(true);
    expect(getOrderFulfillmentLinesForSales).toHaveBeenCalledWith(expect.anything(), "org1", ["s5"], ["i1"]);
  });

  it("sums ready_for_box_label_qty across the order's lines", async () => {
    const upsert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));
    vi.mocked(createServiceRoleClient).mockReturnValue({ from: () => ({ upsert }) } as never);
    vi.mocked(getOrderFulfillmentLinesForSales).mockResolvedValue([
      { cin7_sale_id: "s5", ready_for_box_label_qty: 4 },
      { cin7_sale_id: "s5", ready_for_box_label_qty: 2 },
    ] as never);

    await markBoxLabelPrintedAction("i1", "s5");

    expect(upsert.mock.calls[0][0]).toMatchObject({ ready_qty_at_mark: 6, cin7_sale_id: "s5", org_id: "org1" });
  });
});
