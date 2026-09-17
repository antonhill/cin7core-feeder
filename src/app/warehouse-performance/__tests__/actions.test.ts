import { describe, expect, it, vi, beforeEach } from "vitest";
import { saveMetricResultAction, finalizeReviewAction, createCorrectiveActionAction, completeCorrectiveActionAction, listBottleneckOrdersAction } from "../actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const MODULE_DENIED = "This module is not enabled for your organization.";
const NOT_ADMIN = "Only an org owner or admin can manage team members.";

/** Builds a chainable query-builder mock whose terminal methods resolve to the given result — enough of the supabase-js surface for these actions' straight-line queries. */
function queryStub(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.upsert = vi.fn(() => Promise.resolve(result));
  builder.insert = vi.fn(() => Promise.resolve(result));
  builder.update = vi.fn(chain);
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.single = vi.fn(() => Promise.resolve(result));
  // update(...).eq(...).eq(...) must ALSO resolve like a promise at its tail —
  // eq() returning `builder` (thenable-less) is fine as long as the last
  // .eq() call in the action is awaited directly; give it a `then` so any
  // chain ending in .eq() resolves too.
  builder.then = (resolve: (v: unknown) => void) => resolve(result);
  return builder;
}

let dbFrom: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  dbFrom = vi.fn();
  vi.mocked(createServiceRoleClient)
    .mockReset()
    .mockReturnValue({ from: dbFrom, rpc: vi.fn(() => Promise.resolve({ data: [], error: null })) } as never);
});

describe("saveMetricResultAction requires BOTH module access and the org-admin role", () => {
  it("module denied -> no DB write, role guard never even consulted for the write gate", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));

    const result = await saveMetricResultAction("review-1", "metric-1", { score: 8 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("module allowed, not an admin -> no DB write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));

    const result = await saveMetricResultAction("review-1", "metric-1", { score: 8 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(NOT_ADMIN);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("rejects a score outside 0-10 before touching the database", async () => {
    const result = await saveMetricResultAction("review-1", "metric-1", { score: 15 });
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("refuses to write against an already-finalised review, at the app layer (the DB trigger is the second, load-bearing guard)", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "scorecard_reviews") return queryStub({ data: { id: "review-1", organization_id: "org1", status: "final" }, error: null });
      return queryStub({ data: null, error: null });
    });

    const result = await saveMetricResultAction("review-1", "metric-1", { score: 8 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/finalised/i);
  });
});

describe("finalizeReviewAction requires BOTH module access and the org-admin role, and refuses double-finalisation", () => {
  it("module denied -> no write", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    const result = await finalizeReviewAction("review-1");
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("not an admin -> no write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    const result = await finalizeReviewAction("review-1");
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("an already-final review cannot be finalised again", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "scorecard_reviews") return queryStub({ data: { id: "review-1", organization_id: "org1", status: "final", scorecard_definition_id: "def-1" }, error: null });
      return queryStub({ data: null, error: null });
    });

    const result = await finalizeReviewAction("review-1");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already finalised/i);
  });
});

describe("corrective actions require BOTH module access and the org-admin role to write", () => {
  it("createCorrectiveActionAction: module denied -> no write", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    const result = await createCorrectiveActionAction({ title: "Investigate backlog" });
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("createCorrectiveActionAction: not an admin -> no write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    const result = await createCorrectiveActionAction({ title: "Investigate backlog" });
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("createCorrectiveActionAction: rejects a blank title before touching the database", async () => {
    const result = await createCorrectiveActionAction({ title: "   " });
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("completeCorrectiveActionAction: module denied -> no write", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    const result = await completeCorrectiveActionAction("action-1");
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });

  it("completeCorrectiveActionAction: not an admin -> no write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));
    const result = await completeCorrectiveActionAction("action-1");
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
  });
});

describe("listBottleneckOrdersAction scopes the RPC to the org's configured instances", () => {
  it("threads organization_scorecards.settings.instanceIds through to p_instance_ids, so a multi-brand org's scorecard never silently mixes another instance's orders in", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const scopedDbFrom = vi.fn((table: string) => {
      if (table === "organization_scorecards")
        return queryStub({ data: { id: "assignment-1", scorecard_definition_id: "def-1", settings: { instanceIds: ["instance-lbl"] } }, error: null });
      if (table === "scorecard_definitions") return queryStub({ data: { id: "def-1", name: "LBL Scorecard", review_frequency: "monthly", active: true }, error: null });
      if (table === "scorecard_sections") return queryStub({ data: [], error: null });
      if (table === "scorecard_metric_definitions") return queryStub({ data: [], error: null });
      return queryStub({ data: null, error: null });
    });
    vi.mocked(createServiceRoleClient).mockReturnValue({ from: scopedDbFrom, rpc } as never);

    await listBottleneckOrdersAction("ready_to_pick");

    expect(rpc).toHaveBeenCalledWith("report_scorecard_bottleneck_orders", { p_org_id: "org1", p_queue: "ready_to_pick", p_instance_ids: ["instance-lbl"] });
  });

  it("passes null (every instance) when no scoping is configured — the pre-fix default", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const unscopedDbFrom = vi.fn((table: string) => {
      if (table === "organization_scorecards") return queryStub({ data: { id: "assignment-1", scorecard_definition_id: "def-1", settings: {} }, error: null });
      if (table === "scorecard_definitions") return queryStub({ data: { id: "def-1", name: "Scorecard", review_frequency: "monthly", active: true }, error: null });
      if (table === "scorecard_sections") return queryStub({ data: [], error: null });
      if (table === "scorecard_metric_definitions") return queryStub({ data: [], error: null });
      return queryStub({ data: null, error: null });
    });
    vi.mocked(createServiceRoleClient).mockReturnValue({ from: unscopedDbFrom, rpc } as never);

    await listBottleneckOrdersAction("ready_to_pick");

    expect(rpc).toHaveBeenCalledWith("report_scorecard_bottleneck_orders", { p_org_id: "org1", p_queue: "ready_to_pick", p_instance_ids: null });
  });
});

describe("listBottleneckOrdersAction validates the queue before it can reach SQL", () => {
  it("rejects an unrecognised queue name without calling the database", async () => {
    const result = await listBottleneckOrdersAction("not_a_real_queue");
    expect(result.ok).toBe(false);
    expect(dbFrom).not.toHaveBeenCalled();
    expect(requireModuleAccess).not.toHaveBeenCalled();
  });

  it("accepts each of the four real queue names", async () => {
    // listBottleneckOrdersAction looks up the org's scorecard configuration
    // before calling the RPC (needed for instance scoping) — mock a
    // minimal valid one so the flow reaches the RPC at all.
    dbFrom.mockImplementation((table: string) => {
      if (table === "organization_scorecards") return queryStub({ data: { id: "assignment-1", scorecard_definition_id: "def-1", settings: {} }, error: null });
      if (table === "scorecard_definitions") return queryStub({ data: { id: "def-1", name: "Test Scorecard", review_frequency: "monthly", active: true }, error: null });
      if (table === "scorecard_sections") return queryStub({ data: [], error: null });
      if (table === "scorecard_metric_definitions") return queryStub({ data: [], error: null });
      return queryStub({ data: null, error: null });
    });

    for (const queue of ["ready_to_pick", "packed_not_invoiced", "invoiced_not_shipped", "backorders_awaiting_stock"]) {
      const result = await listBottleneckOrdersAction(queue);
      expect(result.ok).toBe(true);
    }
  });
});
