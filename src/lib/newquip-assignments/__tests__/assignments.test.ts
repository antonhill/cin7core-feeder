import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import type { QuoteRecord } from "@/lib/newquip-quotes/quote-store";
import { CLEARED_CUSTOMER_ID } from "@/lib/newquip-quotes/customer-store";
import { activeAssignmentsForRep, assignRep, assignmentsAvailable, assignmentsForCustomer, endAssignment, reassignCustomer } from "../assignment-store";
import { assertRepAssignedToCustomer, assertRepCanSeeQuote, canRepSeeQuote, currentCustomerIdOfQuote, NotVisibleError, quoteIdsForCustomers, visibleQuoteIdsForRep } from "../visibility";
import { findCostKey, stripCostKeys, toRepListItem, toRepQuoteView } from "../rep-view";

vi.mock("server-only", () => ({}));

const ORG = "org-a"; const OTHER = "org-b";
const MGR = { email: "mgr@nq.test" };
const REP_A = { id: "rep-a", email: "a@nq.test" }; const REP_B = { id: "rep-b", email: "b@nq.test" }; const REP_C = { id: "rep-c", email: "c@nq.test" };

const newDb = () => { const db = new FakeDb(); db.assignmentsApplied = true; db.deliveryApplied = true; return db; };
const asDb = (db: FakeDb) => db as never;
const member = (db: FakeDb, rep: { id: string }, org = ORG) => { db.rows("org_members").push({ org_id: org, user_id: rep.id, role: "member" }); };
const quote = (db: FakeDb, id: string, o: { org?: string; customer?: string | null; createdBy?: string; state?: string; revision?: number; created?: string } = {}) => {
  const org = o.org ?? ORG;
  db.rows("newquip_quotes").push({ id, org_id: org, quote_ref: `NQ-${id}`, revision: o.revision ?? 1, customer_name: "Farm", site_name: "Site", quote_type: "project", state: o.state ?? "REP_DRAFT", draft: readyDraft(), contract_cents: null, project_id: null, created_by_email: o.createdBy ?? "creator@nq.test", created_at: o.created ?? "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
  if (o.customer) snapshot(db, id, o.customer, 1, org);
};
const snapshot = (db: FakeDb, quoteId: string, customer: string, seq: number, org = ORG) => db.rows("newquip_quote_customers").push({ id: `s-${quoteId}-${seq}`, org_id: org, quote_id: quoteId, seq, cin7_customer_id: customer, snapshot: {}, snapshot_hash: "h" });
const assign = (db: FakeDb, rep: { id: string; email: string }, customer: string, org = ORG) => assignRep(asDb(db), org, MGR, { cin7CustomerId: customer, customerName: `Customer ${customer}`, repUserId: rep.id, repEmail: rep.email });
const ids = async (db: FakeDb, rep: { id: string }, org = ORG) => (await visibleQuoteIdsForRep(asDb(db), org, rep.id)).sort();

describe("assignments: multiple Reps, history, idempotency", () => {
  it("several Reps may be ACTIVE on one customer; each sees the customer's quotations", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" });
    await assign(db, REP_A, "c1"); await assign(db, REP_B, "c1");
    expect(await ids(db, REP_A)).toEqual(["q1"]); expect(await ids(db, REP_B)).toEqual(["q1"]);
    expect((await assignmentsForCustomer(asDb(db), ORG, "c1")).filter((a) => !a.ended_at)).toHaveLength(2);
  });
  it("assigning the same Rep twice is idempotent (no second active row)", async () => {
    const db = newDb();
    const first = await assign(db, REP_A, "c1"); const again = await assign(db, REP_A, "c1");
    expect(first.created).toBe(true); expect(again.created).toBe(false); expect(again.assignment.id).toBe(first.assignment.id);
    expect(db.rows("customer_rep_assignments")).toHaveLength(1);
  });
  it("ending needs a real reason, records who and why, never deletes, and cannot be repeated", async () => {
    const db = newDb(); const { assignment } = await assign(db, REP_A, "c1");
    await expect(endAssignment(asDb(db), ORG, MGR, assignment.id, "x")).rejects.toThrow(/reason/);
    const ended = await endAssignment(asDb(db), ORG, MGR, assignment.id, "customer moved to another Rep");
    expect(ended.ended_by_email).toBe(MGR.email); expect(ended.end_reason).toMatch(/moved/); expect(ended.ended_at).toBeTruthy();
    await expect(endAssignment(asDb(db), ORG, MGR, assignment.id, "again please")).rejects.toThrow(/already ended/);
    expect(db.rows("customer_rep_assignments")).toHaveLength(1);                       // history kept
    expect(await activeAssignmentsForRep(asDb(db), ORG, REP_A.id)).toHaveLength(0);
  });
  it("assigning the same Rep again later is a NEW row; the earlier period stays in the history", async () => {
    const db = newDb(); const a = await assign(db, REP_A, "c1");
    await endAssignment(asDb(db), ORG, MGR, a.assignment.id, "temporary cover ended");
    const b = await assign(db, REP_A, "c1");
    expect(b.created).toBe(true); expect(b.assignment.id).not.toBe(a.assignment.id);
    expect((await assignmentsForCustomer(asDb(db), ORG, "c1"))).toHaveLength(2);
    expect(await activeAssignmentsForRep(asDb(db), ORG, REP_A.id)).toHaveLength(1);
  });
  it("cannot end an assignment of another organisation", async () => {
    const db = newDb(); const { assignment } = await assign(db, REP_A, "c1");
    await expect(endAssignment(asDb(db), OTHER, MGR, assignment.id, "wrong organisation")).rejects.toThrow(/not found/);
    expect(await activeAssignmentsForRep(asDb(db), ORG, REP_A.id)).toHaveLength(1);
  });
});

describe("visibility follows the CUSTOMER assignment, not who created the quotation", () => {
  it("a Rep sees quotations created by anyone for an assigned customer, and not their own for an unassigned one", async () => {
    const db = newDb();
    quote(db, "by-other", { customer: "c1", createdBy: "someone.else@nq.test" });
    quote(db, "by-me-unassigned", { customer: "c2", createdBy: REP_A.email });
    await assign(db, REP_A, "c1");
    expect(await ids(db, REP_A)).toEqual(["by-other"]);
    expect(await canRepSeeQuote(asDb(db), ORG, REP_A.id, "by-me-unassigned")).toBe(false);
  });
  it("an unassigned Rep sees nothing; a Rep of a different customer sees nothing of this one", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" }); await assign(db, REP_B, "c2");
    expect(await ids(db, REP_C)).toEqual([]); expect(await ids(db, REP_B)).toEqual([]);
    await expect(assertRepCanSeeQuote(asDb(db), ORG, REP_B.id, "q1")).rejects.toBeInstanceOf(NotVisibleError);
  });
  it("history is included: every state and revision of an assigned customer's quotations", async () => {
    const db = newDb();
    quote(db, "draft", { customer: "c1", state: "REP_DRAFT" }); quote(db, "review", { customer: "c1", state: "ESTIMATOR_REVIEW" });
    quote(db, "issued-r1", { customer: "c1", state: "MANAGER_APPROVED_FINAL", revision: 1 }); quote(db, "issued-r2", { customer: "c1", state: "MANAGER_APPROVED_FINAL", revision: 2 });
    await assign(db, REP_A, "c1");
    expect(await ids(db, REP_A)).toEqual(["draft", "issued-r1", "issued-r2", "review"]);
  });
  it("a quotation with no customer yet, or a cleared selection, is visible to nobody through this boundary", async () => {
    const db = newDb(); quote(db, "none", { customer: null }); quote(db, "cleared", { customer: "c1" }); snapshot(db, "cleared", CLEARED_CUSTOMER_ID, 2);
    await assign(db, REP_A, "c1");
    expect(await ids(db, REP_A)).toEqual([]); expect(await currentCustomerIdOfQuote(asDb(db), ORG, "cleared")).toBeNull();
  });
  it("only the CURRENT customer counts: a quotation moved to another customer follows the new customer's Reps", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" }); snapshot(db, "q1", "c2", 2);
    await assign(db, REP_A, "c1"); await assign(db, REP_B, "c2");
    expect(await ids(db, REP_A)).toEqual([]); expect(await ids(db, REP_B)).toEqual(["q1"]);
  });
  it("cross-organisation: the same customer id elsewhere is unrelated, in both directions", async () => {
    const db = newDb();
    quote(db, "a1", { customer: "c1" }); quote(db, "b1", { customer: "c1", org: OTHER });
    await assign(db, REP_A, "c1");                                   // Rep A in org A
    await assign(db, REP_B, "c1", OTHER);                            // Rep B in org B, SAME Cin7 customer id
    expect(await ids(db, REP_A)).toEqual(["a1"]); expect(await ids(db, REP_B, OTHER)).toEqual(["b1"]);
    expect(await ids(db, REP_B)).toEqual([]);                        // org B's Rep has no standing in org A
    expect(await canRepSeeQuote(asDb(db), ORG, REP_A.id, "b1")).toBe(false);   // org A's Rep cannot reach org B's quotation id
    expect(await canRepSeeQuote(asDb(db), OTHER, REP_A.id, "a1")).toBe(false);
  });
  it("direct id access: an unknown quotation id and a forbidden one fail identically", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" });
    const forbidden = await assertRepCanSeeQuote(asDb(db), ORG, REP_A.id, "q1").catch((e: Error) => e.message);
    const unknown = await assertRepCanSeeQuote(asDb(db), ORG, REP_A.id, "does-not-exist").catch((e: Error) => e.message);
    expect(forbidden).toBe("Quote not found."); expect(unknown).toBe(forbidden);
    await expect(assertRepAssignedToCustomer(asDb(db), ORG, REP_A.id, "c1")).rejects.toBeInstanceOf(NotVisibleError);
  });
  it("scales past PostgREST's row cap: 1,100 quotations of one customer are all returned (paged, not truncated)", async () => {
    const db = newDb(); db.maxRows = 1000;
    for (let i = 0; i < 1100; i++) quote(db, `q${String(i).padStart(4, "0")}`, { customer: "c1" });
    await assign(db, REP_A, "c1");
    expect(await visibleQuoteIdsForRep(asDb(db), ORG, REP_A.id)).toHaveLength(1100);
    expect(await quoteIdsForCustomers(asDb(db), ORG, new Set(["c1"]))).toHaveLength(1100);
  });
});

