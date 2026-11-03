import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
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

import { confirmationStatus } from "@/lib/newquip-quotes/confirmation-status";
import { invalidateConfirmation } from "@/lib/newquip-quotes/quote-store";
import { assertConfirmationCurrent } from "@/lib/newquip-quotes/confirmation-guard";

const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };

describe("customer identity: the Cin7 snapshot is the only source of the customer name", () => {
  it("a Rep cannot overwrite customer_name / draft.customerName through saveGrowerDraftAction once a snapshot exists (silently restored from the snapshot)", async () => {
    await as("rep");
    const typed = { ...structuredClone(quote().draft), customerName: "Typed Name Ltd" } as typeof draft;
    const r = await grower.saveGrowerDraftAction("q1", typed);
    expect(r.error).toBeUndefined();
    expect(quote().customer_name).toBe("Spark");
    expect((quote().draft as { customerName: string }).customerName).toBe("Spark");
    expect(r.data!.quote.customer_name).toBe("Spark");
    expect(r.data!.quote.draft.customerName).toBe("Spark");
  });
  it("a cleared customer (no current snapshot) is not authoritative: the typed name is stored but SUBMIT is refused", async () => {
    await as("rep");
    const c = await customer.clearQuoteCustomerAction("q1", true); expect(c.error).toBeUndefined();
    const typed = { ...structuredClone(quote().draft), customerName: "Typed Name Ltd" } as typeof draft;
    await grower.saveGrowerDraftAction("q1", typed);
    const r = await send({ source: "ALTERNATIVE", name: "Joe", reason: "typed customer" });
    expect(r.error).toMatch(/Select the Cin7 customer/);
    expect(quote().state).toBe("REP_DRAFT"); expect(quote().customer_confirmed_cents).toBeNull();
  });
  it("NEW quotation: submit without a Cin7 snapshot is refused even with a complete typed name and an alternative contact; nothing is recorded", async () => {
    snaps().length = 0; await as("rep");
    const r = await send({ source: "ALTERNATIVE", name: "Joe", reason: "typed customer" });
    expect(r.error).toMatch(/Select the Cin7 customer and quotation contact/);
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null, customer_confirmed_by: null });
  });
  it("LEGACY compatibility: a legacy REP_DRAFT with a typed name selects the SAME customer from Cin7 (no confirmation to withdraw) and can then be submitted; legacy in-review quotations are untouched", async () => {
    const legacySnaps = snaps().splice(0); await as("rep");
    const sel = await customer.selectQuoteCustomerAction("q1", "Spark");
    expect(sel.ok).toBe(true); expect(sel.data!.effect).toEqual({ returnedToRep: false, signoffCleared: false, confirmationCleared: false });
    expect(legacySnaps.length).toBe(2);
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 })).ok).toBe(true);
    expect((await send({ source: "QUOTATION_CONTACT" })).error).toBeUndefined();
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    // a legacy quotation ALREADY in estimator review (typed name, never had a snapshot) still reads and is editable by the estimator
    snaps().length = 0; await as("estimator");
    const g = await grower.getGrowerQuoteAction("q1"); expect(g.ok).toBe(true);
    const s = await grower.saveGrowerDraftAction("q1", { ...structuredClone(quote().draft), customerName: "Spark" } as typeof draft);
    expect(s.error).toBeUndefined();
  });
});

