import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireModuleAccess } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { NEWQUIP_ONLY_MESSAGE } from "@/lib/projects/newquip-gate";
import { callerIsOrgAdmin, guardBillingScope } from "@/lib/projects/scope-access";
import { loadBaseCost } from "@/lib/newquip-quotes/project-estimated-cost";
import { loadOverviewData } from "@/lib/projects/overview-store";
import { getProjectOverviewDataAction } from "../overview-actions";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/projects/scope-access", () => ({ callerIsOrgAdmin: vi.fn(), guardBillingScope: vi.fn() }));
vi.mock("@/lib/newquip-quotes/project-estimated-cost", () => ({ loadBaseCost: vi.fn(() => Promise.resolve({ estimatedCostCents: 123, uncostedSellingCents: 0 })) }));
vi.mock("@/lib/projects/overview-store", () => ({ loadOverviewData: vi.fn(() => Promise.resolve({ scopes: [], unbilledApprovedVariations: [], deliveries: null, estimates: null })) }));

const NQ = NEWQUIP_POC_ORG_IDS[0];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: NQ, userId: "u", email: "u@x" } as never);
  vi.mocked(callerIsOrgAdmin).mockResolvedValue(false);
  vi.mocked(guardBillingScope).mockResolvedValue(undefined as never);
});

describe("getProjectOverviewDataAction", () => {
  it("refuses another organisation BEFORE touching any data", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "some-other-org", userId: "u", email: "u@x" } as never);
    const r = await getProjectOverviewDataAction("p1");
    expect(r).toEqual({ ok: false, error: NEWQUIP_ONLY_MESSAGE });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(loadOverviewData).not.toHaveBeenCalled();
  });
  it("an unauthenticated / no-module caller is refused", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("Not signed in"));
    expect((await getProjectOverviewDataAction("p1")).ok).toBe(false);
    expect(loadOverviewData).not.toHaveBeenCalled();
  });
  it("a billing scope the caller may not open is refused before loading", async () => {
    vi.mocked(guardBillingScope).mockRejectedValue(new Error("This is an internal billing scope"));
    const r = await getProjectOverviewDataAction("p-var");
    expect(r.ok).toBe(false);
    expect(loadOverviewData).not.toHaveBeenCalled();
    expect(vi.mocked(guardBillingScope).mock.calls[0][3]).toBe(false); // the caller's real admin status is what is checked
  });
  it("a non-admin: the frozen cost estimate is never even read, and the loader is told isAdmin=false", async () => {
    const r = await getProjectOverviewDataAction("p1");
    expect(r.ok).toBe(true);
    expect(loadBaseCost).not.toHaveBeenCalled();
    expect(vi.mocked(loadOverviewData).mock.calls[0][1]).toMatchObject({ isAdmin: false, base: { estimatedCostCents: null, uncostedSellingCents: 0 } });
    expect(r.data?.viewer).toEqual({ isAdmin: false });
  });
  it("an admin: the estimate is read and passed through", async () => {
    vi.mocked(callerIsOrgAdmin).mockResolvedValue(true);
    const r = await getProjectOverviewDataAction("p1");
    expect(loadBaseCost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadOverviewData).mock.calls[0][1]).toMatchObject({ isAdmin: true, base: { estimatedCostCents: 123 } });
    expect(r.data?.viewer).toEqual({ isAdmin: true });
  });
  it("a missing project is a clear error; an unexpected failure is reported, not thrown", async () => {
    vi.mocked(loadOverviewData).mockResolvedValueOnce(null);
    expect(await getProjectOverviewDataAction("nope")).toEqual({ ok: false, error: "Project not found." });
    vi.mocked(loadOverviewData).mockRejectedValueOnce(new Error("db down"));
    expect(await getProjectOverviewDataAction("p1")).toEqual({ ok: false, error: "db down" });
  });
});

describe("the overview can reach no Cin7, no write and no audit path", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", "..", "..", p), "utf8");
  it.each(["src/app/projects/overview-actions.ts", "src/lib/projects/overview-store.ts", "src/lib/projects/overview-model.ts", "src/app/projects/[id]/ProjectOverview.tsx"])("%s", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(src).not.toMatch(/from "@\/cin7\//);
    expect(src).not.toMatch(/logActivity|fetch\(|createAdvancedSale|postClaimToCin7|reconcile\w*\(|method:\s*["'](POST|PUT|PATCH|DELETE)/);
  });
  it("the actions file honours the \"use server\" rule: only async function exports", () => {
    const src = read("src/app/projects/overview-actions.ts");
    expect([...src.matchAll(/^export (.*)$/gm)].every((m) => m[1].startsWith("async function ") || m[1].startsWith("interface "))).toBe(true);
  });
});
