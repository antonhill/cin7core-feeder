import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadNatasFilterOptionsAction, loadNatasReportAction } from "@/app/reports/natas/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireCasaDasNatasOrg } from "@/lib/require-casa-das-natas-org";
import { createServiceRoleClient } from "@/supabase/server";
import { getNatasReport, getNatasFilterOptions } from "@/reports/natas-query";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-casa-das-natas-org", () => ({ requireCasaDasNatasOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/reports/natas-query", () => ({ getNatasReport: vi.fn(), getNatasFilterOptions: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));

const CASA_ORG = { orgId: "casa", userId: "u1", email: "a@b.c" };
const MODULE_DENIED = "This module is not enabled for your organization.";
const WRONG_ORG = "This report isn't available for your organization.";

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(CASA_ORG as never);
  vi.mocked(requireCasaDasNatasOrg).mockReset().mockResolvedValue(CASA_ORG as never);
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({} as never);
  vi.mocked(getNatasFilterOptions).mockReset().mockResolvedValue({ instances: [], locations: [] } as never);
  vi.mocked(getNatasReport).mockReset().mockResolvedValue({ rows: [], unmapped: [] } as never);
  vi.mocked(requireOrgAdmin).mockReset();
  vi.mocked(requireWriteAllowed).mockReset();
  vi.mocked(requireAal2).mockReset();
});

/** Every protected read this feature can perform — asserted absent on each denial path. */
function expectNoProtectedRead() {
  expect(getNatasFilterOptions).not.toHaveBeenCalled();
  expect(getNatasReport).not.toHaveBeenCalled();
  expect(createServiceRoleClient).not.toHaveBeenCalled();
}

describe("Natas actions require BOTH Reporting module access and the Casa das Natas org", () => {
  it("A. Reporting denied → filter-options reads no protected data", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));

    const result = await loadNatasFilterOptionsAction();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expectNoProtectedRead();
    // The org guard is never even reached — the module gate short-circuits.
    expect(requireCasaDasNatasOrg).not.toHaveBeenCalled();
  });

  it("B. Reporting denied → report action reads no protected data", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));

    const result = await loadNatasReportAction({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expectNoProtectedRead();
  });

  it("C. wrong organization → filter-options reads no protected data", async () => {
    vi.mocked(requireCasaDasNatasOrg).mockRejectedValue(new Error(WRONG_ORG));

    const result = await loadNatasFilterOptionsAction();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(WRONG_ORG);
    expectNoProtectedRead();
    // Module access passing must NOT be sufficient on its own.
    expect(requireModuleAccess).toHaveBeenCalledWith("/reports");
  });

  it("D. wrong organization → report action reads no protected data", async () => {
    vi.mocked(requireCasaDasNatasOrg).mockRejectedValue(new Error(WRONG_ORG));

    const result = await loadNatasReportAction({});

    expect(result.ok).toBe(false);
    expect(result.error).toBe(WRONG_ORG);
    expectNoProtectedRead();
  });

  it("E. both guards pass → filter-options proceeds normally", async () => {
    const result = await loadNatasFilterOptionsAction();

    expect(result.ok).toBe(true);
    expect(requireModuleAccess).toHaveBeenCalledTimes(1);
    expect(requireCasaDasNatasOrg).toHaveBeenCalledTimes(1);
    expect(getNatasFilterOptions).toHaveBeenCalledTimes(1);
  });

  it("F. both guards pass → report action proceeds normally", async () => {
    const filters = { location: "Main", dateFrom: "2026-01-01" };

    const result = await loadNatasReportAction(filters);

    expect(result.ok).toBe(true);
    expect(requireModuleAccess).toHaveBeenCalledTimes(1);
    expect(requireCasaDasNatasOrg).toHaveBeenCalledTimes(1);
    // Filters reach the query unchanged — this fix does not touch behaviour.
    expect(getNatasReport).toHaveBeenCalledWith({}, filters);
  });

  it("stays read-only — no admin, billing or assurance gate was introduced", async () => {
    await loadNatasFilterOptionsAction();
    await loadNatasReportAction({});

    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(requireWriteAllowed).not.toHaveBeenCalled();
    expect(requireAal2).not.toHaveBeenCalled();
  });
});
