import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, returnToRep, saveDraft, sendToEstimator } from "../quote-store";

// UX-006 owner correction, store level (FakeDb): the Rep submits a complete CONFIGURATION without Estimator-owned mappings; nothing is commercially approvable
// while mappings, supplier costs or pricing are unresolved; the Estimator learns of a changed amount at sign-off.

vi.mock("server-only", () => ({}));
const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
let db: FakeDb;

const noException = (d: QuoteDraft): QuoteDraft => { const c = structuredClone(d); delete c.estimator.costBasis; return c; };
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const unmapped = (): QuoteDraft => { const d = readyDraft(); d.estimator.confirmedMappings = {}; d.estimator.confirmedPackages = []; return d; };

async function stored(d: QuoteDraft): Promise<string> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  return id;
}
const send = (id: string, amount: number, by = "Joe") => sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: amount, confirmedBy: by });

beforeEach(() => { db = new FakeDb(); seedGoldenCatalogue(db as never, ORG); });

describe("Rep handoff does not wait for Estimator-owned work", () => {
  it("a Rep submits with mappings / packages unresolved: state moves, the INDICATIVE total is recorded, the audit fields are set", async () => {
    const d = unmapped();
    expect(evaluateDraft(d, ctx).readiness.state).toBe("BLOCKED"); // the full READY still does not hold
    const id = await stored(d);
    const total = cents(d);
    expect(total).toBeGreaterThan(0);
    await send(id, total);
    expect(await loadQuote(db as never, ORG, id)).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total, customer_confirmed_by: "Joe", handoff_by_email: "rep@nq" });
  });
  it("still refuses for a Rep-owned blocker, a wrong amount, a blank confirmer and a non-Rep", async () => {
    const noSite = unmapped(); noSite.siteName = "";
    const a = await stored(noSite);
    expect(await err(send(a, cents(noSite)))).toMatch(/Site \/ project name is required/);
    const noM75 = unmapped(); noM75.estimator.unitPrices = {};
    const b = await stored(noM75);
    expect(await err(send(b, cents(noM75)))).toMatch(/M75/);
    const d = unmapped();
    const c = await stored(d);
    expect(await err(send(c, cents(d) + 1))).toMatch(/must equal the quote total/);
    expect(await err(send(c, cents(d), " "))).toMatch(/who at the customer/);
    expect(await err(sendToEstimator(db as never, ORG, new Set() as never, "x@nq", c, ctx, { confirmedAmountCents: cents(d), confirmedBy: "Joe" }))).toMatch(/Requires the rep role/);
    expect((await loadQuote(db as never, ORG, c))!.state).toBe("REP_DRAFT");
  });
  it("the state compare-and-set still holds: a double submit records one handoff", async () => {
    const d = unmapped();
    const id = await stored(d);
    const row = db.rows("newquip_quotes")[0] as Record<string, unknown>;
    // a concurrent submit lands between the evaluation and the state change
    const from = db.from.bind(db) as (t: string) => Record<string, (...a: unknown[]) => unknown>;
    (db as unknown as { from: unknown }).from = (t: string) => {
      const b = from(t);
      if (t === "newquip_quotes") { const upd = b.update.bind(b); b.update = (...a: unknown[]) => { row.state = "ESTIMATOR_REVIEW"; return upd(...a); }; }
      return b;
    };
    expect(await err(send(id, cents(d)))).toMatch(/changed while sending/);
    expect(row.customer_confirmed_cents ?? null).toBeNull(); // the loser recorded nothing
  });
});

describe("no commercial approval while mappings, supplier costs or pricing are unresolved", () => {
  it("sign-off is refused while a mapping is unresolved, even though the Rep could submit", async () => {
    const d = unmapped();
    const id = await stored(d);
    await send(id, cents(d));
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/BLOCKED/);
  });
  it("the Estimator learns of a changed amount AT SIGN-OFF (resolving mappings changes the total): return to the Rep", async () => {
    const d = unmapped();
    const id = await stored(d);
    await send(id, cents(d));
    await saveDraft(db as never, ORG, member, id, readyDraft()); // Estimator maps everything: the total now includes the mapped lines
    expect(cents(readyDraft())).not.toBe(cents(d));
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toBe("The amount changed since the customer confirmed it. Return it to the Rep to reconfirm.");
    expect((await loadQuote(db as never, ORG, id))!.estimator_signoff_hash).toBeNull();
  });
  it("sign-off and approval are refused while supplier costs are unresolved; an authorised recorded exception allows both", async () => {
    const full = noException(readyDraft());
    const id = await stored(full);
    await send(id, cents(full));
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/Costing is incomplete/);
    // force a sign-off record on the stored row to prove APPROVAL enforces costing on its own
    const row = db.rows("newquip_quotes")[0] as Record<string, unknown>;
    row.estimator_signoff_hash = row.draft_hash; row.estimator_signoff_by_email = "est@nq";
    expect(await err(managerApprove(db as never, ORG, admin, "m@nq", id, ctx))).toMatch(/Costing is incomplete/);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("ESTIMATOR_REVIEW");
    // with the exception recorded (as the cost action does) the same content passes both
    const accepted = readyDraft();
    const id2 = await stored(accepted);
    await send(id2, cents(accepted));
    await estimatorSignOff(db as never, ORG, member, "est@nq", id2, ctx);
    await managerApprove(db as never, ORG, admin, "m@nq", id2, ctx);
    expect((await loadQuote(db as never, ORG, id2))!.state).toBe("MANAGER_APPROVED_FINAL");
  });
  it("the cost-withheld caller learns only the reason text, never a cost or margin value", async () => {
    const full = noException(readyDraft());
    const id = await stored(full);
    await send(id, cents(full));
    const message = await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx));
    expect(message).toMatch(/line\(s\) have no cost|no supplier cost/);
    expect(message).not.toMatch(/R\s?\d|\d+\s?%|estimatedCost|margin pct/i);
  });
  it("returning to the Rep after an Estimator return keeps the quote editable as REP_DRAFT with a new revision", async () => {
    const d = unmapped();
    const id = await stored(d);
    await send(id, cents(d));
    await returnToRep(db as never, ORG, member, id, "Customer changed delivery");
    expect(await loadQuote(db as never, ORG, id)).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    await saveDraft(db as never, ORG, repOnly as never, id, d); // a Rep may edit again
  });
});
