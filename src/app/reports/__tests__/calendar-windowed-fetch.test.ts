import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadShippingCalendarOrdersAction } from "../shipping-calendar/actions";
import { loadPickingCalendarOrdersAction } from "../picking-calendar/actions";
import { loadInvoicingSchedulerOrdersAction } from "../invoicing-scheduler/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import {
  getOrderFulfillmentReport,
  getOrderFulfillmentLines,
  getReportFilterOptions,
  getCalendarBannerCounts,
  ReportQueryError,
} from "@/reports/query";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/sales", () => ({ updateSaleShipBy: vi.fn(), markSaleShipped: vi.fn(), fetchCarriers: vi.fn() }));
vi.mock("@/lib/ship-by-notifications", () => ({ recordShipByChange: vi.fn() }));
vi.mock("@/reports/query", async (importOriginal) => {
  // toCalendarErrorMessage / ReportQueryError stay real — the point of the
  // error test below is the mapping they perform.
  const actual = await importOriginal<typeof import("@/reports/query")>();
  return {
    ...actual,
    getOrderFulfillmentReport: vi.fn(),
    getOrderFulfillmentLines: vi.fn(),
    getReportFilterOptions: vi.fn(),
    getCalendarBannerCounts: vi.fn(),
  };
});

/**
 * All three calendars render a seven-day grid and all three used to fetch the
 * org's ENTIRE order history to do it — ~30 MB of JSON across two concurrent
 * calls to draw one week, which is what exhausted PostgREST's 8s statement
 * timeout and produced
 * `report_order_fulfillment_json: canceling statement due to statement timeout`.
 *
 * These are the guards on the fix (migration 0090): the window reaches BOTH
 * report calls, the banner counts stay global, and the org is never taken
 * from the caller.
 */
const CALENDARS = [
  ["Shipping Calendar", loadShippingCalendarOrdersAction, "shipping"],
  ["Picking Calendar", loadPickingCalendarOrdersAction, "picking"],
  ["Invoicing Scheduler", loadInvoicingSchedulerOrdersAction, "invoicing"],
] as const;

const WEEKS = [
  ["previous week", "2026-08-31", "2026-09-06"],
  ["current week", "2026-09-07", "2026-09-13"],
  ["next week", "2026-09-14", "2026-09-20"],
] as const;

describe("calendar windowed fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "user1", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(getOrderFulfillmentReport).mockResolvedValue([]);
    vi.mocked(getOrderFulfillmentLines).mockResolvedValue([]);
    vi.mocked(getReportFilterOptions).mockResolvedValue({ instances: [], locations: [], categories: [] });
    vi.mocked(getCalendarBannerCounts).mockResolvedValue({ unscheduledCount: 4264, floorHiddenCount: 12 });
  });

  describe.each(CALENDARS)("%s", (_label, load, calendarKind) => {
    it.each(WEEKS)("passes the %s window to BOTH report calls", async (_w, shipByFrom, shipByTo) => {
      const result = await load({ shipByFrom, shipByTo });

      expect(result.ok).toBe(true);
      for (const call of [getOrderFulfillmentReport, getOrderFulfillmentLines]) {
        expect(call).toHaveBeenCalledWith({}, "org1", expect.objectContaining({ shipByFrom, shipByTo }));
      }
    });

    it("asks for its own calendar's banner counts, unwindowed", async () => {
      await load({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13", instanceIds: ["inst-1"] });

      expect(getCalendarBannerCounts).toHaveBeenCalledWith({}, "org1", calendarKind, ["inst-1"]);
      // The counts are global facts: the window must NOT be forwarded to them,
      // or "N orders have no Ship By date" would be scoped to a week that no
      // date-less order can belong to (measured: 106 reported instead of 4,264).
      expect(vi.mocked(getCalendarBannerCounts).mock.calls[0]).toHaveLength(4);
    });

    it("takes the org from the session, never from the caller's filters", async () => {
      // Org isolation on this path comes entirely from requireModuleAccess:
      // the queries run as service_role, which BYPASSES RLS, so `orgId` being
      // the session's is the only thing keeping one tenant out of another's
      // orders. A filters object can never introduce an org.
      await load({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13", instanceIds: ["inst-1"], orgId: "other-org" } as never);

      for (const call of [getOrderFulfillmentReport, getOrderFulfillmentLines, getCalendarBannerCounts]) {
        expect(vi.mocked(call).mock.calls[0][1]).toBe("org1");
      }
      expect(requireModuleAccess).toHaveBeenCalledTimes(1);
    });

    it("reports a database timeout as a retry message, not the raw function name", async () => {
      vi.mocked(getOrderFulfillmentReport).mockRejectedValue(
        new ReportQueryError("report_order_fulfillment_json: canceling statement due to statement timeout")
      );

      const result = await load({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("The report could not be loaded. Please try again.");
      expect(result.error).not.toContain("report_order_fulfillment_json");
      expect(result.error).not.toContain("statement timeout");
    });

    it("still surfaces an actionable error verbatim", async () => {
      vi.mocked(getOrderFulfillmentReport).mockRejectedValue(
        new Error("This report matched over 75,000 rows — narrow your filters (date range, instance selection) and try again.")
      );

      const result = await load({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("narrow your filters");
    });
  });

  it("surfaces the global banner counts to Shipping Calendar", async () => {
    const result = await loadShippingCalendarOrdersAction({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });
    expect(result.data?.unscheduledCount).toBe(4264);
    expect(result.data?.floorHiddenCount).toBe(12);
  });

  it("surfaces the global banner counts to Picking Calendar", async () => {
    const result = await loadPickingCalendarOrdersAction({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });
    expect(result.data?.unscheduledCount).toBe(4264);
    expect(result.data?.floorHiddenCount).toBe(12);
  });

  it("surfaces only the floor count to Invoicing Scheduler, which has no unscheduled banner", async () => {
    const result = await loadInvoicingSchedulerOrdersAction({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });
    expect(result.data?.floorHiddenCount).toBe(12);
    expect(result.data).not.toHaveProperty("unscheduledCount");
  });
});
