import { describe, expect, it } from "vitest";
import { applyFilters, classify, daysBetween, indexData, inRange, isMine, overviewOf, paginate, pipelineRows, sellingValue, sortRows, type ReportData, type ReportQuote, type Viewer } from "../ops";

const NOW = new Date("2026-11-18T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const quote = (o: Partial<ReportQuote> & { id: string }): ReportQuote => ({
  quote_ref: `NQ-Q-${o.id}`, revision: 1, customer_name: "Farm A", site_name: "Site", state: "REP_DRAFT", draft_hash: "h", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  customer_confirmed_cents: null, customer_confirmed_at: null, handoff_by_email: null, approved_by_email: null, approved_at: null, contract_cents: null, project_id: null, requires_customer_acceptance: true,
  created_by_email: "rep@x.test", created_at: day(10), ...o,
});
const data = (over: Partial<ReportData> = {}): ReportData => ({ quotes: [], approvals: [], documents: [], sends: [], responses: [], reviews: [], evidence: new Map(), projects: [], ...over });
const stage = (q: ReportQuote, d: ReportData) => classify(q, indexData(d), d);

describe("stage classification uses the application's own states", () => {
  it("Rep draft rev 1: age from creation; returned (rev>1): age NOT back-filled from creation", () => {
    const a = quote({ id: "1" }); const b = quote({ id: "2", revision: 2 });
    const rows = pipelineRows(data({ quotes: [a, b] }), NOW);
    expect(rows[0]).toMatchObject({ category: "REP_DRAFT", ageDays: 10, waitingOn: "Rep" });
    expect(rows[1]).toMatchObject({ category: "REP_CORRECTION", ageDays: null });
    expect(rows[1].sinceSource).toMatch(/Not recorded/);
  });
  it("Estimator review waits on any eligible Estimator, aged from the hand-off", () => {
    const q = quote({ id: "3", state: "ESTIMATOR_REVIEW", customer_confirmed_at: day(4), customer_confirmed_cents: 100 });
    expect(stage(q, data())).toMatchObject({ category: "ESTIMATOR_REVIEW", waitingOn: "Estimator", waitingOnLabel: "Any eligible Estimator", assignedTo: null, since: day(4) });
  });
  it("a signed-off quotation is with the Manager; the pending approval request supplies the assignee and the entry time", () => {
    const q = quote({ id: "4", state: "ESTIMATOR_REVIEW", draft_hash: "x", estimator_signoff_hash: "x", estimator_signoff_at: day(6) });
    const none = stage(q, data({ quotes: [q] }));
    expect(none).toMatchObject({ category: "MANAGER_APPROVAL", assignedTo: null, waitingOnLabel: "Any eligible Manager", since: day(6) });
    const d = data({ quotes: [q], approvals: [{ doc_id: "4", revision: 1, status: "PENDING", assigned_to_email: "mgr@x.test", submitted_at: day(2), decided_at: null, decided_by_email: null }] });
    expect(stage(q, d)).toMatchObject({ assignedTo: "mgr@x.test", waitingOnLabel: "mgr@x.test", since: day(2) });
  });
  it("multiple approval records for one quotation never double-count it", () => {
    const q = quote({ id: "5", state: "ESTIMATOR_REVIEW", draft_hash: "x", estimator_signoff_hash: "x" });
    const ap = (rev: number, status: string) => ({ doc_id: "5", revision: rev, status, assigned_to_email: null, submitted_at: day(9 - rev), decided_at: day(8 - rev), decided_by_email: "m@x.test" });
    const d = data({ quotes: [q], approvals: [ap(1, "RETURNED"), ap(2, "RETURNED"), { ...ap(3, "PENDING"), decided_at: null, decided_by_email: null }] });
    const rows = pipelineRows(d, NOW);
    expect(rows).toHaveLength(1);
    expect(overviewOf(rows, [], NOW).awaitingManager).toBe(1);
  });
  const approved = quote({ id: "6", state: "MANAGER_APPROVED_FINAL", approved_at: day(5), contract_cents: 1_000_000, approved_by_email: "m@x.test" });
  it("approved with no document -> not issued; with a document -> not sent; sent -> awaiting the customer", () => {
    expect(stage(approved, data())).toMatchObject({ category: "DOC_NOT_ISSUED", since: day(5) });
    const doc = { id: "d1", quote_id: "6", revision: 1, version: 1, created_at: day(4), issued_by_email: "r@x.test" };
    expect(stage(approved, data({ documents: [doc] }))).toMatchObject({ category: "NOT_SENT", since: day(4) });
    const send = { id: "s1", quote_id: "6", document_id: "d1", status: "ACCEPTED", sent_by_email: "r@x.test", created_at: day(3), attempted_at: day(3) };
    expect(stage(approved, data({ documents: [doc], sends: [send] }))).toMatchObject({ category: "AWAITING_CUSTOMER", waitingOn: "Customer", since: day(3), customerResponse: "Awaiting response" });
    expect(stage(approved, data({ documents: [doc], sends: [{ ...send, status: "FAILED" }] })).category).toBe("NOT_SENT");
  });
  it("a customer-link acceptance is PENDING verification until reviewed; then it is handover", () => {
    const doc = { id: "d1", quote_id: "6", revision: 1, version: 1, created_at: day(4), issued_by_email: "r@x.test" };
    const resp = { id: "r1", quote_id: "6", document_id: "d1", response: "ACCEPTED" as const, recorded_by_email: "customer", created_at: day(1), origin: "CUSTOMER_LINK" as const, contact_source: null };
    expect(stage(approved, data({ documents: [doc], responses: [resp] }))).toMatchObject({ category: "ACCEPTANCE_VERIFICATION", customerResponse: "Accepted, verification pending", since: day(1) });
    const review = { id: "v1", quote_id: "6", response_id: "r1", decision: "VERIFIED" as const, reviewed_by_email: "m@x.test", created_at: day(0) };
    expect(stage(approved, data({ documents: [doc], responses: [resp], reviews: [review] }))).toMatchObject({ category: "PROJECT_HANDOVER", customerResponse: "Accepted", lastActionBy: "m@x.test" });
  });
  it("declined and changes-requested are follow-ups; a project makes it complete (no action, no age)", () => {
    const doc = { id: "d1", quote_id: "6", revision: 1, version: 1, created_at: day(4), issued_by_email: "r@x.test" };
    const r = (response: "DECLINED" | "CHANGES_REQUESTED") => ({ id: "r1", quote_id: "6", document_id: "d1", response, recorded_by_email: "c", created_at: day(1), origin: "CUSTOMER_LINK" as const, contact_source: null });
    expect(stage(approved, data({ documents: [doc], responses: [r("DECLINED")] })).category).toBe("CUSTOMER_DECLINED");
    expect(stage(approved, data({ documents: [doc], responses: [r("CHANGES_REQUESTED")] })).category).toBe("CHANGES_REQUESTED");
    const done = pipelineRows(data({ quotes: [{ ...approved, project_id: "p1" }], projects: [{ id: "p1", project_reference: "PRJ-1", name: "n", customer_name: "c", status: "ACTIVE", original_contract_cents: 5, created_at: day(1), parent_project_id: null, billing_scope: null }] }), NOW)[0];
    expect(done).toMatchObject({ category: "COMPLETE", outstanding: false, ageDays: null, projectRef: "PRJ-1" });
  });
  it("a grandfathered approved quotation (no acceptance required) goes straight to Project handover", () => {
    expect(stage({ ...approved, requires_customer_acceptance: false }, data()).category).toBe("PROJECT_HANDOVER");
  });
});

