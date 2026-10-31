import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { DEMO_OWNER_EMAIL } from "@/lib/demo-mode/config";

// The REAL server actions (pre-approval price confirmation contact, customer change, approval, project gate) over the in-memory database. Only the session
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
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const acts = () => (db.rows("activity_log") as Array<Record<string, any>>); // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  process.env.VERCEL_ENV = "preview"; process.env.NEWQUIP_DEMO_MODE_ENABLED = "true"; process.env.NEWQUIP_DEMO_OWNER_EMAIL = DEMO_OWNER_EMAIL; process.env.ENCRYPTION_KEY = "k".repeat(40);
  jar.clear(); session = { userId: U.owner, orgId: NQ, email: DEMO_OWNER_EMAIL };
  db = new FakeDb(); db.deliveryApplied = true; db.approvalsApplied = true; db.rolesApplied = true; installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAIL[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: NQ, user_id: U.owner, role: "owner" }, { org_id: NQ, user_id: U.rep, role: "member" }, { org_id: NQ, user_id: U.est, role: "member" }, { org_id: NQ, user_id: U.mgr, role: "member" });
  const grant = (u: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${u}-${role}`, org_id: NQ, user_id: u, user_email: EMAIL[u], role, assigned_by_email: DEMO_OWNER_EMAIL, assigned_at: "t" });
  grant(U.rep, "REP"); grant(U.est, "ESTIMATOR"); grant(U.mgr, "MANAGER");
  db.rows("approval_settings").push({ org_id: NQ, roles_enforced: true }); // strict: only the explicit roles count for the three test users
  db.rows("newquip_quotes").push({ id: "q1", org_id: NQ, quote_ref: "NQ-Q-0100", revision: 1, customer_name: "Demo Customer", site_name: "Farm", quote_type: "project", state: "REP_DRAFT", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, created_by_email: EMAIL[U.rep], estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

const RAW = { ID: "cin7-s", Name: "Spark", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za" }, { Name: "Anton Hill", Email: "anton@sparkconsulting.co.za" }] };
const RAW2 = { ...RAW, ID: "cin7-w", Name: "Wynplaas", Contacts: [{ Name: "Sarie", Email: "sarie@wynplaas.co.za" }] };
const snaps = () => db.rows("newquip_quote_customers") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const latest = () => snaps().at(-1)!.snapshot as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const as = async (slot: string) => { const r = await demo.selectDemoIdentityAction(slot); expect(r.error).toBeUndefined(); };
const send = (c: Parameters<typeof grower.sendGrowerQuoteToEstimatorAction>[2]) => grower.sendGrowerQuoteToEstimatorAction("q1", total, c);

beforeEach(() => {
  Object.assign(quote(), { customer_name: "Spark" }); (quote().draft as Record<string, unknown>).customerName = "Spark";
  vi.mocked(readCin7Customer).mockReset().mockImplementation(async (_d, _o, n) => (n === "Wynplaas" ? RAW2 : RAW) as never);
  // Step 1 done: Spark selected (snapshot #1) and AJ Mbulo chosen as the quotation (delivery) contact (snapshot #2)
  const s1 = buildCustomerSnapshot(RAW, "t");
  snaps().push({ id: "n1", org_id: NQ, quote_id: "q1", seq: 1, cin7_customer_id: "cin7-s", snapshot: s1, snapshot_hash: "h1", captured_by_email: EMAIL[U.rep], reason: "Customer selected from Cin7", created_at: "t" });
  snaps().push({ id: "n2", org_id: NQ, quote_id: "q1", seq: 2, cin7_customer_id: "cin7-s", snapshot: withChosenContact(s1, { source: "CIN7_CONTACT", contactIndex: 0 }), snapshot_hash: "h2", captured_by_email: EMAIL[U.rep], reason: "Quotation contact set", created_at: "t" });
});

describe("pre-approval price confirmation contact", () => {
  it("defaults to the quotation contact from the latest snapshot: recorded with source, actor and amount; the delivery contact and the earlier snapshots are untouched", async () => {
    await as("rep");
    const r = await send({ source: "QUOTATION_CONTACT" });
    expect(r.error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total, customer_confirmed_by: "AJ Mbulo <testing@sparkconsulting.co.za>", handoff_by_email: EMAIL[U.rep] });
    expect(snaps().map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(latest().confirmationContact).toMatchObject({ source: "QUOTATION_CONTACT", name: "AJ Mbulo", email: "testing@sparkconsulting.co.za", origin: "Cin7 contact", customerName: "Spark", cin7CustomerId: "cin7-s", selectedBy: EMAIL[U.rep], amountCents: total });
    expect(latest().confirmationContact.selectedAt).toMatch(/^20/);
    expect(latest().chosenContact).toMatchObject({ name: "AJ Mbulo" }); // delivery contact independent
    expect(snaps()[0].snapshot.confirmationContact).toBeUndefined(); expect(snaps()[1].snapshot.confirmationContact).toBeUndefined(); // history preserved
    const a = acts().find((x) => x.action === "newquip.quote_sent_to_estimator")!;
    expect(a.detail).toMatchObject({ amountCents: total, confirmationContact: { name: "AJ Mbulo", email: "testing@sparkconsulting.co.za", source: "QUOTATION_CONTACT" }, deliveryContactUnchanged: "testing@sparkconsulting.co.za" });
    expect(JSON.stringify(a)).toContain(DEMO_OWNER_EMAIL); // the real owner behind the effective Demo identity
  });

  it("another existing Cin7 contact can confirm; the quotation (delivery) contact is NOT silently replaced", async () => {
    await as("rep");
    expect((await send({ source: "CIN7_CONTACT", contactIndex: 1 })).error).toBeUndefined();
    expect(latest().confirmationContact).toMatchObject({ source: "CIN7_CONTACT", name: "Anton Hill", email: "anton@sparkconsulting.co.za" });
    expect(latest().chosenContact).toMatchObject({ name: "AJ Mbulo", email: "testing@sparkconsulting.co.za" });
    expect(quote().customer_confirmed_by).toBe("Anton Hill <anton@sparkconsulting.co.za>");
    const view = (await customer.getQuoteCustomerAction("q1")).data!;
    expect(view.confirmationContact?.name).toBe("Anton Hill"); expect(view.snapshot!.chosenContact!.name).toBe("AJ Mbulo");
  });

  it("an alternative contact needs a name and a reason; it is recorded with who and when, and never touches Cin7", async () => {
    await as("rep");
    for (const bad of [{ name: "Piet Pompies", reason: "" }, { name: "Piet Pompies", reason: "abc" }, { name: "", reason: "owner was away" }, { name: "P", reason: "owner was away" }, { name: "Piet", reason: "owner was away", email: "not-an-email" }]) {
      expect((await send({ source: "ALTERNATIVE", ...bad })).ok).toBe(false);
    }
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null }); expect(snaps()).toHaveLength(2);
    expect((await send({ source: "ALTERNATIVE", name: "Piet Pompies", reason: "Owner was away; his foreman agreed" })).error).toBeUndefined();
    expect(latest().confirmationContact).toMatchObject({ source: "ALTERNATIVE", name: "Piet Pompies", email: null, reason: "Owner was away; his foreman agreed", selectedBy: EMAIL[U.rep], origin: "Alternative contact (not listed)" });
    expect(quote().customer_confirmed_by).toBe("Piet Pompies (alternative contact: Owner was away; his foreman agreed)");
    expect(latest().contacts).toHaveLength(2); // the Cin7 contact list is not extended
    expect(vi.mocked(readCin7Customer)).not.toHaveBeenCalled();
  });

  it("a contact index that is not on the customer, or a quotation contact that was never chosen, is refused", async () => {
    await as("rep");
    expect((await send({ source: "CIN7_CONTACT", contactIndex: 7 })).error).toMatch(/not on the Cin7 customer/);
    snaps().pop(); // no quotation contact chosen yet
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toMatch(/Choose the quotation contact/);
    snaps().length = 0; // no customer selected at all
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toMatch(/Select the Cin7 customer/);
    expect(quote().state).toBe("REP_DRAFT");
  });

  it("survives a refresh and reopening: the saved confirmation is read back from the database", async () => {
    await as("rep"); await send({ source: "CIN7_CONTACT", contactIndex: 1 });
    expect((await customer.getQuoteCustomerAction("q1")).data!.confirmationContact).toMatchObject({ name: "Anton Hill", amountCents: total });
    vi.mocked(readCin7Customer).mockResolvedValue({ ...RAW, TaxNumber: "123" } as never);
    // the quote is in estimator review, so a Rep-side refresh is refused; the saved record is simply unchanged
    expect((await customer.getQuoteCustomerAction("q1")).data!.confirmationContact?.email).toBe("anton@sparkconsulting.co.za");
  });

  it("a duplicate submission records ONE handoff: the second is refused and adds no snapshot or audit row", async () => {
    await as("rep");
    const [a, b] = await Promise.all([send({ source: "QUOTATION_CONTACT" }), send({ source: "QUOTATION_CONTACT" })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(snaps().filter((x) => x.snapshot.confirmationContact)).toHaveLength(1);
    expect(acts().filter((x) => x.action === "newquip.quote_sent_to_estimator")).toHaveLength(1);
    expect((await send({ source: "QUOTATION_CONTACT" })).ok).toBe(false);
    expect(snaps()).toHaveLength(3);
  });

  it("changing the customer invalidates the confirmation and its contact: the quote returns to the Rep and must be confirmed again", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    const ch = await customer.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(ch.error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, estimator_signoff_hash: null });
    expect(latest().cin7CustomerId).toBe("cin7-w"); expect(latest().confirmationContact ?? null).toBeNull();
    expect((await customer.getQuoteCustomerAction("q1")).data!.confirmationContact).toBeNull();
    expect(snaps().some((x) => x.snapshot.confirmationContact?.name === "AJ Mbulo")).toBe(true); // the earlier record is kept in history
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toMatch(/Choose the quotation contact/); // the old contact is not carried over
    expect((await send({ source: "CIN7_CONTACT", contactIndex: 0 })).error).toBeUndefined();
    expect(latest().confirmationContact).toMatchObject({ name: "Sarie", cin7CustomerId: "cin7-w" });
  });

  it("a customer change after the estimator signed off also withdraws the sign-off", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    expect(quote().estimator_signoff_hash).toBeTruthy();
    await as("rep"); expect((await customer.selectQuoteCustomerAction("q1", "Wynplaas", true)).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null, customer_confirmed_cents: null });
  });

  it("changing the commercial amount requires reconfirmation: the Manager cannot approve a total the customer did not confirm", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    await as("estimator");
    const d = structuredClone(quote().draft) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    d.estimator.charges.delivery += 100_000;
    expect((await grower.saveGrowerDraftAction("q1", d as never)).error).toBeUndefined();
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    await as("manager");
    expect((await grower.approveGrowerQuoteAction("q1")).error).toMatch(/total changed since the customer confirmed/);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    // the Rep must reconfirm: the Manager returns it -> new revision with no confirmation -> confirm again at the new amount
    expect((await grower.returnGrowerQuoteToRepAction("q1", "amount changed")).error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null, revision: 2 });
    expect((await customer.getQuoteCustomerAction("q1")).data!.confirmationContact).toBeNull(); // the old record is not presented as current
  });

  it("role and organisation isolation: only a Rep records it; another organisation's snapshot is never used", async () => {
    await as("estimator");
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toMatch(/Only a Rep/);
    await as("manager");
    expect((await send({ source: "QUOTATION_CONTACT" })).ok).toBe(false);
    expect(quote().state).toBe("REP_DRAFT"); expect(snaps()).toHaveLength(2);
    // snapshots of the same quote id belonging to another organisation are invisible
    for (const s of snaps()) s.org_id = "org-b";
    await as("rep");
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toMatch(/Select the Cin7 customer/);
    expect((await send({ source: "CIN7_CONTACT", contactIndex: 1 })).error).toMatch(/Select the Cin7 customer/);
    expect(quote().state).toBe("REP_DRAFT");
    expect((await grower.sendGrowerQuoteToEstimatorAction("not-mine", total, { source: "ALTERNATIVE", name: "Piet", reason: "no snapshot here" })).ok).toBe(false);
  });

  it("an approved quotation cannot be changed: no new confirmation, no contact change; the frozen baseline records the contact", async () => {
    await as("rep"); await send({ source: "CIN7_CONTACT", contactIndex: 1 });
    await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    await as("manager"); expect((await grower.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().accepted_baseline.approvals.customerConfirmedBy).toBe("Anton Hill <anton@sparkconsulting.co.za>");
    const n = snaps().length;
    await as("rep");
    expect((await send({ source: "QUOTATION_CONTACT" })).ok).toBe(false);
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).error).toMatch(/immutable/);
    expect((await customer.selectQuoteCustomerAction("q1", "Wynplaas", true)).error).toMatch(/immutable/);
    expect(snaps()).toHaveLength(n);
  });

  it("the pre-approval confirmation NEVER satisfies the customer-acceptance gate: an approved, confirmed quotation still cannot create a Project", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    await as("estimator"); await grower.signOffGrowerQuoteAction("q1");
    await as("manager"); await grower.approveGrowerQuoteAction("q1");
    Object.assign(quote(), { requires_customer_acceptance: true });
    expect(quote().customer_confirmed_cents).toBe(total);
    const r = await grower.createProjectFromGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(r.error).toMatch(/customer must accept|has not accepted/i);
    expect(db.rows("projects")).toHaveLength(0);
  });
});
