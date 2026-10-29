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