describe("confirmation invalidation on a contact change", () => {
  const confirm = async () => { await as("rep"); const r = await send({ source: "QUOTATION_CONTACT" }); expect(r.error).toBeUndefined(); };
  const signOff = () => Object.assign(quote(), { estimator_signoff_hash: quote().draft_hash, estimator_signoff_by_email: EMAIL[U.est], estimator_signoff_at: "t" });
  const countBefore = () => ({ snaps: snaps().length, acts: acts().length });

  it("changing the quotation contact in estimator review is refused until the Rep confirms; the view tells the UI beforehand; a refusal changes nothing", async () => {
    await confirm();
    const v = await customer.getQuoteCustomerAction("q1");
    expect(v.data).toMatchObject({ confirmationRecorded: true, contactChangeWithdrawsConfirmation: true, changeReturnsToRep: true });
    const before = countBefore();
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 });
    expect(r.error).toMatch(/withdraws the customer's price confirmation.*returns the quotation to you/);
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
    expect(countBefore()).toEqual(before);
  });
  it("a confirmed contact change clears confirmation + sign-off, returns the in-review quote to the Rep as a new revision, audits it, and keeps all history", async () => {
    await confirm(); signOff();
    const nSnaps = snaps().length; const rev = quote().revision;
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 }, true);
    expect(r.error).toBeUndefined();
    expect(r.data!.effect).toEqual({ confirmationCleared: true, signoffCleared: true, returnedToRep: true });
    expect(quote()).toMatchObject({ state: "REP_DRAFT", revision: rev + 1, customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null });
    expect(latest().chosenContact).toMatchObject({ name: "Anton Hill" }); expect(latest().confirmationContact).toBeNull();
    expect(snaps().length).toBe(nSnaps + 1);                                            // appended, nothing deleted
    expect(snaps().filter((x) => x.snapshot.confirmationContact?.name === "AJ Mbulo")).toHaveLength(1); // the earlier confirmation record survives in history
    const inv = acts().find((x) => x.action === "newquip.quote_confirmation_invalidated")!;
    expect(inv.detail).toMatchObject({ quoteId: "q1", reason: "CONTACT_CHANGED", confirmationCleared: true, returnedToRep: true, previousConfirmationContact: { name: "AJ Mbulo", amountCents: total } });
    expect(acts().some((x) => x.action === "newquip.quote_contact_chosen")).toBe(true);
    expect(r.data!.confirmationRecorded).toBe(false);
  });
  it("re-choosing the SAME contact is a no-op: the confirmation stands", async () => {
    await confirm();
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(r.error).toBeUndefined(); expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
  });
  it("a confirmation by an ALTERNATIVE contact is independent of the quotation contact: changing the delivery contact does not withdraw it", async () => {
    await as("rep");
    expect((await send({ source: "ALTERNATIVE", name: "Farmer Joe", reason: "owner confirmed by phone" })).error).toBeUndefined();
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 });
    expect(r.error).toBeUndefined(); expect(r.data!.effect).toEqual({ confirmationCleared: false, signoffCleared: false, returnedToRep: false });
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
  });
  it("a refresh from Cin7 that removes the confirmed contact withdraws the confirmation (preview says so first)", async () => {
    await confirm();
    vi.mocked(readCin7Customer).mockImplementation(async () => ({ ...RAW, Contacts: [{ Name: "Anton Hill", Email: "anton@sparkconsulting.co.za" }] }) as never);
    const p = await customer.refreshQuoteCustomerAction("q1", false);
    expect(p.data!.preview.withdrawsConfirmation).toBe(true); expect(quote().customer_confirmed_cents).toBe(total);
    const r = await customer.refreshQuoteCustomerAction("q1", true);
    expect(r.data!.view.effect).toMatchObject({ confirmationCleared: true, returnedToRep: true });
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null });
  });
  it("replacing the customer still withdraws everything (existing behaviour) and reports the facts", async () => {
    await confirm(); signOff();
    const r = await customer.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(r.data!.effect).toEqual({ confirmationCleared: true, signoffCleared: true, returnedToRep: true });
    expect(quote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null });
  });
  it("invalidateConfirmation with nothing recorded is a no-op and never touches a sign-off-free REP_DRAFT", async () => {
    const rev = quote().revision;
    expect(await invalidateConfirmation(db as never, NQ, "q1")).toEqual({ returnedToRep: false, signoffCleared: false, confirmationCleared: false });
    expect(quote().revision).toBe(rev);
  });
  it("assertConfirmationCurrent: valid passes; a stale contact or amount is refused (the hook sign-off / approval call)", async () => {
    await confirm();
    await expect(assertConfirmationCurrent(db as never, NQ, "q1", ctx)).resolves.toBe("valid");
    Object.assign(quote(), { customer_confirmed_cents: total + 100 });
    await expect(assertConfirmationCurrent(db as never, NQ, "q1", ctx)).rejects.toThrow(/total changed since the customer confirmed/);
    Object.assign(quote(), { customer_confirmed_cents: total });
    snaps().push({ ...snaps().at(-1)!, id: "n9", seq: 9, snapshot: { ...latest(), chosenContact: { source: "ENTERED", name: "Someone Else", email: "x@y.co.za", phone: null } } });
    await expect(assertConfirmationCurrent(db as never, NQ, "q1", ctx)).rejects.toThrow(/contact who confirmed/);
  });
  it("the Manager approval action refuses a stale-contact confirmation before any approval decision", async () => {
    await confirm(); signOff();
    snaps().push({ ...snaps().at(-1)!, id: "n9", seq: 9, snapshot: { ...latest(), chosenContact: { source: "ENTERED", name: "Someone Else", email: "x@y.co.za", phone: null } } });
    await as("manager");
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.error).toMatch(/contact who confirmed/);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
});