describe("revocation and reassignment take effect on the very next read", () => {
  it("ending an assignment removes access to ALL of that customer's quotations at once", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" }); quote(db, "q2", { customer: "c1", state: "MANAGER_APPROVED_FINAL" });
    const { assignment } = await assign(db, REP_A, "c1");
    expect(await ids(db, REP_A)).toEqual(["q1", "q2"]);
    await endAssignment(asDb(db), ORG, MGR, assignment.id, "customer left the Rep");
    expect(await ids(db, REP_A)).toEqual([]); expect(await canRepSeeQuote(asDb(db), ORG, REP_A.id, "q2")).toBe(false);
  });
  it("revoking one Rep leaves the other assigned Rep's access untouched", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" });
    const a = await assign(db, REP_A, "c1"); await assign(db, REP_B, "c1");
    await endAssignment(asDb(db), ORG, MGR, a.assignment.id, "no longer covers this farm");
    expect(await ids(db, REP_A)).toEqual([]); expect(await ids(db, REP_B)).toEqual(["q1"]);
  });
  it("reassigning moves access from one Rep to another, keeping both periods in the history", async () => {
    const db = newDb(); quote(db, "q1", { customer: "c1" }); member(db, REP_C); const a = await assign(db, REP_A, "c1");
    const r = await reassignCustomer(asDb(db), ORG, MGR, { cin7CustomerId: "c1", customerName: "Farm", fromRepUserId: REP_A.id, toRepUserId: REP_C.id, toRepEmail: REP_C.email, reason: "territory change" });
    expect(r.created).toBe(true); expect(r.ended.id).toBe(a.assignment.id); expect(r.ended.rep_user_id).toBe(REP_A.id); expect(r.assigned.rep_user_id).toBe(REP_C.id);
    expect(await ids(db, REP_A)).toEqual([]); expect(await ids(db, REP_C)).toEqual(["q1"]);
    expect(await assignmentsForCustomer(asDb(db), ORG, "c1")).toHaveLength(2);
  });
});

