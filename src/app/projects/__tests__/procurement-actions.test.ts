import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { buildCostEstimate, type CostEntry } from "@/lib/projects/latest-cost";

// The REAL procurement action over the in-memory database: only the session and the (read-only) Cin7 cost read are replaced.
let db: FakeDb;
const today: Record<string, { supplierId: string; supplierName: string; cost: number | null; currency: string; lastSupplied: string }> = {};
const px = (cents: number) => ({ supplierId: "s1", supplierName: "Acme", cost: cents / 100, currency: "ZAR", lastSupplied: "2026-10-28T00:00:00" });
let costFails = false;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ readSupplierPrices: async (_d: unknown, _o: string, _i: string, skus: string[]) => { if (costFails) throw new Error("cin7 down"); return Object.fromEntries(skus.map((s) => [s, { sku: s, found: true, stockUom: "Item", raws: today[s] ? [today[s]] : [] }])); } })); // today's raw Cin7 supplier prices
vi.mock("@/lib/projects/physical-adapter", () => ({ buildPhysicalPort: () => ({}) }));
vi.mock("../profitability-actions", () => ({ getCostingReportAction: async () => ({ ok: true, data: { bySku: [{ sku: "A", actualCents: 105_000, actualQuantity: 10 }] } }) }));
import { getProcurementTargetsAction } from "../procurement-actions";

const ORG = "org-nq";
const at = "2026-10-29T08:00:00Z";
const scope = [{ sku: "A", description: "Silo", quantity: 20 }, { sku: "B", description: "Slat", quantity: 100 }];
const frozen = buildCostEstimate(scope, { A: { unitCostCents: 10_000, source: "CIN7_LATEST", retrievedAt: at, supplier: "Acme" }, B: { unitCostCents: 250, source: "MANUAL_ESTIMATE", retrievedAt: at, reason: "Quote 14 Oct" } });
const as = (userId: string, admin: boolean, roles: string[] = []) => {
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId, email: `${userId}@nq` } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
  db.tables["org_functional_roles"] = roles.map((r, i) => ({ id: `r${i}`, org_id: ORG, user_id: userId, user_email: `${userId}@nq`, role: r, assigned_by_email: "x", assigned_at: "t" }));
};

beforeEach(() => {
  db = new FakeDb(); db.rolesApplied = true; costFails = false;
  for (const k of Object.keys(today)) delete today[k];
  db.rows("projects").push({ id: "p1", org_id: ORG, project_reference: "PRJ-NQ-Q-0009", billing_scope: "BASE", parent_project_id: null,
    baseline_snapshot: { lines: scope.map((s, i) => ({ lineRef: `l${i}`, ...s })), provenance: { newquipQuoteId: "q1" } } });
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, project_id: "p1", accepted_baseline: { physicalCostEstimate: { ...frozen, costBasis: { unitBasis: { basis: "STOCK_UNIT", confirmedBy: "x", confirmedAt: at, reason: "per stock unit confirmed" } } } } });
});

describe("procurement cost targets action", () => {
  it("is for buyers and managers: a salesperson or estimator is refused; Procurement, Manager and admins are allowed", async () => {
    as("rep", false, ["REP"]);
    expect((await getProcurementTargetsAction("p1")).error).toMatch(/Procurement role/);
    as("est", false, ["ESTIMATOR"]);
    expect((await getProcurementTargetsAction("p1")).ok).toBe(false);
    as("buyer", false, ["PROCUREMENT"]);
    expect((await getProcurementTargetsAction("p1")).ok).toBe(true);
    as("mgr", false, ["MANAGER"]);
    expect((await getProcurementTargetsAction("p1")).ok).toBe(true);
    as("adm", true);
    expect((await getProcurementTargetsAction("p1")).ok).toBe(true);
  });
  it("shows the frozen allowed cost beside today's Cin7 cost; changing today's cost leaves the allowed cost untouched", async () => {
    as("buyer", false, ["PROCUREMENT"]);
    today["A"] = px(11_000); today["B"] = px(200);
    const first = (await getProcurementTargetsAction("p1")).data!;
    expect(first.rows.find((r) => r.sku === "A")).toMatchObject({ approvedUnitCostCents: 10_000, currentUnitCostCents: 11_000, unitVarianceCents: 1000, approvedBasis: "CIN7_LATEST" });
    expect(first.rows.find((r) => r.sku === "B")).toMatchObject({ approvedBasis: "MANUAL_ESTIMATE", approvedReason: "Quote 14 Oct" });
    today["A"] = px(99_999);
    const later = (await getProcurementTargetsAction("p1")).data!;
    expect(later.rows.map((r) => r.approvedUnitCostCents)).toEqual(first.rows.map((r) => r.approvedUnitCostCents));
    expect(later.totals.approvedTotalCents).toBe(first.totals.approvedTotalCents);
  });
  it("the recognised actual cost is for administrators only; a buyer gets none rather than a guess", async () => {
    as("buyer", false, ["PROCUREMENT"]);
    expect((await getProcurementTargetsAction("p1")).data!.rows.every((r) => r.actualUnitCostCents === null)).toBe(true);
    as("adm", true);
    expect((await getProcurementTargetsAction("p1")).data!.rows.find((r) => r.sku === "A")!.actualUnitCostCents).toBe(10_500);
  });
  it("an estimate belongs to its own project: a quote linked to another project is never used, and the gap is stated", async () => {
    as("buyer", false, ["PROCUREMENT"]);
    (db.rows("newquip_quotes")[0] as { project_id: string }).project_id = "someone-else";
    const d = (await getProcurementTargetsAction("p1")).data!;
    expect(d.estimateCaptured).toBe(false);
    expect(d.rows.every((r) => r.approvedUnitCostCents === null)).toBe(true);
    expect(d.notes.join(" ")).toMatch(/No cost estimate was captured/);
  });
  it("if Cin7 cannot be read the page still shows the frozen budget and says so (no invented current cost)", async () => {
    as("buyer", false, ["PROCUREMENT"]); costFails = true;
    const d = (await getProcurementTargetsAction("p1")).data!;
    expect(d.costRead).toBe("UNAVAILABLE");
    expect(d.rows.every((r) => r.currentUnitCostCents === null)).toBe(true);
    expect(d.rows.find((r) => r.sku === "A")!.approvedUnitCostCents).toBe(10_000);
  });
  it("a variation billing scope has no cost targets of its own", async () => {
    as("adm", true);
    db.rows("projects").push({ id: "v1", org_id: ORG, project_reference: "PRJ-NQ-Q-0009-V001", billing_scope: "VARIATION", parent_project_id: "p1", baseline_snapshot: {} });
    expect((await getProcurementTargetsAction("v1")).error).toMatch(/original project/);
  });
});
