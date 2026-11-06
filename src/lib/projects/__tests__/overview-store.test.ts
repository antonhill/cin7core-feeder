import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOverviewData } from "../overview-store";
import { loadConsolidatedProject } from "../variation-billing-store";
import { loadProjectView } from "../project-store";
import { loadSaleLink } from "../cin7-posting-store";
import { loadProjectScope } from "../scope-store";
import { loadProfitability } from "../profitability-store";
import { marginFigures } from "../margin-figures";
import { R, approvedVariation, project, scope, stage, view } from "./overview-fixtures";
import type { PhysicalPort } from "../physical-store";

vi.mock("../variation-billing-store", () => ({ loadConsolidatedProject: vi.fn() }));
vi.mock("../project-store", () => ({ loadProjectView: vi.fn() }));
vi.mock("../cin7-posting-store", () => ({ loadSaleLink: vi.fn() }));
vi.mock("../scope-store", () => ({ loadProjectScope: vi.fn() }));
vi.mock("../profitability-store", () => ({ loadProfitability: vi.fn() }));

// A database stand-in for the two delivery reads only; it records every table it is asked about.
const tables: string[] = [];
let deliveryResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let eventResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const chain = (result: () => unknown): unknown => new Proxy({}, { get: (_t, p: string) => (p === "then" ? (res: (v: unknown) => void) => res(result()) : () => chain(result)) });
const db = { from: (t: string) => { tables.push(t); return chain(() => (t === "project_deliveries" ? deliveryResult : eventResult)); } } as never;

const baseProject = project({ id: "p-base", project_reference: "PRJ-T-1", original_contract_cents: R(1000) });
const varProject = project({ id: "p-var", project_reference: "PRJ-T-1-V001", original_contract_cents: R(100), billing_scope: "VARIATION", parent_project_id: "p-base" });
const baseView = view({ project: baseProject, stages: [stage("s1", 1, "A", R(1000))], variations: [approvedVariation(R(100), 5_550_001)] });
const varView = view({ project: varProject, stages: [stage("v1", 1, "V", R(100))], variations: [approvedVariation(R(100), 6_660_002)] });
const summary = (id: string, scopeKind: "BASE" | "VARIATION", code: string | null) => ({ scope: scopeKind, projectId: id, projectReference: id, variationCode: code, contractCents: 0, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0 });

beforeEach(() => {
  vi.clearAllMocks(); tables.length = 0;
  deliveryResult = { data: [{ status: "DISPATCHED", created_at: "2026-11-01T10:00:00Z" }, { status: "PLANNED", created_at: "2026-11-01T11:00:00Z" }, { status: "CANCELLED", created_at: "2026-10-31T09:00:00Z" }], error: null };
  eventResult = { data: [{ created_at: "2026-11-01T15:30:00Z" }], error: null };
  vi.mocked(loadConsolidatedProject).mockResolvedValue({ base: baseView, scopes: [summary("p-base", "BASE", null), summary("p-var", "VARIATION", "V001")], unbilledApprovedVariations: [{ id: "x", code: "V002", amountCents: 7 }], closureBlockers: ["secret blocker"], totals: {} } as never);
  vi.mocked(loadProjectView).mockResolvedValue(varView);
  vi.mocked(loadSaleLink).mockImplementation(async (_d, _o, id) => (id === "p-base" ? { cin7_sale_number: "SO-27" } : null) as never);
  vi.mocked(loadProjectScope).mockResolvedValue({ items: [], effective: { lines: [], blockers: ["Cooler: not mapped"], excluded: [], referenceOnly: [] } } as never);
  vi.mocked(loadProfitability).mockResolvedValue({ estimated: { revised: marginFigures(R(1100), R(700)), incomplete: false, uncostedSellingCents: 0 }, exceptions: [{ code: "COST_UNKNOWN", scope: "S", message: "m", extra: "dropped" }] } as never);
});
const input = (isAdmin: boolean) => ({ orgId: "org", projectId: "p-base", isAdmin, base: { estimatedCostCents: 1, uncostedSellingCents: 0 } });