describe("stage age", () => {
  it("is whole days, never negative, and null (not creation age) when unknown", () => {
    expect(daysBetween(day(3.9), NOW)).toBe(3); expect(daysBetween(new Date(NOW.getTime() + 5e6).toISOString(), NOW)).toBe(0);
    expect(daysBetween(null, NOW)).toBeNull(); expect(daysBetween("garbage", NOW)).toBeNull();
  });
});

describe("value", () => {
  it("is the approved contract once approved, else the confirmed (indicative) amount, else none: never computed", () => {
    expect(sellingValue({ state: "MANAGER_APPROVED_FINAL", contract_cents: 10, customer_confirmed_cents: 99 })).toEqual({ cents: 10, basis: "CONTRACT" });
    expect(sellingValue({ state: "ESTIMATOR_REVIEW", contract_cents: null, customer_confirmed_cents: 99 })).toEqual({ cents: 99, basis: "CONFIRMED" });
    expect(sellingValue({ state: "REP_DRAFT", contract_cents: null, customer_confirmed_cents: null })).toEqual({ cents: null, basis: "NONE" });
  });
  it("overview totals each quotation once and excludes declined from the pipeline value", () => {
    const qs = [quote({ id: "a", customer_confirmed_cents: 100 }), quote({ id: "b", customer_confirmed_cents: 250, state: "ESTIMATOR_REVIEW", customer_confirmed_at: day(1) }), quote({ id: "c" })];
    const o = overviewOf(pipelineRows(data({ quotes: qs }), NOW), [], NOW);
    expect(o).toMatchObject({ open: 3, indicativePipelineCents: 350, withoutValue: 1, awaitingRep: 2, awaitingEstimator: 1, total: 3 });
  });
});

