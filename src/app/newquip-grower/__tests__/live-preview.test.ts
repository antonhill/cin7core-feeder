import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// (header reused) Product mappings decide what a quotation is built from. NEGATIVE authorisation: a Rep (functional role REP only) cannot change ANY mapping, on create or on save,
// including the non-optional ones; an Estimator/Manager can. And mapping integrity is re-verified at estimator sign-off against the live catalogue.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

beforeEach(() => {
  db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG, [{ sku: "DOOR-NEW" }, { sku: "OPT-INACTIVE", active: false }]);
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
});

async function storedQuote() {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, readyDraft());
  return id;
}
const KEY = "feed_saver_mat";
const draftWith = (reason: string) => { const d = readyDraft(); d.config.exclusions = { [KEY]: reason } as never; return d; };

describe("UAT-003 live preview versus Save", () => {
  it("the read-only preview applies a ticked exclusion at once, stores nothing, and does not touch the stored quote", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    const before = JSON.stringify(await loadQuote(db as never, ORG, id));
    const base = await actions.previewGrowerDraftAction(readyDraft());
    const ticked = await actions.previewGrowerDraftAction(draftWith(""));
    expect(ticked.ok && base.ok).toBe(true);
    expect(ticked.data!.budget!.totals.subtotalExTax).toBeLessThan(base.data!.budget!.totals.subtotalExTax);
    expect(JSON.stringify(await loadQuote(db as never, ORG, id))).toBe(before);
  });
  it("Save refuses a ticked exclusion with no reason, so a saved quote never differs from what was previewed", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    const r = await actions.saveGrowerDraftAction(id, draftWith("  "));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reason for every exclusion/);
    expect((await loadQuote(db as never, ORG, id))!.draft.config.exclusions).toEqual({});
  });
  it("once a reason is entered, Save stores exactly the figures the preview showed", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    const previewed = (await actions.previewGrowerDraftAction(draftWith(""))).data!.budget!.totals;
    const saved = await actions.saveGrowerDraftAction(id, draftWith("Customer supplies their own"));
    expect(saved.ok).toBe(true);
    expect(saved.data!.evaluation.budget!.totals).toEqual(previewed);
    expect(saved.data!.quote.draft.config.exclusions).toEqual({ [KEY]: "Customer supplies their own" });
  });
  it("re-including then saving returns to the original figures", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    const original = (await actions.previewGrowerDraftAction(readyDraft())).data!.budget!.totals;
    await actions.saveGrowerDraftAction(id, draftWith("Customer supplies their own"));
    const back = await actions.saveGrowerDraftAction(id, readyDraft());
    expect(back.data!.evaluation.budget!.totals).toEqual(original);
  });
});
