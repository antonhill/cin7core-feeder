import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { emptyDraft } from "@/newquip/grower/draft";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { hashOf } from "@/newquip/quote/baseline";
import type { Actor } from "../actor";

// Adopting the current template on an EXISTING quotation is an explicit, Estimator-only, audited commercial action bound to the figures the Estimator saw.
vi.mock("server-only", () => ({}));
let db: FakeDb;
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
let actor: Actor;
const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
vi.mock("../actor", async (orig) => ({ ...(await orig<typeof import("../actor")>()), authoriseActor: vi.fn(async () => actor), auditActor: vi.fn(async (_d: unknown, _a: unknown, i: { action: string; detail: Record<string, unknown> }) => { audits.push(i); }) }));
vi.mock("@/lib/newquip-quotes/confirmation-reconcile", () => ({ resyncApprovalsLogged: vi.fn(async () => null) }));
import * as actions from "../template-adoption-actions";

const ORG = "org-nq";
const asActor = (roles: string[], over: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: "u1", email: "est@nq", tier: "member", roles: new Set(roles) as never, canSeeCost: true, activeRole: null, demo: null, ...over } as Actor);
const legacyDraft = () => { const d = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft; delete d.estimator.templateRevision; return d; };
const totalCents = (d: ReturnType<typeof legacyDraft>) => Math.round(evaluateDraft(d, evaluationContext(false)).budget!.totals.subtotalExTax * 100);

function seed(over: Record<string, unknown> = {}) {
  const d = legacyDraft();
  const row = { id: "q1", org_id: ORG, quote_ref: "NQ-Q-0099", state: "ESTIMATOR_REVIEW", revision: 1, customer_name: "Test Customer", site_name: "S", quote_type: "day_to_day", draft: d, draft_hash: hashOf(d), created_by_email: "rep@nq", customer_confirmed_cents: totalCents(d), customer_confirmed_by: "Joe", customer_confirmed_at: "t", handoff_by_email: "rep@nq", estimator_signoff_hash: hashOf(d), estimator_signoff_by_email: "est@nq", estimator_signoff_at: "t", contract_cents: null, accepted_baseline: null, project_id: null, ...over };
  db.tables.newquip_quotes = [row];
  return row;
}
const good = (hash: string, total: number, over: Partial<Parameters<typeof actions.adoptTemplateRevisionAction>[1]> = {}) => ({ reason: "Adopt the corrected LED package", expectedDraftHash: hash, acknowledgeImpact: true, acknowledgedTotalExVat: total, confirmNewLedPackage: false, ...over });
beforeEach(() => { db = new FakeDb(); actor = asActor(["estimator"]); audits.length = 0; });

describe("preview is read-only and shows old versus new", () => {
  it("lists the LED components and selling values before and after, the totals, the effects, and writes nothing", async () => {
    const row = seed(); const before = JSON.stringify(row);
    const r = await actions.previewTemplateAdoptionAction("q1");
    expect(r.ok).toBe(true);
    const i = r.data!.impact;
    expect(i).toMatchObject({ from: "grower-2026-10", to: "grower-2026-11", eligible: true });
    expect(i.led.before!.components.map((c) => c.sku)).toEqual([null, null, null]);
    expect(i.led.afterConfirmed!.components.map((c) => [c.sku, c.quantity])).toEqual([["HNQ7046", 456], ["HNQ7093", 1368], ["HNQ7088", 456]]); // 38 lights x 12 rooms; 3 clips and 1 cable per light
    // The Estimator's typed LED price (881 per light) is the selling value on this quotation both before and after: adoption changes the SCOPE (components, quantities, Sale lines), not that price.
    expect(i.led.before!.sellingExVat).toBe(401736);
    expect(i.led.afterConfirmed!.sellingExVat).toBe(401736);
    expect(i.totals.before.exVat).toBe(i.totals.afterConfirmed.exVat);
    expect(i.effects).toMatchObject({ confirmationWithdrawn: true, signoffCleared: true, returnedToRep: true });
    expect(JSON.stringify(row)).toBe(before);
    expect(db.writes.length).toBe(0);
  });
});