describe("filters, sorting, pagination", () => {
  const rep: Viewer = { email: "rep@x.test", roles: new Set(["rep"]) }; const est: Viewer = { email: "e@x.test", roles: new Set(["estimator"]) }; const mgr: Viewer = { email: "m@x.test", roles: new Set(["manager"]) };
  const qs = [quote({ id: "1", created_by_email: "rep@x.test", created_at: day(10), customer_confirmed_cents: 5 }), quote({ id: "2", created_by_email: "other@x.test", created_at: day(2), customer_name: "Zebra Farm" }),
    quote({ id: "3", state: "ESTIMATOR_REVIEW", customer_confirmed_at: day(8), customer_confirmed_cents: 900 })];
  const rows = pipelineRows(data({ quotes: qs }), NOW);
  it("'my actions' means: a Rep's own created drafts, the Estimator queue, a Manager's (unassigned or own) approvals", () => {
    expect(applyFilters(rows, { view: "mine" }, rep).map((r) => r.id)).toEqual(["1"]);
    expect(applyFilters(rows, { view: "mine" }, est).map((r) => r.id)).toEqual(["3"]);
    expect(applyFilters(rows, { view: "mine" }, mgr)).toHaveLength(0);
    expect(isMine(rows[0], { email: "REP@x.test", roles: new Set(["rep"]) })).toBe(true);
  });
  it("age views and date range", () => {
    expect(applyFilters(rows, { view: "over7" }, mgr).map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(applyFilters(rows, { view: "over3" }, mgr)).toHaveLength(2);
    expect(inRange(day(10), "2026-11-08", "2026-11-18")).toBe(true); expect(inRange(day(10), "2026-11-12")).toBe(false); expect(inRange(day(10), "not-a-date", "bad")).toBe(true);
    expect(applyFilters(rows, { customer: "zebra" }, mgr).map((r) => r.id)).toEqual(["2"]);
    expect(applyFilters(rows, { q: "nq-q-3" }, mgr).map((r) => r.id)).toEqual(["3"]);
  });
  it("sorting is deterministic and puts unknown values last in both directions", () => {
    expect(sortRows(rows, "value", "desc").map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(sortRows(rows, "value", "asc").map((r) => r.id)).toEqual(["1", "3", "2"]);
    const same = pipelineRows(data({ quotes: ["x", "a", "m"].map((id) => quote({ id, customer_confirmed_cents: 7 })) }), NOW);
    expect(sortRows(same, "value").map((r) => r.id)).toEqual(["a", "m", "x"]);
  });
  it("larger datasets paginate without gaps or repeats; empty datasets are fine", () => {
    const big = pipelineRows(data({ quotes: Array.from({ length: 2345 }, (_, i) => quote({ id: String(i).padStart(5, "0"), customer_confirmed_cents: i % 7 })) }), NOW);
    const sorted = sortRows(big, "value", "desc"); const seen = new Set<string>(); let p = paginate(sorted, 1, 200);
    for (let i = 1; i <= p.pages; i++) { for (const r of paginate(sorted, i, 200).rows) { expect(seen.has(r.id)).toBe(false); seen.add(r.id); } }
    expect(seen.size).toBe(2345); expect(p.pages).toBe(12); expect(paginate(sorted, 999, 200).page).toBe(12);
    expect(paginate([], 1, 25)).toMatchObject({ total: 0, pages: 1, rows: [] }); expect(overviewOf([], [], NOW)).toMatchObject({ total: 0, open: 0, indicativePipelineCents: 0 });
    p = paginate(sorted, -3, 5000); expect(p.pageSize).toBe(200);
  });
});

describe("the operational model carries no commercial field", () => {
  it("a row is only workflow and selling-value data", () => {
    const row = pipelineRows(data({ quotes: [quote({ id: "9", customer_confirmed_cents: 100 })] }), NOW)[0];
    const json = JSON.stringify(row).toLowerCase();
    for (const bad of ["margin", "supplier", "costcents", "freight", "markup", "fx"]) expect(json).not.toContain(bad);
  });
});
