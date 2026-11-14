/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { emptyDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";

// The quotation page's opening reads in ONE call (getQuotePageBundleAction): authorised once, the same redaction as getGrowerQuoteAction, the delivery / documents parts only for an
// approved quotation and failing independently. The shared delivery / documents readers are replaced by spies so the composition can be observed; their own logic is unchanged
// (they are the former bodies of getQuoteDeliveryAction / getQuoteDocumentsAction, moved to page-reads.ts) and is exercised by the existing delivery / document tests.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("../page-reads", () => ({ deliveryViewOf: vi.fn(), documentsViewOf: vi.fn() }));
import * as actions from "../actions";
import { deliveryViewOf, documentsViewOf } from "../page-reads";

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);
const row = (id: string) => db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, any>;
const DELIVERY = { available: true, status: "APPROVED_INTERNALLY" } as any;
const DOCS = { available: true, documents: [], blockers: [], canIssue: false } as any;

async function newQuote(final: boolean) {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...emptyDraft(), customerName: "Acme Pigs", siteName: "Farm 1" } as any);
  if (final) row(id).state = "MANAGER_APPROVED_FINAL";
  return id;
}

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  vi.mocked(deliveryViewOf).mockResolvedValue(DELIVERY);
  vi.mocked(documentsViewOf).mockResolvedValue(DOCS);
});

describe("getQuotePageBundleAction", () => {
  it("one call: the quote view plus, for an approved quotation, the delivery status and documents - authorised ONCE", async () => {
    asRoles("REP");
    const id = await newQuote(true);
    vi.mocked(requireModuleAccess).mockClear();
    const r = await actions.getQuotePageBundleAction(id);
    expect(r.ok).toBe(true);
    expect(r.data?.quote.quote.id).toBe(id);
    expect(r.data?.delivery).toEqual({ ok: true, data: DELIVERY });
    expect(r.data?.documents).toEqual({ ok: true, data: DOCS });
    expect(vi.mocked(requireModuleAccess)).toHaveBeenCalledTimes(1); // the separate actions would each authorise: 3 calls
    expect(deliveryViewOf).toHaveBeenCalledTimes(1);
    expect(documentsViewOf).toHaveBeenCalledTimes(1);
    // the actor handed to the shared readers is the one authorise() built (roles from the real role resolution)
    expect([...(vi.mocked(deliveryViewOf).mock.calls[0][1] as any).roles]).toEqual(["rep"]);
  });

  it("a quotation that is not approved gets no delivery or documents part (nothing extra is read)", async () => {
    asRoles("REP");
    const id = await newQuote(false);
    const r = await actions.getQuotePageBundleAction(id);
    expect(r.ok).toBe(true);
    expect(r.data?.delivery).toBeUndefined();
    expect(r.data?.documents).toBeUndefined();
    expect(deliveryViewOf).not.toHaveBeenCalled();
    expect(documentsViewOf).not.toHaveBeenCalled();
  });

  it("the quote part is IDENTICAL to getGrowerQuoteAction for a Rep (no cost, margin or commercial fields) and for an Estimator", async () => {
    for (const [roles, sees] of [[["REP"], false], [["ESTIMATOR"], true]] as const) {
      db = new FakeDb();
      asRoles(...roles);
      vi.mocked(canSeeCosts).mockResolvedValue(sees);
      const id = await newQuote(false);
      const single = await actions.getGrowerQuoteAction(id);
      const bundle = await actions.getQuotePageBundleAction(id);
      expect(bundle.data?.quote).toEqual(single.data);
      expect(bundle.data?.quote.viewer.canViewCommercials).toBe(sees);
    }
  });

  it("a Rep's payload carries no cost-bearing field anywhere in the bundle", async () => {
    asRoles("REP");
    const id = await newQuote(true);
    const r = await actions.getQuotePageBundleAction(id);
    const q = r.data!.quote;
    expect(q.costing).toBeUndefined();
    expect(q.baselineException).toBeUndefined();
    expect(q.manualPriceEvidence).toBeUndefined();
    expect(q.indicativeComparison).toBeUndefined();
    expect(JSON.stringify(r.data)).not.toMatch(/internalMargin|estimatedCost|supplierCost|nativeUnitCost/);
  });

  it("the delivery and documents parts fail independently: the quote and the other part are still returned", async () => {
    asRoles("MANAGER");
    const id = await newQuote(true);
    vi.mocked(deliveryViewOf).mockRejectedValue(new Error("delivery read failed"));
    const r = await actions.getQuotePageBundleAction(id);
    expect(r.ok).toBe(true);
    expect(r.data?.quote.quote.id).toBe(id);
    expect(r.data?.delivery).toEqual({ ok: false, error: "delivery read failed" });
    expect(r.data?.documents).toEqual({ ok: true, data: DOCS });
    vi.mocked(deliveryViewOf).mockResolvedValue(DELIVERY);
    vi.mocked(documentsViewOf).mockRejectedValue(new Error("documents read failed"));
    const r2 = await actions.getQuotePageBundleAction(id);
    expect(r2.data?.delivery).toEqual({ ok: true, data: DELIVERY });
    expect(r2.data?.documents).toEqual({ ok: false, error: "documents read failed" });
  });

  it("an unknown quotation fails the call with the same message as getGrowerQuoteAction, and reads nothing else", async () => {
    asRoles("REP");
    const single = await actions.getGrowerQuoteAction("00000000-0000-0000-0000-000000000000");
    const r = await actions.getQuotePageBundleAction("00000000-0000-0000-0000-000000000000");
    expect(r).toEqual(single);
    expect(r.ok).toBe(false);
    expect(deliveryViewOf).not.toHaveBeenCalled();
  });

  it("authorisation failure: refused before anything is read (the same failure as the single action)", async () => {
    asRoles("REP");
    const id = await newQuote(true);
    vi.mocked(requireNewquipPocOrg).mockRejectedValue(new Error("Not a NewQuip organisation."));
    const single = await actions.getGrowerQuoteAction(id);
    const r = await actions.getQuotePageBundleAction(id);
    expect(r).toEqual(single);
    expect(r.ok).toBe(false);
    expect(deliveryViewOf).not.toHaveBeenCalled();
    expect(documentsViewOf).not.toHaveBeenCalled();
    vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("No access to Quotes."));
    expect((await actions.getQuotePageBundleAction(id)).ok).toBe(false);
    expect(deliveryViewOf).not.toHaveBeenCalled();
  });
});
