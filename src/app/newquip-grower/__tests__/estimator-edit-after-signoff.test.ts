// D-12: after the Estimator signed off, ANY Estimator edit clears the sign-off (saveDraft). The approval request must go back to the ESTIMATOR stage on the current content (the pending MANAGER
// request superseded) so the Estimator can sign off again. The hosted database returns a fresh row on every read, but the in-memory database hands out the LIVE row and updates it in place:
// the action must therefore compare against the hash it read BEFORE saving, not against a row object that the save has already changed.
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
import { buildCustomerSnapshot, withChosenContact } from "@/lib/newquip-quotes/customer-snapshot";
import { readCin7Customer } from "@/lib/newquip-customers/cin7-customer-read";

const NQ = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const U = { owner: "u-owner", rep: "u-rep", est: "u-est", mgr: "u-mgr" };
const EMAIL: Record<string, string> = { "u-owner": DEMO_OWNER_EMAIL, "u-rep": "rep@sparkconsulting.co.za", "u-est": "estimator@sparkconsulting.co.za", "u-mgr": "manager@sparkconsulting.co.za" };
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const total = Math.round(evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true }).budget!.totals.subtotalExTax * 100);
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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

const reqs = () => (db.rows("approval_requests") as Array<Record<string, any>>).map((r) => `${r.stage}:${r.status}`); // eslint-disable-line @typescript-eslint/no-explicit-any
const pending = () => reqs().filter((x) => x.endsWith("PENDING"));
const edited = (f: (d: any) => void) => { const d = structuredClone(quote().draft) as any; f(d); return d as typeof draft; }; // eslint-disable-line @typescript-eslint/no-explicit-any
const submitAndSignOff = async () => { await as("rep"); expect((await send({ source: "QUOTATION_CONTACT" })).error).toBeUndefined(); await as("estimator"); const r = await grower.signOffGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); };

describe("D-12: an Estimator edit after sign-off must not strand the approval", () => {
  it("sign-off, then an Estimator edit: the sign-off is cleared AND the request returns to the ESTIMATOR stage (MANAGER superseded, append-only history kept); the Estimator re-signs off and the Manager can approve", async () => {
    await submitAndSignOff();
    expect(reqs()).toEqual(["ESTIMATOR:APPROVED", "MANAGER:PENDING"]);
    const events = db.rows("approval_events").length;
    const r = await grower.saveGrowerDraftAction("q1", edited((d) => { d.estimator.assumptions = "Site access by gravel road"; }));
    expect(r.error).toBeUndefined();
    expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_hash: null });
    expect(reqs()).toEqual(["ESTIMATOR:APPROVED", "MANAGER:SUPERSEDED", "ESTIMATOR:PENDING"]);
    expect(db.rows("approval_events").length).toBeGreaterThan(events); // history only ever grows
    expect((await grower.signOffGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(pending()).toEqual(["MANAGER:PENDING"]);
    await as("manager");
    const ap = await grower.approveGrowerQuoteAction("q1");
    expect(ap.error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
  });
  it("the Estimator may Return to the Rep from the re-opened stage", async () => {
    await submitAndSignOff();
    await grower.saveGrowerDraftAction("q1", edited((d) => { d.estimator.assumptions = "Changed"; }));
    const r = await grower.returnGrowerQuoteToRepAction("q1", "Please clarify the site");
    expect(r.error).toBeUndefined();
    expect(quote().state).toBe("REP_DRAFT");
  });
  it("an Estimator edit with NO sign-off: the ESTIMATOR request follows the new content (still exactly one pending ESTIMATOR request)", async () => {
    await as("rep"); await send({ source: "QUOTATION_CONTACT" }); await as("estimator");
    const first = (db.rows("approval_requests") as Array<Record<string, any>>)[0].digest; // eslint-disable-line @typescript-eslint/no-explicit-any
    await grower.saveGrowerDraftAction("q1", edited((d) => { d.estimator.assumptions = "Gravel road"; }));
    expect(pending()).toEqual(["ESTIMATOR:PENDING"]);
    expect((db.rows("approval_requests") as Array<Record<string, any>>).find((x) => x.status === "PENDING")!.digest).not.toBe(first); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it("a Rep edit after the quotation was returned (REP_DRAFT) opens no request", async () => {
    await submitAndSignOff();
    await as("manager"); await grower.returnGrowerQuoteToRepAction("q1", "Rework the scope please");
    await as("rep");
    const r = await grower.saveGrowerDraftAction("q1", edited((d) => { d.siteName = "Another farm"; }));
    expect(r.error).toBeUndefined(); expect(quote().state).toBe("REP_DRAFT"); expect(pending()).toEqual([]);
  });
  it("saving identical content changes nothing (no new request, no sign-off cleared)", async () => {
    await as("rep"); await grower.saveGrowerDraftAction("q1", edited(() => undefined)); // the seeded hash is a placeholder: store the real one first
    await submitAndSignOff();
    const before = reqs();
    await grower.saveGrowerDraftAction("q1", edited(() => undefined));
    expect(reqs()).toEqual(before); expect(quote().estimator_signoff_hash).toBeTruthy();
  });
});
