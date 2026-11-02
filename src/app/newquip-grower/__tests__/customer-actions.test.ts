import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { resolveActing } from "@/lib/demo-mode/context";

// The REAL customer actions over an in-memory database; only the session, Demo Mode resolution and the Cin7 READ are replaced.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn(async () => ({ orgId: "org-a" })) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(async (_d: unknown, _o: string, _u: string, admin: boolean) => new Set(admin ? ["REP", "ESTIMATOR", "MANAGER"] : ["REP", "ESTIMATOR"])), canSeeCosts: vi.fn(async () => false) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
vi.mock("@/lib/newquip-customers/cin7-customer-read", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-customers/cin7-customer-read")>()), readCin7Customer: vi.fn() }));
import { readCin7Customer } from "@/lib/newquip-customers/cin7-customer-read";
import * as actions from "../customer-actions";
import { logActivity } from "@/lib/activity-log";
import { latestSnapshot } from "@/lib/newquip-quotes/customer-store";

const RAW = { ID: "cin7-1", Name: "Boerdery", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.co.za" }] };
const quote = (over: Record<string, unknown> = {}) => { const q = { id: "q1", org_id: "org-a", quote_ref: "NQ-Q-0001", revision: 1, state: "REP_DRAFT", draft: {}, ...over }; db.rows("newquip_quotes").push(q); return q; };
const as = (email: string, admin = false) => {
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-a", userId: "u1", email } as never);
  vi.mocked(resolveActing).mockResolvedValue({ orgId: "org-a", userId: "u1", email, tier: null, demo: null } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("no"); return undefined as never; });
};
beforeEach(() => { db = new FakeDb(); db.deliveryApplied = true; vi.mocked(readCin7Customer).mockReset().mockResolvedValue(RAW); as("rep@x.co"); });

describe("customer selection and snapshot", () => {
  it("selects a Cin7 customer by exact name, stores the Cin7 ID snapshot, then records the Rep's contact choice with history", async () => {
    quote();
    const r = await actions.selectQuoteCustomerAction("q1", "Boerdery");
    expect(r.ok).toBe(true);
    expect(r.data!.snapshot!.cin7CustomerId).toBe("cin7-1");
    expect(r.data!.issues).toContain("Choose the quotation contact and delivery email.");
    const c = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(c.data!.issues).toEqual([]);
    expect(c.data!.snapshot!.chosenContact).toMatchObject({ name: "Piet", email: "piet@boerdery.co.za" });
    expect(db.rows("newquip_quote_customers").map((x) => x.seq)).toEqual([1, 2]);
    expect(c.data!.history.map((h) => h.seq)).toEqual([1, 2]);
  });
  it("a customer that is not in Cin7 is refused; nothing is stored", async () => {
    quote(); vi.mocked(readCin7Customer).mockResolvedValue(null);
    expect((await actions.selectQuoteCustomerAction("q1", "Nobody")).error).toMatch(/not found in Cin7/);
    expect(db.rows("newquip_quote_customers")).toHaveLength(0);
  });
  it("organisation isolation: another organisation's quotation is 'not found' and gets no snapshot", async () => {
    quote({ org_id: "org-b" });
    expect((await actions.selectQuoteCustomerAction("q1", "Boerdery")).error).toBe("Quote not found.");
    expect((await actions.getQuoteCustomerAction("q1")).error).toBe("Quote not found.");
    expect(db.rows("newquip_quote_customers")).toHaveLength(0);
    expect(vi.mocked(readCin7Customer)).not.toHaveBeenCalled();
  });
  it("the search follows the REAL schema: customer name / trading name from `customers`, contact name / email from `customer_contacts`, scoped to the caller's organisation", async () => {
    db.rows("customers").push(
      { org_id: "org-a", name: "Boerdery A", display_name: "Boerdery", currency: "ZAR" },
      { org_id: "org-a", name: "Karoo Farm", display_name: null, currency: null },
      { org_id: "org-a", name: "No Contact Farm", display_name: null, currency: "ZAR" },
      { org_id: "org-b", name: "Boerdery B", display_name: null, currency: "ZAR" },
    );
    db.rows("customer_contacts").push(
      { id: "k1", org_id: "org-a", name: "Boerdery A", contact_name: "Anna", email: "anna@a.example", phone: null, mobile_phone: "082 1", contact_default: false },
      { id: "k2", org_id: "org-a", name: "Boerdery A", contact_name: "Piet", email: "piet@a.example", phone: "021 5", mobile_phone: null, contact_default: true },
      { id: "k3", org_id: "org-a", name: "Karoo Farm", contact_name: "Sarie Marais", email: "sarie@karoo.example", phone: null, mobile_phone: null, contact_default: true },
      { id: "k4", org_id: "org-b", name: "Boerdery B", contact_name: "Piet", email: "piet@b.example", phone: null, mobile_phone: null, contact_default: true },
    );
    const byName = (await actions.searchQuoteCustomersForQuoteAction("boerdery")).data!;
    expect(byName.map((h) => h.name)).toEqual(["Boerdery A"]);                                  // org B's customer never appears
    expect(byName[0]).toMatchObject({ tradingName: "Boerdery", contactName: "Piet", email: "piet@a.example", phone: "021 5", currency: "ZAR" }); // the default contact
    const byContact = (await actions.searchQuoteCustomersForQuoteAction("sarie")).data!;
    expect(byContact).toEqual([{ name: "Karoo Farm", tradingName: null, contactName: "Sarie Marais", email: "sarie@karoo.example", phone: null, currency: null }]);
    const byEmail = (await actions.searchQuoteCustomersForQuoteAction("anna@a")).data!;
    expect(byEmail.map((h) => h.name)).toEqual(["Boerdery A"]);
    expect(byEmail[0]).toMatchObject({ contactName: "Anna", email: "anna@a.example", phone: "082 1" }); // the contact that matched is the one shown; mobile used when no phone
    expect((await actions.searchQuoteCustomersForQuoteAction("piet@b")).data).toEqual([]);     // another organisation's contact is invisible
    expect((await actions.searchQuoteCustomersForQuoteAction("x")).data).toEqual([]);
  });
  it("customer names are only unique PER organisation: another organisation's contact for a customer with the SAME name never leaks into the results", async () => {
    db.rows("customers").push({ org_id: "org-a", name: "Karoo Farm", display_name: null, currency: "ZAR" }, { org_id: "org-b", name: "Karoo Farm", display_name: null, currency: "ZAR" });
    db.rows("customer_contacts").push(
      { id: "x1", org_id: "org-b", name: "Karoo Farm", contact_name: "Leak Person", email: "leak@b.example", phone: "000", mobile_phone: null, contact_default: true },
      { id: "x2", org_id: "org-a", name: "Karoo Farm", contact_name: "Sarie", email: "sarie@a.example", phone: null, mobile_phone: null, contact_default: false },
    );
    expect((await actions.searchQuoteCustomersForQuoteAction("karoo")).data).toEqual([{ name: "Karoo Farm", tradingName: null, contactName: "Sarie", email: "sarie@a.example", phone: null, currency: "ZAR" }]);
    expect((await actions.searchQuoteCustomersForQuoteAction("leak")).data).toEqual([]);
  });
  it("a customer with no contact rows is still found, with null (not blank) contact fields", async () => {
    db.rows("customers").push({ org_id: "org-a", name: "No Contact Farm", display_name: "  ", currency: "ZAR" });
    expect((await actions.searchQuoteCustomersForQuoteAction("no contact")).data).toEqual([{ name: "No Contact Farm", tradingName: null, contactName: null, email: null, phone: null, currency: "ZAR" }]);
  });
  it("filter-breaking characters in the search text cannot alter the query", async () => {
    db.rows("customers").push({ org_id: "org-a", name: "Safe Farm", display_name: null, currency: null });
    for (const evil of ["a),org_id.neq.x", "%", "name.ilike.*", "x,name.eq.Safe Farm", "(Safe)"]) expect((await actions.searchQuoteCustomersForQuoteAction(evil)).ok).toBe(true);
    expect((await actions.searchQuoteCustomersForQuoteAction("a),org_id.neq.x")).data).toEqual([]);
  });
  it("REGRESSION: the in-memory database now rejects phantom columns exactly like PostgREST (the original `customers.contact_name` failure)", async () => {
    const r = await db.from("customers").select("name, contact_name").eq("org_id", "org-a") as unknown as { error: { message: string } };
    expect(r.error.message).toBe("column customers.contact_name does not exist");
    const r2 = await db.from("customers").select("name").eq("org_id", "org-a").or("email.ilike.*x*") as unknown as { error: { message: string } };
    expect(r2.error.message).toBe("column customers.email does not exist");
  });
  it("an approved quotation's customer snapshot is immutable (select, contact and refresh are refused)", async () => {
    quote({ state: "MANAGER_APPROVED_FINAL" });
    for (const r of [await actions.selectQuoteCustomerAction("q1", "Boerdery"), await actions.chooseQuoteContactAction("q1", { source: "ENTERED", name: "Piet", email: "p@x.co.za" }), await actions.refreshQuoteCustomerAction("q1", true)])
      expect(r.error).toMatch(/immutable/);
    expect(db.rows("newquip_quote_customers")).toHaveLength(0);
  });
  it("only a Rep may select: a caller without the rep role is refused", async () => {
    quote();
    const { resolveRoles } = await import("@/lib/approvals/role-store");
    vi.mocked(resolveRoles).mockResolvedValueOnce(new Set(["ESTIMATOR"]) as never);
    expect((await actions.selectQuoteCustomerAction("q1", "Boerdery")).error).toMatch(/Only a Rep/);
  });
  it("refresh shows what would change without storing, applies on request, and keeps a still-valid contact choice", async () => {
    quote();
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    vi.mocked(readCin7Customer).mockResolvedValue({ ...RAW, TaxNumber: "777" });
    const p = await actions.refreshQuoteCustomerAction("q1", false);
    expect(p.data!.preview).toEqual({ changes: [{ field: "VAT number", before: "(missing)", after: "777" }], applied: false });
    expect(db.rows("newquip_quote_customers")).toHaveLength(2);
    const ap = await actions.refreshQuoteCustomerAction("q1", true);
    expect(ap.data!.preview.applied).toBe(true);
    expect(ap.data!.view.snapshot!.vatNumber).toEqual({ state: "present", value: "777" });
    expect(ap.data!.view.snapshot!.chosenContact?.email).toBe("piet@boerdery.co.za");
    expect(db.rows("newquip_quote_customers")).toHaveLength(3); // history kept; earlier snapshots never rewritten
  });
  it("refresh refuses when the Cin7 ID behind the name changed", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Boerdery");
    vi.mocked(readCin7Customer).mockResolvedValue({ ...RAW, ID: "different" });
    expect((await actions.refreshQuoteCustomerAction("q1", true)).error).toMatch(/changed/);
  });
  it("without migration 0115 the view says unavailable and selection is refused instead of failing the quotation", async () => {
    db.deliveryApplied = false; quote();
    expect((await actions.getQuoteCustomerAction("q1")).data).toMatchObject({ available: false, snapshot: null });
    expect((await actions.selectQuoteCustomerAction("q1", "Boerdery")).error).toMatch(/migration 0115/);
  });
  it("under Demo Mode the effective user's role applies and the real owner is recorded on the audit", async () => {
    quote();
    vi.mocked(resolveActing).mockResolvedValue({ orgId: "org-a", userId: "d1", email: "rep@sparkconsulting.co.za", tier: "member", demo: { ownerUserId: "own", ownerEmail: "testing@sparkconsulting.co.za", actorName: "[DEMO] Rep", slot: "rep" } } as never);
    const r = await actions.selectQuoteCustomerAction("q1", "Boerdery");
    expect(r.ok).toBe(true);
    expect(db.rows("newquip_quote_customers")[0]).toMatchObject({ captured_by_email: "rep@sparkconsulting.co.za", captured_by_owner_email: "testing@sparkconsulting.co.za" });
  });
});

