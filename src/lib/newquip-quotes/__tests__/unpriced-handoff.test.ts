import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { withCapturedSupplierCosts } from "@/newquip/quote/__tests__/costing-fixture";
import { rolesFor } from "@/newquip/quote/roles";
import { UNPRICED_HANDOFF_BASIS } from "@/newquip/quote/workflow";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, returnToRep, saveDraft, sendToEstimator, sendToEstimatorUnpriced } from "../quote-store";
import { allIndicativeSnapshots } from "../indicative-store";

// A quotation with NO indicative selling price yet (the Estimator establishes the first prices): the Rep may submit with an explicit acknowledgement, NO amount is recorded
// (customer_confirmed_cents stays NULL, never 0), and the quotation still cannot be signed off or approved until the Rep has confirmed the calculated amount.

vi.mock("server-only", () => ({}));
const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const estimatorOnly = new Set(["estimator"] as const) as ReadonlySet<"estimator">;
const managerOnly = new Set(["manager"] as const) as ReadonlySet<"manager">;
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);

/** The acceptance shape: tank x1 and feeder x2 included, every other package excluded, R0.00 delivery and installation, NOTHING mapped or priced yet (all Estimator-owned). */
function unpriced(): QuoteDraft {
  const d = readyDraft();
  d.config.exclusions = Object.fromEntries(["flex_auger", "feed_saver_mat", "cup_drinker", "concrete_slat", "penning_package", "led_light", "pvc_door"].map((k) => [k, "Acceptance test: excluded"]));
  d.config.estimatorQuantities = { bulk_tank: 1, feeder: 2 };
  d.estimator.charges = { delivery: 0, installation: 0 };
  d.estimator.unitPrices = {}; d.estimator.priceResolutions = {}; d.estimator.confirmedMappings = {}; d.estimator.confirmedPackages = [];
  delete d.estimator.costBasis;
  return d;
}
async function stored(d: QuoteDraft): Promise<string> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  return id;
}
const sendUnpriced = (id: string, acknowledged = true, roles: ReadonlySet<string> = repOnly) => sendToEstimatorUnpriced(db as never, ORG, roles as never, "rep@nq", id, ctx, { acknowledged });
const row = () => db.rows("newquip_quotes")[0] as Record<string, unknown>;

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; seedGoldenCatalogue(db as never, ORG); db.tables.newquip_package_mappings = []; });

describe("the unpriced fixture really has no indicative price and only Estimator-owned work", () => {
  it("total is 0, Rep work is complete, the Estimator-owned items are open", () => {
    const ev = evaluateDraft(unpriced(), ctx);
    expect(cents(unpriced())).toBe(0);
    expect(ev.readiness.repReasons).toEqual([]);
    expect(ev.readiness.estimatorReasons.length).toBeGreaterThan(0);
  });
});

describe("initial handoff with no indicative price", () => {
  it("is allowed with the acknowledgement, stores NULL cents (never 0) and the explicit basis, the Rep, a timestamp and a not-priced snapshot", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    const q = await loadQuote(db as never, ORG, id);
    expect(q).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: null, customer_confirmed_by: UNPRICED_HANDOFF_BASIS, handoff_by_email: "rep@nq" });
    expect(q!.customer_confirmed_at).toBeTruthy();
    expect(row().customer_confirmed_cents).toBeNull();
    const snaps = await allIndicativeSnapshots(db as never, ORG, id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ total_ex_vat_cents: 0, completeness: "not_priced", captured_by_email: "rep@nq" });
  });
  it("is blocked without the acknowledgement", async () => {
    const id = await stored(unpriced());
    expect(await err(sendUnpriced(id, false))).toMatch(/Acknowledge that no customer price/);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("REP_DRAFT");
  });
  it("is blocked for an incomplete Rep configuration (missing site) and for a missing Rep-owned charge", async () => {
    const noSite = unpriced(); noSite.siteName = "";
    expect(await err(sendUnpriced(await stored(noSite)))).toMatch(/Site \/ project name is required/);
    const noCharge = unpriced(); noCharge.estimator.charges = { installation: 0 };
    expect(await err(sendUnpriced(await stored(noCharge)))).toMatch(/Delivery/);
    const blank = unpriced(); blank.estimator.charges = { delivery: null, installation: 0 };
    expect(await err(sendUnpriced(await stored(blank)))).toMatch(/Delivery/);
  });
  it("is blocked when no chargeable product is included (everything excluded or quantity 0)", async () => {
    const all = unpriced();
    all.config.exclusions = { ...all.config.exclusions, bulk_tank: "Acceptance test: excluded", feeder: "Acceptance test: excluded" };
    expect(await err(sendUnpriced(await stored(all)))).toMatch(/No chargeable product is included|no commercial amount|nothing for the Estimator/i);
    const zeroQty = unpriced(); zeroQty.config.estimatorQuantities = { bulk_tank: 0, feeder: 0 };
    expect(await err(sendUnpriced(await stored(zeroQty)))).toMatch(/No chargeable product is included|no commercial amount|nothing for the Estimator/i);
  });
  it("an explicit R0.00 on a service that is not required is accepted (that is the fixture); a negative amount is not", async () => {
    const neg = unpriced(); neg.estimator.charges = { delivery: -1, installation: 0 };
    expect(await err(sendUnpriced(await stored(neg)))).toMatch(/Delivery/);
  });
  it("only a Rep may use it (Estimator, Manager and no role are refused) and nothing changes", async () => {
    const id = await stored(unpriced());
    for (const roles of [estimatorOnly, managerOnly, new Set<string>()]) expect(await err(sendUnpriced(id, true, roles))).toMatch(/Requires the rep role/);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("REP_DRAFT");
    expect(row().customer_confirmed_by ?? null).toBeNull();
  });
  it("stays compare-and-set safe: a concurrent submit leaves the loser with nothing recorded", async () => {
    const id = await stored(unpriced());
    const r = row();
    const realRpc = db.rpc.bind(db);
    (db as unknown as { rpc: unknown }).rpc = (fn: string, a: Record<string, unknown>) => { if (fn === "newquip_handoff_with_snapshot") r.state = "ESTIMATOR_REVIEW"; return realRpc(fn, a); };
    expect(await err(sendUnpriced(id))).toMatch(/changed while sending/);
    expect(r.customer_confirmed_cents ?? null).toBeNull();
    expect(await allIndicativeSnapshots(db as never, ORG, id)).toHaveLength(0);
  });
  it("a second submit after the first (state no longer a Rep draft) is refused", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    expect(await err(sendUnpriced(id))).toMatch(/not possible from Estimator review/);
  });
});

