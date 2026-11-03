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

// UX-006 integration (S1b + D5): every confirmation-WITHDRAWAL path (amount changed / confirmed contact changed, refresh) now records WHY before the state change (return record, revision-bound).
// The REAL server actions over the in-memory database; only the session, cookies and the cost-visible evaluation context are replaced.
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

const records = () => acts().filter((x) => x.action === "newquip.quote_return_recorded");
const info = async (slot: string) => { await as(slot); const r = await grower.getGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); return r.data!.returnInfo; };

describe("S1b withdrawals record their return (D5 glue)", () => {
  it("AMOUNT_CHANGED: an Estimator price edit withdraws the confirmation and leaves a revision-bound record readable by the Rep with previous -> new total", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    await as("estimator");
    const d = structuredClone(quote().draft) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    d.estimator.charges.delivery += 100_000;
    const saved = await grower.saveGrowerDraftAction("q1", d as never);
    expect(saved.error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    expect(records()).toHaveLength(1);
    expect(records()[0].detail).toMatchObject({ quoteId: "q1", kind: "AMOUNT_CHANGED", byEmail: EMAIL[U.est], byRole: "estimator", destination: "REP", fromRevision: 1, toRevision: 2, previousCents: total });
    expect(records()[0].detail.newCents).not.toBe(total);
    expect(await info("rep")).toMatchObject({ kind: "AMOUNT_CHANGED", previousCents: total, byEmail: EMAIL[U.est], destination: "REP", source: "RECORD" });
  });

  it("CONTACT_CHANGED: choosing another contact withdraws the confirmation; the Rep is the recorded actor with the neutral reason", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 }, true);
    expect(r.error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    expect(records()).toHaveLength(1);
    expect(records()[0].detail).toMatchObject({ kind: "CONTACT_CHANGED", byEmail: EMAIL[U.rep], byRole: "rep", destination: "REP", toRevision: 2, previousCents: total });
    expect(await info("rep")).toMatchObject({ kind: "CONTACT_CHANGED", byRole: "rep", source: "RECORD" });
    expect((await info("rep"))!.reason).toMatch(/confirmed customer contact changed/i);
  });

  it("a refresh that drops the confirmed contact records CONTACT_CHANGED too, and a stale record never survives a later revision", async () => {
    await as("rep"); await send({ source: "CIN7_CONTACT", contactIndex: 1 });
    vi.mocked(readCin7Customer).mockResolvedValue({ ...RAW, Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za" }] } as never);
    const r = await customer.refreshQuoteCustomerAction("q1", true);
    expect(r.error).toBeUndefined();
    expect(records()).toHaveLength(1);
    expect(records()[0].detail).toMatchObject({ kind: "CONTACT_CHANGED", toRevision: 2 });
    Object.assign(quote(), { revision: 3 }); // a later revision: the record is bound to revision 2 and no longer describes it
    expect(await info("rep")).toBeNull();
  });

  it("no record when nothing is withdrawn: a Rep draft contact change, a wrong role, and an invalidate with no confirmation write nothing", async () => {
    await as("rep");
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).error).toBeUndefined(); // REP_DRAFT, no confirmation
    expect(records()).toEqual([]);
    await send({ source: "QUOTATION_CONTACT" });
    await as("estimator");
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 }, true)).ok).toBe(false); // not the Rep's to change
    expect(records()).toEqual([]);
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total, revision: 1 });
  });

  it("the record is written BEFORE the state change: when it cannot be stored nothing is withdrawn", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" });
    const real = db.from.bind(db);
    (db as any).from = (t: string) => (t === "activity_log" ? { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "disk full" } }) }) }) } : real(t)); // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 }, true);
    (db as any).from = real; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.ok).toBe(false);
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total, revision: 1 });
  });
});
