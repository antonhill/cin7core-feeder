import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { reverseFinalisationAction, listReviewHistoryAction } from "../actions";
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
  listReviews: vi.fn(),
  countScoredResultsByReview: vi.fn(),
  listReviewEvents: vi.fn(),
}));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const NOT_ADMIN = "Only an org owner or admin can undo the finalisation of a Warehouse Performance review.";
let rpc: Mock;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({ rpc, from: vi.fn() } as never);
  vi.mocked(queries.getReview).mockReset().mockResolvedValue({ id: "rev-1", organization_id: "org1", status: "final" } as never);
});

describe("reverseFinalisationAction — permissions", () => {
  it("module denied -> nothing happens", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("This module is not enabled for your organization."));
    const res = await reverseFinalisationAction("rev-1", "Finalised in error");
    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a non-admin member cannot reverse, enforced server-side", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    const res = await reverseFinalisationAction("rev-1", "Finalised in error");
    expect(res.ok).toBe(false);
    expect(res.error).toBe(NOT_ADMIN);
    expect(queries.getReview).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("reverseFinalisationAction — reason, state and idempotence", () => {
  it.each(["", "   ", "abc"])("a missing/too-short reason (%j) is rejected before any read or write", async (reason) => {
    const res = await reverseFinalisationAction("rev-1", reason);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reason/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a Final review is reversed through the atomic function with the trimmed reason and the acting user", async () => {
    const res = await reverseFinalisationAction("rev-1", "  Finalised with no KPI values  ");
    expect(res.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("scorecard_reverse_finalisation", { p_review_id: "rev-1", p_org_id: "org1", p_actor: "u1", p_reason: "Finalised with no KPI values" });
  });

  it("a review that is already Draft is refused without a write (repeated requests are harmless)", async () => {
    vi.mocked(queries.getReview).mockResolvedValue({ id: "rev-1", organization_id: "org1", status: "draft" } as never);
    const res = await reverseFinalisationAction("rev-1", "Second click");
    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("losing a race (database says the review is no longer final) surfaces as an error, not a success", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "review is not finalised (status: draft)" } });
    const res = await reverseFinalisationAction("rev-1", "Concurrent click");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not finalised/);
  });

  it("another organisation's review is not found (tenant scoped)", async () => {
    vi.mocked(queries.getReview).mockResolvedValue(null);
    const res = await reverseFinalisationAction("rev-of-other-org", "Cross tenant");
    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("listReviewHistoryAction — integrity states", () => {
  const review = (id: string, period: string, status: "draft" | "final", score: number | null) => ({ id, review_period: period, status, overall_score: score, finalised_at: status === "final" ? "2026-11-03T07:58:13Z" : null });

  beforeEach(() => {
    vi.mocked(queries.getEnabledOrgScorecard).mockReset().mockResolvedValue({ scorecardDefinitionId: "def-1", metrics: new Array(33).fill({}) } as never);
    vi.mocked(queries.listReviews).mockReset().mockResolvedValue([
      review("nov", "2026-11-01", "final", null),
      review("oct", "2026-10-01", "final", 6.27),
      review("sep", "2026-09-01", "draft", null),
    ] as never);
    vi.mocked(queries.countScoredResultsByReview).mockReset().mockResolvedValue(new Map([["oct", 32]]));
    vi.mocked(queries.listReviewEvents).mockReset().mockResolvedValue([]);
  });

  it("classifies the exact production shapes: Nov = invalid, Oct = legacy (kept at 6.27), Sep = draft", async () => {
    const res = await listReviewHistoryAction();
    const by = Object.fromEntries(res.data!.entries.map((e) => [e.reviewId, e]));
    expect(by.nov).toMatchObject({ integrity: "invalid", overallScore: null, scoredKpis: 0, totalKpis: 33 });
    expect(by.oct).toMatchObject({ integrity: "legacy", overallScore: 6.27, scoredKpis: 32 });
    expect(by.sep).toMatchObject({ integrity: "draft", overallScore: null });
  });

  it("a Final review with every KPI scored and a score is valid", async () => {
    vi.mocked(queries.countScoredResultsByReview).mockResolvedValue(new Map([["oct", 33]]));
    const res = await listReviewHistoryAction();
    expect(res.data!.entries.find((e) => e.reviewId === "oct")!.integrity).toBe("valid");
  });

  it("canReverse reflects the admin check; a non-admin still gets the history", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    const res = await listReviewHistoryAction();
    expect(res.ok).toBe(true);
    expect(res.data!.canReverse).toBe(false);
  });

  it("exposes the reversal audit (count, date, reason) for a reopened review", async () => {
    vi.mocked(queries.listReviewEvents).mockResolvedValue([
      { id: "e1", review_id: "nov", event_type: "finalisation_reversed", previous_status: "final", new_status: "draft", actor_user_id: "u1", reason: "No KPI values", overall_score: null, occurred_at: "2026-11-04T08:00:00Z" },
    ] as never);
    const res = await listReviewHistoryAction();
    const nov = res.data!.entries.find((e) => e.reviewId === "nov")!;
    expect(nov.reopenedCount).toBe(1);
    expect(nov.lastReversal).toEqual({ at: "2026-11-04T08:00:00Z", reason: "No KPI values" });
  });
});
