import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { encodeManualReason } from "@/newquip/quote/estimator-workspace";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// A manual quotation price carries EVIDENCE (supplier quote references) that a viewer who may not see cost never receives. The Rep is sent the redacted reason and saves the draft back with it:
// that must neither be refused nor change the stored text, while a genuine change by the Rep is still refused.

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
const asRoles = (cost: boolean, ...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => { vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never); vi.mocked(canSeeCosts).mockResolvedValue(cost); };
const STORED = encodeManualReason("No SKU exists for the FORTIS 1.2 yet", "Supplier quote SQ-9981, dated 12 Nov");

beforeEach(() => {
  db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG);
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
});

async function withManualPrice(): Promise<string> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  const d = readyDraft();
  d.estimator.priceResolutions = { led_light: { unitPriceExVat: 881, reason: STORED, by: "est@nq", at: "2026-11-10T08:00:00.000Z" } };
  await saveDraft(db as never, ORG, member, id, d);
  return id;
}
const stored = async (id: string) => JSON.stringify((await loadQuote(db as never, ORG, id))!.draft.estimator.priceResolutions);

describe("a Rep saving a draft that carries a redacted manual-price reason", () => {
  it("the Rep is sent the reason without the evidence", async () => {
    const id = await withManualPrice();
    asRoles(false, "REP");
    const v = await actions.getGrowerQuoteAction(id);
    expect(v.ok).toBe(true);
    expect(JSON.stringify(v.data!.quote.draft)).not.toMatch(/SQ-9981|EVIDENCE/);
    expect(v.data!.quote.draft.estimator.priceResolutions.led_light?.reason).toBe("No SKU exists for the FORTIS 1.2 yet");
  });
  it("saving an unrelated field (customer name, M75 price) with the redacted draft succeeds and the stored manual price is byte-for-byte unchanged, evidence included", async () => {
    const id = await withManualPrice();
    const before = await stored(id);
    asRoles(false, "REP");
    const d = structuredClone((await actions.getGrowerQuoteAction(id)).data!.quote.draft);
    d.customerName = "Renamed Customer"; d.estimator.unitPrices = { ...d.estimator.unitPrices, flex_auger: 123456 };
    const r = await actions.saveGrowerDraftAction(id, d);
    expect(r.ok, r.error).toBe(true);
    expect(await stored(id)).toBe(before);
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q.draft.customerName).toBe("Renamed Customer");
    expect(JSON.stringify(q.draft.estimator.priceResolutions)).toMatch(/SQ-9981/);
  });
  it("a Rep who changes the price or the reason is still refused, and nothing is stored", async () => {
    const id = await withManualPrice();
    const before = await stored(id);
    asRoles(false, "REP");
    const base = (await actions.getGrowerQuoteAction(id)).data!.quote.draft;
    const price = structuredClone(base); price.estimator.priceResolutions.led_light!.unitPriceExVat = 1;
    const reason = structuredClone(base); reason.estimator.priceResolutions.led_light!.reason = "a different reason";
    for (const d of [price, reason]) {
      const r = await actions.saveGrowerDraftAction(id, d);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Only an Estimator or Manager can enter or change a manual quotation price/);
    }
    expect(await stored(id)).toBe(before);
  });
  it("an Estimator sees and saves the full text exactly as before", async () => {
    const id = await withManualPrice();
    asRoles(true, "ESTIMATOR");
    const d = structuredClone((await actions.getGrowerQuoteAction(id)).data!.quote.draft);
    expect(d.estimator.priceResolutions.led_light?.reason).toBe(STORED);
    d.customerName = "Renamed";
    expect((await actions.saveGrowerDraftAction(id, d)).ok).toBe(true);
    expect(JSON.parse(await stored(id)).led_light.reason).toBe(STORED);
  });
});