const RAW2 = { ID: "cin7-2", Name: "Wynplaas", Currency: "ZAR", PaymentTerm: "30 days", Addresses: [{ Type: "Billing", Line1: "2 Wyn Rd", DefaultForType: true }], Contacts: [{ Name: "Sarie", Email: "sarie@wynplaas.co.za" }] };
const bySlug = (n: string) => (n === "Wynplaas" ? RAW2 : RAW);
const rows = () => db.rows("newquip_quote_customers");
const dbQuote = () => db.rows("newquip_quotes")[0] as Record<string, unknown>;

describe("changing and clearing the customer on an editable quotation", () => {
  beforeEach(() => { vi.mocked(readCin7Customer).mockImplementation(async (_d, _o, n) => bySlug(n as string) as never); });

  it("wrong customer selected -> replaced: confirmation is enforced by the SERVER, a new append-only snapshot holds the new customer's data and NONE of the old contact", async () => {
    quote({ draft: { customerName: "Boerdery", siteName: "Plaas" }, customer_name: "Boerdery" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    const noConfirm = await actions.selectQuoteCustomerAction("q1", "Wynplaas");
    expect(noConfirm.error).toMatch(/Confirm/);
    expect(rows()).toHaveLength(2); // nothing stored without the confirmation
    const r = await actions.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(r.ok).toBe(true);
    const s = r.data!.snapshot!;
    expect(s).toMatchObject({ cin7CustomerId: "cin7-2", chosenContact: null, paymentTerm: { state: "present", value: "30 days" }, currency: { state: "present", value: "ZAR" } });
    expect(s.billingAddress?.line1).toEqual({ state: "present", value: "2 Wyn Rd" });
    expect(s.contacts.map((c) => c.email)).toEqual([{ state: "present", value: "sarie@wynplaas.co.za" }]);
    expect(JSON.stringify(s)).not.toContain("piet@boerdery");
    expect(r.data!.issues).toContain("Choose the quotation contact and delivery email.");
    // history preserved, in order, with who/when/why; earlier rows untouched
    expect(rows().map((x) => [x.seq, x.cin7_customer_id])).toEqual([[1, "cin7-1"], [2, "cin7-1"], [3, "cin7-2"]]);
    expect(rows()[2]).toMatchObject({ captured_by_email: "rep@x.co", reason: "Customer changed from Boerdery to Wynplaas" });
    expect(rows()[0].snapshot).toMatchObject({ cin7CustomerId: "cin7-1" });
    expect(r.data!.history.map((h) => h.by)).toEqual(["rep@x.co", "rep@x.co", "rep@x.co"]);
    // scope/site untouched; only the customer name moved
    expect(dbQuote().customer_name).toBe("Wynplaas");
    expect(dbQuote().draft).toMatchObject({ customerName: "Wynplaas", siteName: "Plaas" });
    expect(vi.mocked(logActivity).mock.calls.map((c) => (c[1] as { action: string }).action)).toContain("newquip.quote_customer_changed");
  });

  it("re-selecting the SAME customer changes nothing (no confirmation, no new snapshot, contact kept)", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    const r = await actions.selectQuoteCustomerAction("q1", "Boerdery");
    expect(r.ok).toBe(true); expect(rows()).toHaveLength(2); expect(r.data!.snapshot!.chosenContact?.email).toBe("piet@boerdery.co.za");
  });

  it("Clear selection: a marker is appended (history kept), the customer reads as not selected, the name is blanked, and it needs confirmation", async () => {
    quote({ draft: { customerName: "Boerdery", siteName: "Plaas" }, customer_name: "Boerdery" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    expect((await actions.clearQuoteCustomerAction("q1", false)).error).toMatch(/Confirm/);
    const r = await actions.clearQuoteCustomerAction("q1", true);
    expect(r.ok).toBe(true);
    expect(r.data!.snapshot).toBeNull();
    expect(r.data!.issues).toEqual(["Select the customer from Cin7."]);
    expect(rows().map((x) => x.cin7_customer_id)).toEqual(["cin7-1", "(cleared)"]);
    expect(r.data!.history.map((h) => h.cleared)).toEqual([false, true]);
    expect(dbQuote().draft).toMatchObject({ customerName: "", siteName: "Plaas" });
    expect(await latestSnapshot(db as never, "org-a", "q1")).toBeNull(); // documents / sends / the project gate see NO customer
    expect((await actions.clearQuoteCustomerAction("q1", true)).error).toMatch(/No customer is selected/);
    // a customer can be selected again after clearing, without any confirmation; seq continues
    const again = await actions.selectQuoteCustomerAction("q1", "Wynplaas");
    expect(again.ok).toBe(true); expect(rows().map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it("invalidates what no longer applies: estimator sign-off is withdrawn on a draft; in estimator review the customer's confirmed amount and the sign-off go and the quote returns to the Rep as a new revision", async () => {
    quote({ state: "REP_DRAFT", customer_name: "Boerdery", estimator_signoff_hash: "h", estimator_signoff_by_email: "e@x.co", estimator_signoff_at: "t" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(dbQuote()).toMatchObject({ state: "REP_DRAFT", revision: 1, estimator_signoff_hash: null });
    db.rows("newquip_quotes").length = 0;
    quote({ state: "ESTIMATOR_REVIEW", customer_name: "Boerdery", revision: 2, customer_confirmed_cents: 100000, customer_confirmed_by: "Piet", customer_confirmed_at: "t", handoff_by_email: "rep@x.co", estimator_signoff_hash: "h", estimator_signoff_by_email: "e@x.co", estimator_signoff_at: "t" });
    db.rows("newquip_quote_customers").length = 0;
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    const v = (await actions.getQuoteCustomerAction("q1")).data!;
    expect(v.changeReturnsToRep).toBe(true);
    await actions.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(dbQuote()).toMatchObject({ state: "REP_DRAFT", revision: 3, customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null, estimator_signoff_hash: null });
    // the same applies to Clear
    db.rows("newquip_quotes").length = 0; db.rows("newquip_quote_customers").length = 0;
    quote({ state: "ESTIMATOR_REVIEW", customer_name: "Boerdery", customer_confirmed_cents: 5, customer_confirmed_by: "Piet" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.clearQuoteCustomerAction("q1", true);
    expect(dbQuote()).toMatchObject({ state: "REP_DRAFT", customer_confirmed_cents: null });
  });

  it("scope, packages and pricing are preserved (only the customer name changes in the draft)", async () => {
    const draft = { customerName: "Boerdery", siteName: "Plaas", quoteType: "project", config: { rooms: 4 }, lines: [{ sku: "A", qty: 2 }] };
    quote({ draft, customer_name: "Boerdery" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(dbQuote().draft).toEqual({ ...draft, customerName: "Wynplaas" });
  });

  it("AFTER APPROVAL the customer cannot be changed or cleared, at the server, and nothing is stored or altered", async () => {
    quote({ state: "REP_DRAFT" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    dbQuote().state = "MANAGER_APPROVED_FINAL";
    const before = JSON.stringify([rows(), db.rows("newquip_quotes")]);
    const rs = [await actions.selectQuoteCustomerAction("q1", "Wynplaas", true), await actions.clearQuoteCustomerAction("q1", true)];
    for (const r of rs) expect(r.error).toMatch(/immutable/);
    expect(JSON.stringify([rows(), db.rows("newquip_quotes")])).toBe(before);
    const v = (await actions.getQuoteCustomerAction("q1")).data!;
    expect(v.editable).toBe(false); expect(v.lockedReason).toMatch(/approved/);
  });

  it("only a Rep can change or clear; an estimator is refused", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Boerdery");
    const { resolveRoles } = await import("@/lib/approvals/role-store");
    const est = () => vi.mocked(resolveRoles).mockResolvedValueOnce(new Set(["ESTIMATOR"]) as never);
    est(); expect((await actions.selectQuoteCustomerAction("q1", "Wynplaas", true)).error).toMatch(/Only a Rep/);
    est(); expect((await actions.clearQuoteCustomerAction("q1", true)).error).toMatch(/Only a Rep/);
    est(); expect((await actions.getQuoteCustomerAction("q1")).data!.lockedReason).toMatch(/Only a Rep/);
    expect(rows()).toHaveLength(1);
  });

  it("organisation isolation: another organisation's quotation can be neither changed nor cleared, and is untouched", async () => {
    db.rows("newquip_quotes").push({ id: "qb", org_id: "org-b", quote_ref: "NQ-Q-9", revision: 1, state: "REP_DRAFT", draft: { customerName: "Other" }, customer_name: "Other" });
    db.rows("newquip_quote_customers").push({ id: "x", org_id: "org-b", quote_id: "qb", seq: 1, cin7_customer_id: "b-1", snapshot: {}, snapshot_hash: "h", captured_by_email: "b@b", reason: "" });
    expect((await actions.selectQuoteCustomerAction("qb", "Wynplaas", true)).error).toMatch(/not found/i);
    expect((await actions.clearQuoteCustomerAction("qb", true)).error).toMatch(/not found/i);
    expect(rows()).toHaveLength(1); expect(db.rows("newquip_quotes")[0]).toMatchObject({ customer_name: "Other" });
  });

  it("a same-id quotation in another organisation is never touched by a change in this one", async () => {
    quote({ customer_name: "Boerdery" });
    db.rows("newquip_quotes").push({ id: "q1", org_id: "org-b", quote_ref: "NQ-Q-B", revision: 1, state: "REP_DRAFT", draft: { customerName: "Other" }, customer_name: "Other" });
    await actions.selectQuoteCustomerAction("q1", "Boerdery");
    await actions.selectQuoteCustomerAction("q1", "Wynplaas", true);
    expect(db.rows("newquip_quotes").map((q) => [q.org_id, q.customer_name])).toEqual([["org-a", "Wynplaas"], ["org-b", "Other"]]);
  });

  it("an invalid Cin7 contact email: the Rep corrects it for THIS quotation with a reason; audited, Cin7 unchanged, and the Cin7 snapshot data still shows the original", async () => {
    vi.mocked(readCin7Customer).mockResolvedValue({ ...RAW, Contacts: [{ Name: "Piet", Email: "piet@boerdery,co.za" }, { Name: "Anna" }] });
    quote(); await actions.selectQuoteCustomerAction("q1", "Boerdery");
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 })).error).toMatch(/not valid.*Cin7 is not changed/);
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0, email: "piet@boerdery.co.za" })).error).toMatch(/reason/);
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0, email: "still bad", correctionReason: "typo in Cin7" })).error).toMatch(/not valid/);
    const ok = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0, email: "piet@boerdery.co.za", correctionReason: "comma typo in Cin7" });
    expect(ok.ok).toBe(true);
    expect(ok.data!.snapshot!.chosenContact).toMatchObject({ name: "Piet", email: "piet@boerdery.co.za", emailCorrection: { cin7Email: "piet@boerdery,co.za", reason: "comma typo in Cin7" } });
    expect(ok.data!.snapshot!.contacts[0].email).toEqual({ state: "present", value: "piet@boerdery,co.za" }); // what Cin7 holds is kept as read
    expect(ok.data!.issues).toEqual([]);
    expect(rows().at(-1)!.reason).toMatch(/email corrected for this quotation: comma typo/);
    const audit = vi.mocked(logActivity).mock.calls.map((c) => c[1] as { action: string; detail?: Record<string, unknown> }).find((c) => c.action === "newquip.quote_contact_chosen" && c.detail?.correctionReason);
    expect(audit!.detail).toMatchObject({ cin7Email: "piet@boerdery,co.za", email: "piet@boerdery.co.za", correctionReason: "comma typo in Cin7" });
    // a contact with NO email also needs the correction path
    const none = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1, email: "anna@boerdery.co.za", correctionReason: "no email in Cin7" });
    expect(none.data!.snapshot!.chosenContact).toMatchObject({ name: "Anna", email: "anna@boerdery.co.za", emailCorrection: { cin7Email: null } });
  });
});

