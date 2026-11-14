import { describe, expect, it, vi } from "vitest";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));

describe('po-reconciliation/actions.ts ("use server")', () => {
  it("exports ONLY async functions (a non-function export fails the whole module at request time)", async () => {
    const mod = await import("../actions");
    for (const [name, value] of Object.entries(mod)) {
      expect(typeof value, name).toBe("function");
      expect(value.constructor.name, name).toBe("AsyncFunction");
    }
    expect(Object.keys(mod).sort()).toEqual(["exportPoQuantityXlsxAction", "loadPoQuantityReportAction"]);
  });

  it("returns ok:false (never throws) and touches no data when access is denied", async () => {
    const { requireModuleAccess } = await import("@/lib/authorization");
    const { createServiceRoleClient } = await import("@/supabase/server");
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("forbidden"));
    const { loadPoQuantityReportAction } = await import("../actions");
    const res = await loadPoQuantityReportAction({});
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