describe("loadOverviewData", () => {
  it("returns null for a missing project", async () => {
    vi.mocked(loadConsolidatedProject).mockResolvedValue(null);
    expect(await loadOverviewData(db, input(true))).toBeNull();
  });
  it("assembles the base and variation scopes with Sale numbers, register blockers and delivery summary; closure blockers are not exposed", async () => {
    const d = (await loadOverviewData(db, input(true)))!;
    expect(d.scopes.map((s) => [s.projectId, s.scope, s.label, s.saleNumber])).toEqual([["p-base", "BASE", "Original contract", "SO-27"], ["p-var", "VARIATION", "V001 variation", null]]);
    expect(d.scopes[0].scopeBlockers).toEqual(["Cooler: not mapped"]);
    expect(d.unbilledApprovedVariations).toEqual([{ code: "V002", amountCents: 7 }]);
    expect(d.deliveries).toEqual({ total: 2, dispatched: 1, inProgress: 1, cancelled: 1, latestActivityAt: "2026-11-01T15:30:00Z" });
    expect(JSON.stringify(d)).not.toContain("secret blocker");
  });
  it("an administrator gets the frozen estimate, read through a port that can never reach Cin7", async () => {
    const d = (await loadOverviewData(db, input(true)))!;
    expect(d.estimates).toMatchObject({ revised: { costCents: R(700) }, incomplete: false, exceptions: [{ code: "COST_UNKNOWN", scope: "S", message: "m" }] });
    expect(JSON.stringify(d.estimates)).not.toContain("dropped");
    const portFor = vi.mocked(loadProfitability).mock.calls[0][1] as (id: string) => PhysicalPort;
    const port = portFor("any-instance");
    await expect(port.readSale("s")).rejects.toThrow(/offline/);
    await expect(port.readStock("s")).rejects.toThrow();
    await expect(port.readAssemblies()).rejects.toThrow();
  });
  it("a non-admin NEVER triggers the cost loader, gets no estimates and no variation costs", async () => {
    const d = (await loadOverviewData(db, input(false)))!;
    expect(loadProfitability).not.toHaveBeenCalled();
    expect(d.estimates).toBeNull();
    for (const s of d.scopes) for (const v of s.view.variations) expect(v.estimated_cost_cents).toBeNull();
    expect(JSON.stringify(d)).not.toContain("5550001");
    expect(JSON.stringify(d)).not.toContain("6660002");
  });
  it("an administrator keeps the variation costs", async () => {
    const d = (await loadOverviewData(db, input(true)))!;
    expect(d.scopes[0].view.variations[0].estimated_cost_cents).toBe(5_550_001);
  });
  it("fails closed when a scope's view cannot be loaded", async () => {
    vi.mocked(loadProjectView).mockResolvedValue(null);
    await expect(loadOverviewData(db, input(true))).rejects.toThrow(/could not be loaded/);
  });
  it("deliveries: a missing table (older database) is unknown, any other error is not swallowed", async () => {
    deliveryResult = { data: null, error: { message: 'relation "project_deliveries" does not exist' } };
    expect((await loadOverviewData(db, input(true)))!.deliveries).toBeNull();
    deliveryResult = { data: null, error: { message: "permission denied" } };
    await expect(loadOverviewData(db, input(true))).rejects.toThrow(/load deliveries: permission denied/);
  });
  it("reads only the delivery tables from the database directly (everything else goes through existing loaders)", async () => {
    await loadOverviewData(db, input(true));
    expect([...new Set(tables)].sort()).toEqual(["project_deliveries", "project_delivery_events"]);
  });
  it("sanity: the scope helper used by the model tests builds a base scope", () => {
    expect(scope({ project: baseProject, stages: [stage("s1", 1, "A", R(1000))] }).scope).toBe("BASE");
  });
});