describe("choosing between the Cin7 contacts", () => {
  const TWO = { ...RAW, Name: "Spark", ID: "cin7-s", Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za", Phone: "083" }, { Name: "Anton Hill", Email: "anton@sparkconsulting.co.za", Phone: "082" }] };
  beforeEach(() => { vi.mocked(readCin7Customer).mockResolvedValue(TWO as never); });
  const chosen = (v: { snapshot: { chosenContact: { name: string; email: string } | null } | null }) => v.snapshot?.chosenContact ? [v.snapshot.chosenContact.name, v.snapshot.chosenContact.email] : null;

  it("first contact -> second contact -> page refresh: each click persists, the view names and highlights the active contact, the other stays available, history keeps the prior choice", async () => {
    quote({ customer_name: "Spark" });
    await actions.selectQuoteCustomerAction("q1", "Spark");
    const a = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(chosen(a.data!)).toEqual(["AJ Mbulo", "testing@sparkconsulting.co.za"]);
    expect(a.data!.selectedContactIndex).toBe(0);
    const b = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 });
    expect(chosen(b.data!)).toEqual(["Anton Hill", "anton@sparkconsulting.co.za"]);
    expect(b.data!.selectedContactIndex).toBe(1);
    expect(b.data!.snapshot!.contacts.map((c) => (c.name as { value: string }).value)).toEqual(["AJ Mbulo", "Anton Hill"]); // both stay choosable
    // "refresh / reopen": a brand-new read of the saved state
    const again = await actions.getQuoteCustomerAction("q1");
    expect(chosen(again.data!)).toEqual(["Anton Hill", "anton@sparkconsulting.co.za"]);
    expect(again.data!.selectedContactIndex).toBe(1);
    // switching back works too, and the prior selection is in the append-only history
    const c = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(c.data!.selectedContactIndex).toBe(0);
    expect(rows().map((r) => (r.snapshot as { chosenContact?: { name: string } }).chosenContact?.name ?? null)).toEqual([null, "AJ Mbulo", "Anton Hill", "AJ Mbulo"]);
    expect(rows()[2].reason).toBe("Quotation contact changed: AJ Mbulo <testing@sparkconsulting.co.za> → Anton Hill <anton@sparkconsulting.co.za> (Cin7 contact)");
    expect(rows()[1].reason).toMatch(/^Quotation contact set: AJ Mbulo/);
    const audit = vi.mocked(logActivity).mock.calls.map((x) => x[1] as { action: string; detail?: Record<string, unknown> }).filter((x) => x.action === "newquip.quote_contact_chosen");
    expect(audit.at(-2)!.detail).toMatchObject({ email: "anton@sparkconsulting.co.za", previousContact: { name: "AJ Mbulo", email: "testing@sparkconsulting.co.za" } });
  });

  it("clicking the contact that is already selected changes nothing (no duplicate history row)", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Spark");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 });
    const n = rows().length;
    const r = await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 });
    expect(r.ok).toBe(true); expect(rows()).toHaveLength(n); expect(r.data!.selectedContactIndex).toBe(1);
  });

  it("an entered contact is separate: nothing is highlighted among the Cin7 contacts, and Cin7 is never written", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Spark");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    const r = await actions.chooseQuoteContactAction("q1", { source: "ENTERED", name: "Sarie Venter", email: "sarie@x.co.za" });
    expect(r.data!.selectedContactIndex).toBeNull();
    expect(chosen(r.data!)).toEqual(["Sarie Venter", "sarie@x.co.za"]);
    expect(vi.mocked(readCin7Customer)).toHaveBeenCalledTimes(1); // only the one live GET at selection; contact choices never call Cin7
  });

  it("after approval a contact cannot be changed (a new revision is required); roles and organisation are enforced", async () => {
    quote(); await actions.selectQuoteCustomerAction("q1", "Spark");
    await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 });
    const { resolveRoles } = await import("@/lib/approvals/role-store");
    vi.mocked(resolveRoles).mockResolvedValueOnce(new Set(["ESTIMATOR"]) as never);
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).error).toMatch(/Only a Rep/);
    db.rows("newquip_quotes")[0].org_id = "org-b";
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).error).toMatch(/not found/i);
    db.rows("newquip_quotes")[0].org_id = "org-a"; db.rows("newquip_quotes")[0].state = "MANAGER_APPROVED_FINAL";
    const n = rows().length;
    expect((await actions.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).error).toMatch(/immutable/);
    expect(rows()).toHaveLength(n);
    expect((await actions.getQuoteCustomerAction("q1")).data!.snapshot!.chosenContact!.name).toBe("AJ Mbulo");
  });
});
