import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { DEMO_OWNER_EMAIL } from "@/lib/demo-mode/config";

// D5: every path that sends a quotation back stores WHY (reason, actor, role, time, destination) and QuoteView.returnInfo reads it back. The REAL server actions over the in-memory database. Only the session
// (the one authenticated OWNER), the cookie jar and the cost-visible evaluation context are replaced.
let db: FakeDb;
const jar = new Map<string, string>();
let session: { userId: string; orgId: string; email: string | null } = { userId: "u-owner", orgId: "e1aea782-d095-47ad-90fb-4fa65c9bf855", email: DEMO_OWNER_EMAIL };
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n) } : undefined), set: (n: string, v: string) => { jar.set(n, v); }, delete: (n: string) => { jar.delete(n); } }) }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: async () => session }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: async () => undefined }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ readLatestCostEntries: async () => ({}) }));
vi.mock("@/lib/newquip-customers/cin7-customer-read", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-customers/cin7-customer-read")>()), readCin7Customer: vi.fn() }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as demo from "@/app/demo-mode/actions";
import * as grower from "@/app/newquip-grower/actions";
import * as customer from "@/app/newquip-grower/customer-actions";
import { buildCustomerSnapshot, withChosenContact } from "@/lib/newquip-quotes/customer-snapshot";
import { readCin7Customer } from "@/lib/newquip-customers/cin7-customer-read";

const NQ = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const U = { owner: "u-owner", rep: "u-rep", est: "u-est", mgr: "u-mgr" };
const EMAIL: Record<string, string> = { "u-owner": DEMO_OWNER_EMAIL, "u-rep": "rep@sparkconsulting.co.za", "u-est": "estimator@sparkconsulting.co.za", "u-mgr": "manager@sparkconsulting.co.za" };
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const acts = () => (db.rows("activity_log") as Array<Record<string, any>>); // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  process.env.VERCEL_ENV = "preview"; process.env.NEWQUIP_DEMO_MODE_ENABLED = "true"; process.env.NEWQUIP_DEMO_OWNER_EMAIL = DEMO_OWNER_EMAIL; process.env.ENCRYPTION_KEY = "k".repeat(40);
  jar.clear(); session = { userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL };
  db = new FakeDb();
  seedGoldenCatalogue(db as never, NQ); db.deliveryApplied = true; db.approvalsApplied = true; db.rolesApplied = true; installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAIL[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: NQ, user_id: U.owner, role: "owner" }, { org_id: NQ, user_id: U.rep, role: "member" }, { org_id: NQ, user_id: U.est, role: "member" }, { org_id: NQ, user_id: U.mgr, role: "member" });
  const grant = (u: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${u}-${role}`, org_id: NQ, user_id: u, user_email: EMAIL[u], role, assigned_by_email: DEMO_OWNER_EMAIL, assigned_at: "t" });
  grant(U.rep, "REP"); grant(U.est, "ESTIMATOR"); grant(U.mgr, "MANAGER");
  db.rows("approval_settings").push({ org_id: NQ, roles_enforced: true }); // strict: only the explicit roles count for the three test users
  db.rows("newquip_quotes").push({ id: "q1", org_id: NQ, quote_ref: "NQ-Q-0100", revision: 1, customer_name: "Demo Customer", site_name: "Farm", quote_type: "project", state: "REP_DRAFT", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, created_by_email: EMAIL[U.rep], estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

const RAW = { ID: "cin7-s", Name: "Spark", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za" }] };
const RAW2 = { ...RAW, ID: "cin7-w", Name: "Wynplaas", Contacts: [{ Name: "Sarie", Email: "sarie@wynplaas.co.za" }] };
const snaps = () => db.rows("newquip_quote_customers") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const as = async (slot: string) => { const r = await demo.selectDemoIdentityAction(slot); expect(r.error).toBeUndefined(); };
const send = () => grower.sendGrowerQuoteToEstimatorAction("q1", total, { source: "QUOTATION_CONTACT" });
const info = async (slot: string) => { await as(slot); const r = await grower.getGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); return r.data!.returnInfo; };
const records = () => acts().filter((x) => x.action === "newquip.quote_return_recorded");

beforeEach(() => {
  Object.assign(quote(), { customer_name: "Spark" }); (quote().draft as Record<string, unknown>).customerName = "Spark";
  vi.mocked(readCin7Customer).mockReset().mockImplementation(async (_d, _o, n) => (n === "Wynplaas" ? RAW2 : RAW) as never);
  const s1 = buildCustomerSnapshot(RAW, "t");
  snaps().push({ id: "n1", org_id: NQ, quote_id: "q1", seq: 1, cin7_customer_id: "cin7-s", snapshot: s1, snapshot_hash: "h1", captured_by_email: EMAIL[U.rep], reason: "Customer selected from Cin7", created_at: "t" });
  snaps().push({ id: "n2", org_id: NQ, quote_id: "q1", seq: 2, cin7_customer_id: "cin7-s", snapshot: withChosenContact(s1, { source: "CIN7_CONTACT", contactIndex: 0 }), snapshot_hash: "h2", captured_by_email: EMAIL[U.rep], reason: "Quotation contact set", created_at: "t" });
});

describe("D5: a quotation returned to the Rep carries its reason", () => {
  it("nothing to show on a fresh draft or while the quotation is with the Estimator", async () => {
    expect(await info("rep")).toBeNull();
    await as("rep"); await send();
    expect(await info("rep")).toBeNull();
    expect(await info("estimator")).toBeNull();
  });

  it("STAGED Estimator return: reason, actor, role, time, destination are stored and read back by Rep, Estimator and Manager alike", async () => {
    await as("rep"); await send();
    await as("estimator");
    expect((await grower.returnGrowerQuoteToRepAction("q1", "Gate width is wrong")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", revision: 2 });
    const expected = { kind: "RETURN", reason: "Gate width is wrong", byEmail: EMAIL[U.est], byRole: "estimator", destination: "REP", source: "RECORD" };
    for (const slot of ["rep", "estimator", "manager"]) expect(await info(slot)).toMatchObject(expected);
    expect((await info("rep"))!.at).toMatch(/^20\d\d-\d\d-\d\dT/);
    // the approval history carries it too (the fallback source)
    expect(db.rows("approval_requests").find((r) => r.status === "RETURNED")).toMatchObject({ decision_reason: "Gate width is wrong", decided_by_email: EMAIL[U.est] });
    // exactly one append-only record, bound to the revision it produced, never an update or delete of the log
    expect(records()).toHaveLength(1);
    expect(records()[0].detail).toMatchObject({ quoteId: "q1", kind: "RETURN", toRevision: 2, fromRevision: 1, fromState: "ESTIMATOR_REVIEW", byRole: "estimator" });
    expect(db.writes.filter((w) => w.table === "activity_log" && w.op !== "insert")).toEqual([]);
  });

  it("STAGED Manager return to the Rep records the Manager as actor and role", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    await as("manager");
    expect((await grower.returnGrowerQuoteToRepAction("q1", "Customer wants a smaller site")).error).toBeUndefined();
    expect(await info("rep")).toMatchObject({ kind: "RETURN", reason: "Customer wants a smaller site", byEmail: EMAIL[U.mgr], byRole: "manager", destination: "REP" });
  });

  it("STAGED Manager return to the ESTIMATOR: reason + manager kept; the Estimator sees it until they sign off again", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    await as("manager");
    expect((await grower.returnGrowerQuoteToEstimatorAction("q1", "Re-check the supplier price")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", revision: 1, estimator_signoff_hash: null });
    expect(await info("estimator")).toMatchObject({ kind: "RETURN", reason: "Re-check the supplier price", byEmail: EMAIL[U.mgr], byRole: "manager", destination: "ESTIMATOR", source: "RECORD" });
    expect(records().at(-1)!.detail).toMatchObject({ kind: "RETURN", destination: "ESTIMATOR", toRevision: 1, fromRevision: 1, byRole: "manager" });
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(await info("estimator")).toBeNull();
  });

  it("a later return replaces an earlier one, and re-sending to the Estimator clears the banner", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "First problem");
    await as("rep"); await send(); expect(await info("rep")).toBeNull();
    await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "Second problem");
    expect(await info("rep")).toMatchObject({ reason: "Second problem" });
    expect(quote().revision).toBe(3);
    expect(records()).toHaveLength(2);
  });

  it("customer change in estimator review: the quotation returns to the Rep with kind CUSTOMER_CHANGED, the Rep as actor and the previous confirmed total", async () => {
    await as("rep"); await send();
    expect((await customer.selectQuoteCustomerAction("q1", "Wynplaas", true)).error).toBeUndefined();
    expect(await info("rep")).toMatchObject({ kind: "CUSTOMER_CHANGED", byEmail: EMAIL[U.rep], byRole: "rep", destination: "REP", previousCents: total, source: "RECORD" });
    expect((await info("rep"))!.reason).toMatch(/customer .* changed/i);
    expect(records()[0].detail).toMatchObject({ toRevision: 2 });
  });

  it("clearing the customer in estimator review is also recorded", async () => {
    await as("rep"); await send();
    expect((await customer.clearQuoteCustomerAction("q1", true)).error).toBeUndefined();
    expect(await info("rep")).toMatchObject({ kind: "CUSTOMER_CHANGED", destination: "REP" });
  });

  it("a customer change on a plain Rep draft returns nothing, so it records nothing", async () => {
    await as("rep");
    expect((await customer.selectQuoteCustomerAction("q1", "Wynplaas", true)).error).toBeUndefined();
    expect(records()).toEqual([]); expect(await info("rep")).toBeNull();
  });

  it("S1b amount-change withdrawal (its existing audit row) is read back with previous -> new total", async () => {
    await as("rep"); await send(); await as("estimator");
    await grower.returnGrowerQuoteToRepAction("q1", "placeholder");
    db.rows("activity_log").length = 0; db.rows("approval_requests").length = 0; db.rows("approval_events").length = 0; // only the S1b row explains the state
    db.rows("activity_log").push({ id: "a1", org_id: NQ, actor_email: DEMO_OWNER_EMAIL, action: "newquip.quote_confirmation_invalidated", summary: "x", created_at: "2026-11-03T09:00:00.000Z",
      detail: { quoteId: "q1", reason: "AMOUNT_CHANGED", previousCents: total, newCents: total + 5_000_00, confirmationCleared: true, signoffCleared: false, returnedToRep: true, effectiveUser: EMAIL[U.est] } });
    expect(await info("rep")).toMatchObject({ kind: "AMOUNT_CHANGED", previousCents: total, newCents: total + 500_000, byEmail: EMAIL[U.est], destination: "REP", source: "AUDIT" });
  });

  it("returns made before the record existed fall back to the RETURNED approval request", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "Old style return");
    db.rows("activity_log").length = 0;
    expect(await info("rep")).toMatchObject({ reason: "Old style return", byEmail: EMAIL[U.est], destination: "REP", source: "APPROVAL" });
  });

  it("the Rep-visible payload carries no cost or margin data", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "Gate width is wrong");
    const ri = await info("rep");
    expect(Object.keys(ri!).sort()).toEqual(["at", "byEmail", "byRole", "destination", "kind", "reason", "source"]);
    expect(JSON.stringify(ri)).not.toMatch(/cost|margin|landed|gp/i);
  });

  it("records of another quotation in the same organisation are never shown", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "Mine");
    db.rows("activity_log").push({ id: "other", org_id: NQ, actor_email: "x", action: "newquip.quote_return_recorded", summary: "x", created_at: "2099-01-01T00:00:00.000Z",
      detail: { quoteId: "q2", kind: "RETURN", reason: "Somebody else's", byEmail: "z@nq", byRole: "manager", destination: "REP", fromState: "ESTIMATOR_REVIEW", fromRevision: 1, toRevision: 2 } });
    expect(await info("rep")).toMatchObject({ reason: "Mine" });
  });

  it("another organisation's quotation and records are never read", async () => {
    await as("rep"); await send(); await as("estimator"); await grower.returnGrowerQuoteToRepAction("q1", "Gate width is wrong");
    for (const r of [...db.rows("activity_log"), ...db.rows("approval_requests")]) r.org_id = "org-b";
    expect(await info("rep")).toBeNull();
  });

  it("the reason is kept BEFORE the state changes: when it cannot be written, nothing changes", async () => {
    await as("rep"); await send(); await as("estimator");
    const real = db.from.bind(db);
    (db as any).from = (t: string) => (t === "activity_log" ? { insert: async () => ({ error: { message: "disk full" } }) } : real(t)); // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await grower.returnGrowerQuoteToRepAction("q1", "Gate width is wrong");
    (db as any).from = real; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.ok).toBe(false); expect(r.error).toMatch(/reason could not be recorded/);
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", revision: 1 });
  });

  it("a wrong-role return is refused and records nothing", async () => {
    await as("rep"); await send();
    expect((await grower.returnGrowerQuoteToRepAction("q1", "I just want to")).ok).toBe(false);
    expect(records()).toEqual([]); expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
});

describe("D5: LEGACY paths (before the roles / staged approvals migration) store the reason too", () => {
  it("approvals not installed: an Estimator return is recorded and read back", async () => {
    db.approvalsApplied = false; db.rolesApplied = false;
    await as("rep"); expect((await send()).error).toBeUndefined();
    await as("estimator");
    expect((await grower.returnGrowerQuoteToRepAction("q1", "Legacy: gate width is wrong")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", revision: 2 });
    expect(await info("rep")).toMatchObject({ kind: "RETURN", reason: "Legacy: gate width is wrong", byEmail: EMAIL[U.est], byRole: "estimator", destination: "REP", source: "RECORD" });
  });

  it("approvals installed but not staged: the Estimator pull-back is recorded (the withdrawn request carries no RETURN decision, the record does)", async () => {
    db.rolesApplied = false;
    await as("rep"); expect((await send()).error).toBeUndefined();
    await as("estimator");
    expect((await grower.returnGrowerQuoteToRepAction("q1", "Legacy with approvals")).error).toBeUndefined();
    expect(await info("rep")).toMatchObject({ reason: "Legacy with approvals", byEmail: EMAIL[U.est], byRole: "estimator", source: "RECORD" });
    expect(db.rows("approval_requests").filter((r) => r.status === "RETURNED")).toEqual([]);
  });
});