describe("reassignment is ATOMIC: all of it, or none of it", () => {
  const move = (db: FakeDb, over: Partial<Parameters<typeof reassignCustomer>[3]> = {}, org = ORG) =>
    reassignCustomer(asDb(db), org, MGR, { cin7CustomerId: "c1", customerName: "Farm", fromRepUserId: REP_A.id, toRepUserId: REP_C.id, toRepEmail: REP_C.email, reason: "territory change", ...over });
  const world = async () => { const db = newDb(); quote(db, "q1", { customer: "c1" }); member(db, REP_A); member(db, REP_B); member(db, REP_C); const a = await assign(db, REP_A, "c1"); return { db, a }; };

  it("a FAILURE while creating the replacement leaves the previous assignment ACTIVE and unchanged: the customer keeps its Rep", async () => {
    const { db, a } = await world(); const before = JSON.stringify(db.rows("customer_rep_assignments"));
    await expect(move(db, { toRepEmail: "x@" })).rejects.toThrow(/check constraint/);   // the replacement INSERT violates a CHECK, after the old row was updated
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(before);           // byte-for-byte: no end marker, no new row
    expect(await ids(db, REP_A)).toEqual(["q1"]); expect(await ids(db, REP_C)).toEqual([]);
    expect((await activeAssignmentsForRep(asDb(db), ORG, REP_A.id)).map((x) => x.id)).toEqual([a.assignment.id]);
  });
  it("every other refusal also changes NOTHING: not a member, not assigned, same Rep, trivial reason, another organisation", async () => {
    const { db } = await world(); const before = JSON.stringify(db.rows("customer_rep_assignments"));
    const outsider = { id: "outsider", email: "o@nq.test" };               // exists in no organisation
    await expect(move(db, { toRepUserId: outsider.id, toRepEmail: outsider.email })).rejects.toThrow(/not a member of this organisation/);
    await expect(move(db, { fromRepUserId: REP_B.id })).rejects.toThrow(/not currently assigned/);
    await expect(move(db, { toRepUserId: REP_A.id })).rejects.toThrow(/different Rep/);
    await expect(move(db, { reason: "x" })).rejects.toThrow(/reason/);
    await expect(move(db, {}, OTHER)).rejects.toThrow(/not a member|not currently assigned/);
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(before);
    expect(await ids(db, REP_A)).toEqual(["q1"]);
  });
  it("only the INTENDED assignment ends: other Reps on the same customer, and other customers, are untouched", async () => {
    const { db } = await world(); quote(db, "q2", { customer: "c2" });
    const b = await assign(db, REP_B, "c1"); const other = await assign(db, REP_A, "c2");
    const snap = (id: string) => JSON.stringify(db.rows("customer_rep_assignments").find((r) => r.id === id));
    const [bBefore, otherBefore] = [snap(b.assignment.id), snap(other.assignment.id)];
    await move(db);
    expect(snap(b.assignment.id)).toBe(bBefore); expect(snap(other.assignment.id)).toBe(otherBefore);   // identical rows, never even touched
    expect(await ids(db, REP_B)).toEqual(["q1"]); expect(await ids(db, REP_A)).toEqual(["q2"]); expect(await ids(db, REP_C)).toEqual(["q1"]);
  });
  it("history and audit fields are consistent: who ended it and why, who created the replacement and why, with the owner under Demo Mode", async () => {
    const { db } = await world(); const demo = { email: "testing@nq.test", ownerEmail: "owner@nq.test" };
    const r = await reassignCustomer(asDb(db), ORG, demo, { cin7CustomerId: "c1", customerName: "Farm C1", fromRepUserId: REP_A.id, toRepUserId: REP_C.id, toRepEmail: "C@NQ.test", reason: "  territory change  " });
    expect(r.ended).toMatchObject({ rep_user_id: REP_A.id, ended_by_email: demo.email, end_reason: "territory change" }); expect(r.ended.ended_at).toBeTruthy();
    expect(r.assigned).toMatchObject({ rep_user_id: REP_C.id, rep_email: "c@nq.test", assigned_by_email: demo.email, assigned_by_owner_email: demo.ownerEmail, assigned_reason: "territory change", customer_name: "Farm C1", ended_at: null });
    const hist = await assignmentsForCustomer(asDb(db), ORG, "c1");
    expect(hist).toHaveLength(2); expect(hist.filter((h) => !h.ended_at)).toHaveLength(1);
  });
  it("a duplicate or replayed request is refused and creates NO duplicate active assignment or history row", async () => {
    const { db } = await world(); await move(db);
    const after = JSON.stringify(db.rows("customer_rep_assignments"));
    await expect(move(db)).rejects.toThrow(/not currently assigned/);
    await expect(move(db)).rejects.toThrow(/not currently assigned/);
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(after);
    expect((await assignmentsForCustomer(asDb(db), ORG, "c1")).filter((h) => !h.ended_at && h.rep_user_id === REP_C.id)).toHaveLength(1);
  });
  it("moving to a Rep who is ALREADY assigned ends the old access and creates no duplicate (created = false)", async () => {
    const { db } = await world(); const c = await assign(db, REP_C, "c1");
    const r = await move(db);
    expect(r.created).toBe(false); expect(r.assigned.id).toBe(c.assignment.id);
    expect(db.rows("customer_rep_assignments")).toHaveLength(2);
    expect((await assignmentsForCustomer(asDb(db), ORG, "c1")).filter((h) => !h.ended_at)).toHaveLength(1);
  });
  it("simultaneous requests (A to C and A to B) are serialised: exactly one wins, the loser changes nothing, the customer always has exactly one of the intended Reps", async () => {
    const { db } = await world();
    const results = await Promise.allSettled([move(db, { toRepUserId: REP_C.id, toRepEmail: REP_C.email }), move(db, { toRepUserId: REP_B.id, toRepEmail: REP_B.email }), move(db), move(db)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => /not currently assigned/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    const active = (await assignmentsForCustomer(asDb(db), ORG, "c1")).filter((h) => !h.ended_at);
    expect(active).toHaveLength(1); expect([REP_B.id, REP_C.id]).toContain(active[0].rep_user_id);
    expect(db.rows("customer_rep_assignments").filter((r) => r.ended_at && r.rep_user_id === REP_A.id)).toHaveLength(1);   // A ended exactly once
    const ended = db.rows("customer_rep_assignments").find((r) => r.ended_at && r.rep_user_id === REP_A.id)!;
    expect(ended.replaced_by_assignment_id).toBe(active[0].id);                          // the recorded successor is the WINNER's active row, never the loser's
  });
  describe("durable replacement linkage (replaced_by_assignment_id)", () => {
    it("a NEW target: the ended row names exactly the created row, and the new row names nothing", async () => {
      const { db, a } = await world(); const r = await move(db);
      expect(r.created).toBe(true);
      const ended = db.rows("customer_rep_assignments").find((x) => x.id === a.assignment.id)!;
      expect(ended.replaced_by_assignment_id).toBe(r.assigned.id); expect(r.ended.replaced_by_assignment_id).toBe(r.assigned.id);
      expect(r.assigned.replaced_by_assignment_id ?? null).toBeNull();
      expect(r.assigned.rep_user_id).toBe(REP_C.id); expect(ended.rep_user_id).toBe(REP_A.id);   // previous Rep, replacement Rep, actor, reason, timestamp all derivable from the two rows
      expect(ended.ended_by_email).toBe(MGR.email); expect(ended.end_reason).toBe("territory change"); expect(ended.ended_at).toBeTruthy();
    });
    it("an EXISTING active target: the ended row names that existing row, which is not modified", async () => {
      const { db } = await world(); const c = await assign(db, REP_C, "c1"); const cBefore = JSON.stringify(db.rows("customer_rep_assignments").find((x) => x.id === c.assignment.id));
      const r = await move(db);
      expect(r.created).toBe(false); expect(r.ended.replaced_by_assignment_id).toBe(c.assignment.id);
      expect(JSON.stringify(db.rows("customer_rep_assignments").find((x) => x.id === c.assignment.id))).toBe(cBefore);
    });
    it("a failed reassignment leaves NO successor link; a replay does not change the recorded one; a plain end names none", async () => {
      const { db, a } = await world();
      await expect(move(db, { toRepEmail: "x@" })).rejects.toThrow(/check constraint/);
      expect(db.rows("customer_rep_assignments").every((x) => !x.replaced_by_assignment_id)).toBe(true);
      const r = await move(db); await expect(move(db)).rejects.toThrow(/not currently assigned/);
      expect(db.rows("customer_rep_assignments").find((x) => x.id === a.assignment.id)!.replaced_by_assignment_id).toBe(r.assigned.id);
      const plain = await assign(db, REP_B, "c1"); const ended = await endAssignment(asDb(db), ORG, MGR, plain.assignment.id, "no longer covering");
      expect(ended.replaced_by_assignment_id ?? null).toBeNull();
    });
    it("each reassignment in a chain (A to C, then C to B) records its own exact successor", async () => {
      const { db, a } = await world(); const first = await move(db);
      const second = await move(db, { fromRepUserId: REP_C.id, toRepUserId: REP_B.id, toRepEmail: REP_B.email });
      const byId = (id: string) => db.rows("customer_rep_assignments").find((x) => x.id === id)!;
      expect(byId(a.assignment.id).replaced_by_assignment_id).toBe(first.assigned.id);
      expect(byId(first.assigned.id).replaced_by_assignment_id).toBe(second.assigned.id);
      expect(byId(second.assigned.id).replaced_by_assignment_id ?? null).toBeNull();
    });
  });
  it("it changes NO quotation, Project or approval row, and writes only through the one function", async () => {
    const { db } = await world(); db.rows("projects").push({ id: "p1", org_id: ORG }); db.rows("approval_requests").push({ id: "r1", org_id: ORG });
    const frozen = JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_quote_customers"), db.rows("projects"), db.rows("approval_requests")]); db.writes.length = 0;
    await move(db);
    expect(JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_quote_customers"), db.rows("projects"), db.rows("approval_requests")])).toBe(frozen);
    expect([...new Set(db.writes.map((w) => w.table))]).toEqual(["customer_rep_assignments"]);
  });
  it("there is NO fallback to separate end + create calls: without the database function the call fails closed and changes nothing", async () => {
    const { db } = await world(); const before = JSON.stringify(db.rows("customer_rep_assignments"));
    (db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: "Could not find the function public.customer_rep_reassign in the schema cache" } });
    await expect(move(db)).rejects.toThrow(/not available/);
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(before);
  });
  it("historical quotation visibility follows the RESULTING active assignments (every state and revision moves with the customer)", async () => {
    const { db } = await world();
    quote(db, "draft", { customer: "c1", state: "REP_DRAFT" }); quote(db, "approved-r1", { customer: "c1", state: "MANAGER_APPROVED_FINAL", revision: 1 }); quote(db, "approved-r2", { customer: "c1", state: "MANAGER_APPROVED_FINAL", revision: 2 });
    const all = ["approved-r1", "approved-r2", "draft", "q1"];
    expect(await ids(db, REP_A)).toEqual(all);
    await move(db);
    expect(await ids(db, REP_A)).toEqual([]); expect(await ids(db, REP_C)).toEqual(all);
    await expect(move(db, { toRepEmail: "x@" , fromRepUserId: REP_C.id, toRepUserId: REP_B.id })).rejects.toThrow();   // a failed move changes nothing
    expect(await ids(db, REP_C)).toEqual(all); expect(await ids(db, REP_B)).toEqual([]);
  });
});

describe("fails closed when the migration is not applied", () => {
  it("no assignments exist, so no Rep sees anything, and nothing throws", async () => {
    const db = new FakeDb(); db.deliveryApplied = true; quote(db, "q1", { customer: "c1" });
    expect(await assignmentsAvailable(asDb(db))).toBe(false);
    expect(await activeAssignmentsForRep(asDb(db), ORG, REP_A.id)).toEqual([]); expect(await visibleQuoteIdsForRep(asDb(db), ORG, REP_A.id)).toEqual([]);
    expect(await canRepSeeQuote(asDb(db), ORG, REP_A.id, "q1")).toBe(false);
  });
});

describe("Rep responses carry no cost, margin or supplier information", () => {
  const SENTINEL = 987654.321;
  const costly = (): QuoteRecord => {
    const draft = readyDraft();
    (draft.estimator as unknown as Record<string, unknown>).costOverrides = { feeder: { unitCostExVat: SENTINEL, reason: "negotiated", by: "e@nq.test", at: "t" } };
    (draft.estimator as unknown as Record<string, unknown>).physicalCosts = { SKU1: { unitCostCents: Math.round(SENTINEL * 100), source: "CIN7_LATEST" } };
    (draft.estimator as unknown as Record<string, unknown>).costBasis = { incompleteAccepted: { reason: "r", by: "e@nq.test", at: "t" } };
    return { id: "q1", org_id: ORG, quote_ref: "NQ-1", revision: 1, customer_name: "Farm", site_name: "Site", quote_type: "project", state: "MANAGER_APPROVED_FINAL", draft, draft_hash: "h", customer_confirmed_cents: 1, customer_confirmed_by: null, customer_confirmed_at: null,
      handoff_by_email: null, estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null, approved_by_email: null, approved_at: null, accepted_baseline: { internalMargin: { gp: SENTINEL } } as never, baseline_hash: "b", contract_cents: 1000, project_id: null, created_by_email: null, created_at: "t", updated_at: "t" } as QuoteRecord;
  };
  it("CONTROL: the unredacted evaluation does contain cost keys, so the checks below can fail", () => {
    const q = costly();
    expect(findCostKey(evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: false }))).not.toBeNull();
  });
  it("the Rep view is allowlist-built: no estimator state, no baseline, no cost keys at any depth, no cost values", () => {
    const q = costly();
    const v = toRepQuoteView(q, evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: false }), null); // even handed an UNREDACTED evaluation
    const text = JSON.stringify(v);
    expect(findCostKey(v)).toBeNull();
    for (const banned of ["costOverrides", "physicalCosts", "costBasis", "internalMargin", "estimatedCost", "estimatedGP", "marginPct", "overallMarginPct", "accepted_baseline", "\"estimator\":"]) expect(text, banned).not.toContain(banned);
    expect(text).not.toContain(String(SENTINEL)); expect(text).not.toContain("98765432");
    expect(Object.keys(v).sort()).toEqual(["commercial", "draft", "evaluation", "quote"]);
    expect(Object.keys(v.draft).sort()).toEqual(["config", "customerName", "quoteType", "siteName"]);
  });
  it("the list item exposes only named fields (a selling total, never a cost)", () => {
    expect(Object.keys(toRepListItem(costly())).sort()).toEqual(["contractCents", "createdAt", "customerName", "id", "projectId", "quoteRef", "quoteType", "revision", "siteName", "state", "updatedAt"]);
  });
  it("stripCostKeys / findCostKey handle nesting, arrays and look-alike names", () => {
    const v = { a: [{ estimatedGP: 1, ok: 2 }], b: { nested: { landedCostExVat: 3, keep: 4 } }, supplierName: "x", freightRate: 1, roe: 20, unitPrice: 5 };
    expect(findCostKey(v)).not.toBeNull();
    expect(stripCostKeys(v)).toEqual({ a: [{ ok: 2 }], b: { nested: { keep: 4 } }, unitPrice: 5 });
    expect(findCostKey(stripCostKeys(v))).toBeNull();
  });
});