describe("confirmationStatus (pure)", () => {
  const snap = (over: Record<string, unknown> = {}) => ({ ...buildCustomerSnapshot(RAW, "t"), chosenContact: { source: "CIN7_CONTACT", name: "AJ Mbulo", email: "testing@sparkconsulting.co.za", phone: null }, confirmationContact: { source: "QUOTATION_CONTACT", name: "AJ Mbulo", email: "testing@sparkconsulting.co.za", cin7CustomerId: "cin7-s" }, ...over }) as never;
  const q = (c: number | null) => ({ customer_confirmed_cents: c, customer_confirmed_by: c == null ? null : "x" });
  it("none / valid / amount_changed / contact_changed", () => {
    expect(confirmationStatus(q(null), 100)).toBe("none");
    expect(confirmationStatus(q(100), 100, snap())).toBe("valid");
    expect(confirmationStatus(q(100), 100)).toBe("valid");                                 // no snapshot to contradict it
    expect(confirmationStatus(q(100), 101, snap())).toBe("amount_changed");
    expect(confirmationStatus(q(100), null, snap())).toBe("amount_changed");                // unknown total fails closed
    expect(confirmationStatus(q(100), 100, snap({ chosenContact: { source: "ENTERED", name: "Other", email: "o@x.co", phone: null } }))).toBe("contact_changed");
    expect(confirmationStatus(q(100), 100, snap({ chosenContact: null }))).toBe("contact_changed");
  });
  it("contact comparison normalises case and whitespace; ALTERNATIVE is independent; a different Cin7 customer breaks it", () => {
    expect(confirmationStatus(q(100), 100, snap({ chosenContact: { source: "ENTERED", name: " aj mbulo ", email: "TESTING@sparkconsulting.co.za", phone: null } }))).toBe("valid");
    const alt = { source: "ALTERNATIVE", name: "Joe", email: null, cin7CustomerId: "cin7-s" };
    expect(confirmationStatus(q(100), 100, snap({ confirmationContact: alt, chosenContact: null }))).toBe("valid");
    expect(confirmationStatus(q(100), 100, snap({ confirmationContact: { ...alt, cin7CustomerId: "cin7-other" } }))).toBe("contact_changed");
    expect(confirmationStatus(q(100), 100, snap({ confirmationContact: { source: "CIN7_CONTACT", name: "Anton Hill", email: "ANTON@sparkconsulting.co.za", cin7CustomerId: "cin7-s" } }))).toBe("valid");
    expect(confirmationStatus(q(100), 100, snap({ confirmationContact: { source: "CIN7_CONTACT", name: "Gone", email: "g@x.co", cin7CustomerId: "cin7-s" } }))).toBe("contact_changed");
  });
});
