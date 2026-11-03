import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { finalizeReviewAction, saveMetricResultAction } from "../actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import * as queries from "@/scorecard/queries";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/scorecard/queries", () => ({
  getEnabledOrgScorecard: vi.fn(),
  getReview: vi.fn(),
  listMetricResults: vi.fn(),
  getOrCreateDraftReview: vi.fn(),
  listReviews: vi.fn(),
  listActions: vi.fn(),
  normaliseReviewPeriod: vi.fn(),
}));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };

const SECTIONS = [
  { id: "s1", scorecardDefinitionId: "def-1", name: "Section One", weight: 0.5, displayOrder: 1 },
  { id: "s2", scorecardDefinitionId: "def-1", name: "Section Two", weight: 0.5, displayOrder: 2 },
];
const metric = (id: string, sectionId: string) => ({
  id, scorecardSectionId: sectionId, category: "c", name: `KPI ${id}`, targetText: null, evidenceSource: "MANUAL", scoringMethod: "REVIEWER",
  metricDirection: "HIGHER_IS_BETTER", scoringConfig: null, weight: null, displayOrder: 1, active: true, sourceNote: null,
});
const METRICS = [metric("m1", "s1"), metric("m2", "s2")];
const result = (metricId: string, score: number | null) => ({ id: `r-${metricId}`, review_id: "rev-1", metric_definition_id: metricId, score, actual_numeric: null, actual_text: null, comment: null, owner: null });

let rpc: Mock;
let update: Mock;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  rpc = vi.fn(() => Promise.resolve({ data: { ok: true }, error: null }));
  update = vi.fn();
  // Any direct table write is recorded: a rejected finalisation must never reach it.
  const builder: Record<string, unknown> = {};
  builder.update = (...a: unknown[]) => { update(...a); return builder; };
  builder.eq = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({ from: vi.fn(() => builder), rpc } as never);
  vi.mocked(queries.getReview).mockReset().mockResolvedValue({ id: "rev-1", organization_id: "org1", scorecard_definition_id: "def-1", status: "draft" } as never);
  vi.mocked(queries.getEnabledOrgScorecard).mockReset().mockResolvedValue({ scorecardDefinitionId: "def-1", scorecardName: "LBL", sections: SECTIONS, metrics: METRICS } as never);
  vi.mocked(queries.listMetricResults).mockReset().mockResolvedValue([] as never);
});

describe("finalizeReviewAction refuses to finalise an incomplete review (the November 2026 defect)", () => {
  it("a review with NO KPI results is rejected, lists every KPI, and writes nothing", async () => {
    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(false);
    expect(res.data?.incomplete?.map((k) => k.metricDefinitionId)).toEqual(["m1", "m2"]);
    expect(rpc).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("a review with one KPI unscored (null) is rejected and names exactly that KPI — null is never treated as 0", async () => {
    vi.mocked(queries.listMetricResults).mockResolvedValue([result("m1", 8), result("m2", null)] as never);

    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(false);
    expect(res.data?.incomplete).toHaveLength(1);
    expect(res.data?.incomplete?.[0]).toMatchObject({ metricDefinitionId: "m2", sectionName: "Section Two", reason: "missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an out-of-range or non-numeric stored score is invalid, not complete", async () => {
    vi.mocked(queries.listMetricResults).mockResolvedValue([result("m1", 11), result("m2", Number.NaN)] as never);

    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(false);
    expect(res.data?.incomplete?.map((k) => k.reason)).toEqual(["invalid", "invalid"]);
  });

  it("a legitimate score of ZERO is complete and finalises (zero is not missing)", async () => {
    vi.mocked(queries.listMetricResults).mockResolvedValue([result("m1", 0), result("m2", 0)] as never);

    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(true);
    expect(res.data?.overallScore).toBe(0);
    expect(rpc).toHaveBeenCalledWith("scorecard_finalise_review", expect.objectContaining({ p_review_id: "rev-1", p_overall_score: 0 }));
  });

  it("a complete review finalises through the atomic database function with the recomputed score", async () => {
    vi.mocked(queries.listMetricResults).mockResolvedValue([result("m1", 8), result("m2", 6)] as never);

    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(true);
    expect(res.data?.overallScore).toBe(7);
    expect(rpc).toHaveBeenCalledWith("scorecard_finalise_review", expect.objectContaining({ p_org_id: "org1", p_actor: "u1", p_overall_score: 7 }));
  });

  it("if the database rejects (e.g. a concurrent change), the error surfaces and ok is false", async () => {
    vi.mocked(queries.listMetricResults).mockResolvedValue([result("m1", 8), result("m2", 6)] as never);
    rpc.mockResolvedValue({ data: null, error: { message: "review is not a draft" } });

    const res = await finalizeReviewAction("rev-1");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a draft/);
  });
});

describe("saveMetricResultAction rejects invalid score values", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 10.1])("score %s is rejected before any write", async (score) => {
    const res = await saveMetricResultAction("rev-1", "m1", { score });
    expect(res.ok).toBe(false);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