describe("a positive indicative price keeps the existing confirmation: the acknowledgement can never replace it", () => {
  it("with an indicative total > 0 the unpriced path is refused and the normal confirmation is unchanged", async () => {
    const priced = readyDraft(); delete priced.estimator.costBasis;
    expect(cents(priced)).toBeGreaterThan(0);
    const id = await stored(priced);
    expect(await err(sendUnpriced(id))).toMatch(/An indicative price exists/);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("REP_DRAFT");
    await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: cents(priced), confirmedBy: "Joe" });
    expect(await loadQuote(db as never, ORG, id)).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: cents(priced), customer_confirmed_by: "Joe" });
  });
  it("the normal handoff still refuses a zero total and does not accept R0 as a confirmed amount", async () => {
    const id = await stored(unpriced());
    expect(await err(sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: 0, confirmedBy: "Joe" }))).toMatch(/No amount can be confirmed yet/);
    expect((await loadQuote(db as never, ORG, id))!.customer_confirmed_cents ?? null).toBeNull();
  });
});

describe("after the unpriced handoff the quotation cannot progress without the Rep's confirmation of the calculated amount", () => {
  /** The Estimator's prices: map the two products (what makes the total > 0), leaving the rest as the fixture. */
  function priced(d: QuoteDraft): QuoteDraft { const c = structuredClone(d); c.estimator.confirmedMappings = { bulk_tank: "SYSH-2750-3", feeder: "PNQ082" }; return withCapturedSupplierCosts(c, ctx).draft; }
  it("sign-off is refused with the explicit no-customer-price message, even when pricing is complete and the total is positive", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    await saveDraft(db as never, ORG, admin, id, priced(unpriced())); // the Estimator establishes the price
    expect(cents(priced(unpriced()))).toBeGreaterThan(0);
    expect(await err(estimatorSignOff(db as never, ORG, estimatorOnly as never, "est@nq", id, ctx))).toMatch(/No customer price has been confirmed yet - return it to the Rep to confirm the calculated amount/);
    expect(row().estimator_signoff_hash ?? null).toBeNull();
  });
  it("approval cannot be reached by skipping reconfirmation (no sign-off, and approval itself refuses a null confirmation)", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    await saveDraft(db as never, ORG, admin, id, priced(unpriced()));
    expect(await err(managerApprove(db as never, ORG, managerOnly as never, "mgr@nq", id, ctx))).toMatch(/never recorded|has not signed off|READY|costing/i);
    // even a forged sign-off hash cannot carry it through: a null confirmation still stops approval
    row().estimator_signoff_hash = row().draft_hash;
    expect(await err(managerApprove(db as never, ORG, managerOnly as never, "mgr@nq", id, ctx))).toMatch(/confirmation was never recorded/);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("ESTIMATOR_REVIEW");
  });
  it("zero or incomplete pricing: sign-off and approval are refused (nothing to sign off)", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    expect(await err(estimatorSignOff(db as never, ORG, estimatorOnly as never, "est@nq", id, ctx))).toMatch(/BLOCKED|resolve/);
    expect(await err(managerApprove(db as never, ORG, managerOnly as never, "mgr@nq", id, ctx))).toMatch(/cannot be approved|BLOCKED/);
  });
  it("the exception is NOT reusable after a priced revision: back with the Rep, a positive total refuses the acknowledgement and the normal amount confirmation is mandatory, after which sign-off works", async () => {
    const id = await stored(unpriced());
    await sendUnpriced(id);
    await saveDraft(db as never, ORG, admin, id, priced(unpriced()));
    await returnToRep(db as never, ORG, estimatorOnly as never, id, "Price established - Rep to confirm the calculated amount", { actor: "est@nq", role: "estimator" } as never);
    const back = await loadQuote(db as never, ORG, id);
    expect(back).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    const total = cents(priced(unpriced()));
    expect(total).toBeGreaterThan(0);
    expect(await err(sendUnpriced(id))).toMatch(/An indicative price exists/); // the acknowledgement path is structurally closed
    expect(await err(sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: total + 1, confirmedBy: "Joe" }))).toMatch(/must equal the quote total/);
    await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Joe" });
    expect(await loadQuote(db as never, ORG, id)).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
    await estimatorSignOff(db as never, ORG, estimatorOnly as never, "est@nq", id, ctx);
    expect(row().estimator_signoff_hash).toBe(row().draft_hash);
  });
});