describe("adopting is explicit and bound to what was shown", () => {
  it("is refused for a Rep, a Manager-only user and Demo Mode", async () => {
    const row = seed(); const t = totalCents(row.draft as never) / 100;
    for (const a of [asActor(["rep"]), asActor(["manager"]), asActor(["estimator"], { demo: {} as never })]) {
      actor = a;
      expect((await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, t))).ok).toBe(false);
    }
    expect((db.tables.newquip_quotes[0].draft as { estimator: { templateRevision?: string } }).estimator.templateRevision).toBeUndefined();
  });
  it("needs the acknowledgement, a reason, an unchanged draft and the exact total that was shown", async () => {
    const row = seed();
    const imp = (await actions.previewTemplateAdoptionAction("q1")).data!.impact;
    const t = imp.totals.afterUnconfirmed.exVat;
    expect((await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, t, { acknowledgeImpact: false }))).error).toMatch(/Acknowledge the commercial impact/);
    expect((await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, t, { reason: "short" }))).error).toMatch(/reason/);
    expect((await actions.adoptTemplateRevisionAction("q1", good("stale-hash", t))).error).toMatch(/changed since you reviewed/);
    expect((await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, t + 1))).error).toMatch(/does not match/);
    expect((db.tables.newquip_quotes[0].draft as { estimator: { templateRevision?: string } }).estimator.templateRevision).toBeUndefined();
    expect(audits).toHaveLength(0);
  });
  it("success: moves to the current template, removes the old LED confirmation (never confirmed implicitly), withdraws the customer's confirmation and the sign-off, returns the quotation to the Rep as a new revision, and is audited", async () => {
    const row = seed();
    const imp = (await actions.previewTemplateAdoptionAction("q1")).data!.impact;
    const r = await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, imp.totals.afterUnconfirmed.exVat));
    expect(r).toMatchObject({ ok: true, data: { returnedToRep: true, confirmationWithdrawn: true, signoffCleared: true, revision: 2 } });
    const q = db.tables.newquip_quotes[0] as unknown as { state: string; revision: number; customer_confirmed_cents: number | null; estimator_signoff_hash: string | null; draft_hash: string; draft: { estimator: { templateRevision?: string; confirmedPackages: string[] } } };
    expect(q.draft.estimator.templateRevision).toBe("grower-2026-11");
    expect(q.draft.estimator.confirmedPackages).not.toContain("led_light");
    expect(q).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null, estimator_signoff_hash: null });
    expect(audits[0]).toMatchObject({ action: "newquip.template_revision_adopted", detail: { from: "grower-2026-10", to: "grower-2026-11", confirmedNewLedPackage: false } });
    expect((await actions.adoptTemplateRevisionAction("q1", good(q.draft_hash, 0))).error).toMatch(/already uses the current template/);
  });
  it("confirming the new package in the same action keeps it confirmed (and the acknowledged total is the confirmed one)", async () => {
    const row = seed({ customer_confirmed_cents: null, customer_confirmed_by: null, estimator_signoff_hash: null, state: "REP_DRAFT" });
    const imp = (await actions.previewTemplateAdoptionAction("q1")).data!.impact;
    const r = await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, imp.totals.afterConfirmed.exVat, { confirmNewLedPackage: true }));
    expect(r).toMatchObject({ ok: true, data: { confirmationWithdrawn: false } });
    expect((db.tables.newquip_quotes[0].draft as { estimator: { confirmedPackages: string[] } }).estimator.confirmedPackages).toContain("led_light");
  });
  it("an approved (sealed) quotation can never adopt", async () => {
    const row = seed({ state: "MANAGER_APPROVED_FINAL" });
    expect((await actions.adoptTemplateRevisionAction("q1", good(row.draft_hash as string, 1))).error).toMatch(/sealed/);
    expect((await actions.previewTemplateAdoptionAction("q1")).data!.impact).toMatchObject({ eligible: false });
  });
});
