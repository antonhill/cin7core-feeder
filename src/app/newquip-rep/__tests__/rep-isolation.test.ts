import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { resolveActing } from "@/lib/demo-mode/context";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { assignRep, endAssignment, reassignCustomer } from "@/lib/newquip-assignments/assignment-store";
import { appendClearMarker } from "@/lib/newquip-quotes/customer-store";
import { deliverPendingEmails } from "@/lib/approvals/approval-store";

// Customer-level Rep isolation (Slice 1B) through the REAL server actions and route handlers over an in-memory database. Only the session, Demo Mode resolution, the audit log, the Cin7
// customer read and the file storage are replaced; role resolution (explicit org_functional_roles vs organisation tier), the assignment store, the access boundary and every guarded
// action are the real code.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn(async () => ({ orgId: "org-a" })) }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", async (orig) => ({ ...(await orig<typeof import("@/lib/activity-log")>()), logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
const CIN7 = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/newquip-customers/cin7-customer-read", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-customers/cin7-customer-read")>()), readCin7Customer: vi.fn(async (_db: unknown, _org: string, name: string) => CIN7.get(name) ?? null) }));
const readBytes = vi.fn(async (_db: unknown, _org: string, id: string) => ({ doc: { id, quote_ref: "NQ-X", revision: 1, version: 1 }, bytes: new Uint8Array([37, 80, 68, 70]) }));
vi.mock("@/lib/newquip-quotes/document-store", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-quotes/document-store")>()), defaultDeps: () => ({ storage: {} }), readDocumentBytes: (...a: unknown[]) => (readBytes as (...x: unknown[]) => unknown)(...a) }));
const readEvidence = vi.fn(async (_db: unknown, _org: string, id: string) => ({ row: { id, quote_id: "x", response_id: "r", file_name: "e.pdf" }, bytes: new Uint8Array([1, 2, 3]) }));
vi.mock("@/lib/newquip-quotes/response-evidence", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-quotes/response-evidence")>()), readEvidenceBytes: (...a: unknown[]) => (readEvidence as (...x: unknown[]) => unknown)(...a) }));
const recordStaff = vi.fn(async () => ({ created: true, response: { id: "resp", response: "DECLINED", document_id: "d" }, evidence: [] }));
vi.mock("@/lib/newquip-quotes/response-record", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-quotes/response-record")>()), recordStaffResponse: (...a: unknown[]) => (recordStaff as (...x: unknown[]) => unknown)(...a), attachEvidence: vi.fn(async () => []) }));

import * as grower from "@/app/newquip-grower/actions";
import * as customers from "@/app/newquip-grower/customer-actions";
import * as docs from "@/app/newquip-grower/document-actions";
import * as delivery from "@/app/newquip-grower/delivery-actions";
import * as mapping from "@/app/newquip-grower/mapping-actions";
import * as approvals from "@/app/approvals/actions";
import * as activity from "@/app/activity/actions";
import * as isolation from "../isolation-actions";
import { GET as getDocument } from "@/app/api/newquip-quote-documents/[id]/route";
import { GET as getEvidence } from "@/app/api/newquip-response-evidence/[id]/route";
import { POST as postResponse } from "@/app/api/newquip-quote-responses/route";
import { quoteScope, projectsAllowed, canSeeQuote } from "@/lib/newquip-assignments/access";

const ORG = "org-a"; const OTHER = "org-b";
const C1 = "11111111-1111-4111-8111-111111111111"; const C2 = "22222222-2222-4222-8222-222222222222"; const C3 = "33333333-3333-4333-8333-333333333333";
const SENTINEL = 987654.321;
type Tier = "owner" | "admin" | "member";
const people: Record<string, { email: string; tier: Tier; roles: string[] }> = {};
const who = (id: string, email: string, tier: Tier, roles: string[] = []) => {
  people[id] = { email, tier, roles }; db.rows("org_members").push({ org_id: ORG, user_id: id, role: tier });
  for (const role of roles) db.rows("org_functional_roles").push({ id: `r-${id}-${role}`, org_id: ORG, user_id: id, user_email: email, role, assigned_by_email: "adm@nq.test", assigned_at: "t" });
};
/** Sign in as `id` (organisation owner/admin tier is derived from the person's tier, as the real requireOrgAdmin does). */
const as = (id: string, demoFor?: string) => {
  const p = people[id]; const eff = demoFor ? people[demoFor] : p; const effId = demoFor ?? id;
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: id, email: p.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (p.tier === "member") throw new Error("not admin"); return undefined as never; });
  vi.mocked(resolveActing).mockResolvedValue({ orgId: ORG, userId: effId, email: eff.email, tier: demoFor ? (eff.tier === "member" ? "member" : "admin") : null,
    demo: demoFor ? { ownerUserId: id, ownerEmail: p.email, actorName: "Demo", effectiveUserId: effId } : null } as never);
};
const quote = (id: string, customer: string | null, o: { org?: string; creator?: string; state?: string } = {}) => {
  const draft = readyDraft();
  (draft.estimator as unknown as Record<string, unknown>).costOverrides = { feeder: { unitCostExVat: SENTINEL, reason: "negotiated", by: "e@nq.test", at: "t" } };
  db.rows("newquip_quotes").push({ id, org_id: o.org ?? ORG, quote_ref: `NQ-${id}`, revision: 1, customer_name: "Farm", site_name: "Site", quote_type: "project", state: o.state ?? "REP_DRAFT", draft, draft_hash: "h", contract_cents: null, project_id: null,
    created_by_email: o.creator ?? "creator@nq.test", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", accepted_baseline: null, baseline_hash: null });
  if (customer) db.rows("newquip_quote_customers").push({ id: `s-${id}`, org_id: o.org ?? ORG, quote_id: id, seq: 1, cin7_customer_id: customer, snapshot: { cin7CustomerId: customer, contacts: [] }, snapshot_hash: "h" });
};
const assign = (rep: string, customer: string, name = `Customer ${customer.slice(0, 2)}`) => assignRep(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: customer, customerName: name, repUserId: rep, repEmail: people[rep].email });
const isolate = (on: boolean) => { db.accessApplied = true; const row = db.rows("newquip_access_settings").find((r) => r.org_id === ORG); if (row) row.rep_isolation_enabled = on; else db.rows("newquip_access_settings").push({ org_id: ORG, rep_isolation_enabled: on }); };
const ids = async (user: string) => { as(user); const r = await grower.listGrowerQuotesAction(); expect(r.ok, r.error).toBe(true); return r.data!.map((q) => q.id).sort(); };
const GENERIC = "Quote not found.";

beforeEach(() => {
  db = new FakeDb(); db.assignmentsApplied = true; db.deliveryApplied = true; db.rolesApplied = true; db.portalApplied = true; db.approvalsApplied = true; CIN7.clear();
  for (const k of Object.keys(people)) delete people[k];
  (db as unknown as { auth: unknown }).auth = { admin: { getUserById: async (id: string) => ({ data: { user: people[id] ? { email: people[id].email } : null } }) } };
  who("adm", "adm@nq.test", "admin"); who("est", "est@nq.test", "member", ["ESTIMATOR"]); who("mgr", "mgr@nq.test", "member", ["MANAGER"]);
  who("repA", "a@nq.test", "member", ["REP"]); who("repB", "b@nq.test", "member", ["REP"]); who("plain", "plain@nq.test", "member"); who("sysadm", "sysadm@nq.test", "member", ["ADMINISTRATOR"]);
  quote("q1", C1, { creator: "someone@nq.test" }); quote("q2", C2); quote("q3", C3); quote("q4", null, { creator: "a@nq.test" }); quote("q5", null, { creator: "est@nq.test" }); quote("qx", C1, { org: OTHER });
  vi.mocked(readBytes).mockClear(); vi.mocked(readEvidence).mockClear(); vi.mocked(recordStaff).mockClear();
});

describe("the switch is OFF by default: today's behaviour is unchanged", () => {
  it("with the migration absent, or the switch off, every Rep still sees the whole organisation (no regression while disabled)", async () => {
    await assign("repA", C1);
    for (const state of ["absent", "off"] as const) {
      if (state === "off") isolate(false);
      expect(await ids("repA"), state).toEqual(["q1", "q2", "q3", "q4", "q5"]);
      as("plain"); expect((await grower.getGrowerQuoteAction("q3")).ok, state).toBe(true);
    }
  });
});

describe("ON: a Rep sees exactly the quotations of their assigned customers (plus their own customer-less drafts)", () => {
  beforeEach(async () => { await assign("repA", C1); await assign("repB", C2); isolate(true); });

  it("lists: Rep A -> Customer 1 and own enquiry; Rep B -> Customer 2; a plain member, an explicit Administrator and a Rep with no assignment -> nothing", async () => {
    expect(await ids("repA")).toEqual(["q1", "q4"]);
    expect(await ids("repB")).toEqual(["q2"]);
    expect(await ids("plain")).toEqual([]);          // the implicit tier-default roles (REP + ESTIMATOR) do NOT confer organisation-wide visibility
    expect(await ids("sysadm")).toEqual([]);         // an explicit Administrator is not a commercial role
  });
  it("organisation owner/admin and EXPLICIT Estimator / Manager keep organisation-wide visibility; the other organisation never leaks", async () => {
    for (const u of ["adm", "est", "mgr"]) expect(await ids(u), u).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    as("adm"); expect((await grower.getGrowerQuoteAction("qx")).error).toBe(GENERIC);
  });
  it("opening: assigned quotation OK; unassigned, other-organisation and non-existent ids give the SAME generic denial (no existence probe)", async () => {
    as("repA");
    expect((await grower.getGrowerQuoteAction("q1")).ok).toBe(true);
    const denied = [await grower.getGrowerQuoteAction("q3"), await grower.getGrowerQuoteAction("q2"), await grower.getGrowerQuoteAction("qx"), await grower.getGrowerQuoteAction("does-not-exist"), await grower.getGrowerQuoteAction("q5")];
    for (const r of denied) expect(r).toEqual({ ok: false, error: GENERIC });
  });
  it("a Rep never receives cost, margin or cost overrides, even for an assigned quotation", async () => {
    as("repA"); const r = await grower.getGrowerQuoteAction("q1");
    expect(r.ok).toBe(true); expect(r.data!.viewer.canViewCommercials).toBe(false);
    expect(JSON.stringify(r.data)).not.toContain(String(SENTINEL)); expect(JSON.stringify(r.data)).not.toMatch(/"(estimatedCost|estimatedGP|marginPct|gpCents)":(?!null|0[,}])/);   // cost fields exist only as null
  });

  it("every workflow action on an unassigned quotation is refused and changes NOTHING", async () => {
    as("repA"); const before = JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_quote_customers"), db.rows("approval_requests")]); db.writes.length = 0;
    const attempts = [
      await grower.saveGrowerDraftAction("q3", readyDraft()), await grower.sendGrowerQuoteToEstimatorAction("q3", 100, { source: "ALTERNATIVE", name: "x", email: "x@y.zz", reason: "reasons" } as never),
      await grower.returnGrowerQuoteToRepAction("q3", "reason"), await grower.signOffGrowerQuoteAction("q3"), await grower.returnGrowerQuoteToEstimatorAction("q3", "reason"),
      await grower.approveGrowerQuoteAction("q3"), await grower.createProjectFromGrowerQuoteAction("q3"),
    ];
    // (the Project action checks the role first: a Rep, who is neither Estimator nor Manager, gets a permission message that reveals nothing about the quotation)
    for (const r of attempts) expect([GENERIC, "You do not have permission to create a Project."], JSON.stringify(r)).toContain(r.error);
    as("plain");   // tier-default Estimator: passes the role check, so the customer boundary is what stops it
    expect((await grower.createProjectFromGrowerQuoteAction("q3")).error).toBe(GENERIC);
    as("repA");
    expect(JSON.stringify([db.rows("newquip_quotes"), db.rows("newquip_quote_customers"), db.rows("approval_requests")])).toBe(before);
    expect(db.writes).toEqual([]);
  });
  it("customer, document, delivery, mapping and scope actions on an unassigned quotation are refused with the same generic denial", async () => {
    as("repA");
    expect((await customers.getQuoteCustomerAction("q3")).error).toBe(GENERIC);
    expect((await customers.selectQuoteCustomerAction("q3", "Anything")).error).toBe(GENERIC);
    expect((await customers.clearQuoteCustomerAction("q3", true)).error).toBe(GENERIC);
    expect((await customers.chooseQuoteContactAction("q3", { source: "ENTERED", name: "N N", email: "n@x.zz" })).error).toBe(GENERIC);
    expect((await customers.refreshQuoteCustomerAction("q3", false)).error).toBe(GENERIC);
    expect((await docs.getQuoteDocumentsAction("q3")).error).toBe(GENERIC);
    expect((await docs.issueQuoteDocumentAction("q3")).error).toBe(GENERIC);
    expect((await delivery.getQuoteDeliveryAction("q3")).error).toBe(GENERIC);
    expect((await delivery.sendQuoteToCustomerAction("q3", { documentId: "d", to: ["a@b.cc"], message: "", idempotencyKey: "k-0001-aaaa" } as never)).error).toBe(GENERIC);
    expect((await delivery.retryQuoteSendAction("q3", "s1")).error).toBe(GENERIC);
    expect((await delivery.recordCustomerResponseAction("q3", { documentId: "d", response: "DECLINED", contactName: "N N", respondedOn: "2026-10-01", evidenceRef: "email" } as never)).error).toBe(GENERIC);
    expect((await delivery.reviewCustomerResponseAction("q3", { responseId: "r", decision: "VERIFIED", note: "n" })).error).toBe(GENERIC);
    expect((await delivery.revokeResponseLinksAction("q3", "reason")).error).toBe(GENERIC);
    expect((await mapping.getQuoteScopeAction("q3")).error).toBe(GENERIC);
    expect(db.rows("newquip_quote_sends")).toHaveLength(0); expect(db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("the assigned quotation's actions are reachable (the same actions on q1 get past the boundary)", async () => {
    as("repA");
    expect((await customers.getQuoteCustomerAction("q1")).error).not.toBe(GENERIC);
    expect((await delivery.getQuoteDeliveryAction("q1")).error).not.toBe(GENERIC);
    expect((await docs.getQuoteDocumentsAction("q1")).error).not.toBe(GENERIC);
    expect((await mapping.getQuoteScopeAction("q1")).error).not.toBe(GENERIC);
  });

  it("customer search and selection: a Rep finds and may select only their assigned customers", async () => {
    CIN7.set("Customer 11", { ID: C1, Name: "Customer 11", Contacts: [], Addresses: [] }); CIN7.set("Customer 33", { ID: C3, Name: "Customer 33", Contacts: [], Addresses: [] });
    as("repA");
    const found = await customers.searchQuoteCustomersForQuoteAction("customer");
    expect(found.data!.map((h) => h.name)).toEqual(["Customer 11"]);
    // direct invocation without the UI: selecting an unassigned customer on the Rep's own customer-less draft is refused and writes no snapshot
    const snaps = db.rows("newquip_quote_customers").length;
    const bad = await customers.selectQuoteCustomerAction("q4", "Customer 33");
    expect(bad.ok).toBe(false); expect(bad.error).toBe("Choose one of the customers assigned to you.");
    expect(db.rows("newquip_quote_customers")).toHaveLength(snaps);
    const good = await customers.selectQuoteCustomerAction("q4", "Customer 11");
    expect(good.ok, good.error).toBe(true); expect(db.rows("newquip_quote_customers")).toHaveLength(snaps + 1);
  });
  it("managers, estimators and administrators search the full customer list as before", async () => {
    as("adm"); const r = await customers.searchQuoteCustomersForQuoteAction("zz"); expect(r.ok, r.error).toBe(true); // goes to the synced-customer search (org-wide), not the assignment list
  });

  it("the approvals queue, request detail, decisions, notifications and document history follow the same rule", async () => {
    const reqRow = (id: string, doc_type: string, doc_id: string) => ({ id, org_id: ORG, doc_type, doc_id, doc_ref: doc_id, revision: 1, status: "PENDING", stage: "MANAGER", stage_role: "MANAGER", digest: "d", version: 1, amount_cents: 1, prepared_by_email: "p@nq.test", submitted_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
    db.rows("approval_requests").push(reqRow("r1", "QUOTE", "q1"), reqRow("r3", "QUOTE", "q3"), reqRow("rc", "CLAIM", "claim-1"));
    const note = (id: string, request_id: string | null, quote_id: string | null) => ({ id, org_id: ORG, request_id, quote_id, kind: "SUBMITTED", recipient_email: "a@nq.test", channel: "IN_APP", subject: "s", body: "b", dedupe_key: id, status: "SENT", attempts: 0, last_error: null, provider_message_id: null, sent_at: "t", read_at: null, created_at: "2026-10-01T00:00:00Z" });
    db.rows("approval_notifications").push(note("n1", "r1", null), note("n3", "r3", null), note("nq3", null, "q3"), note("nq1", null, "q1"), note("nc", "rc", null));
    as("repA");
    const dash = await approvals.getApprovalsDashboardAction(); expect(dash.ok, dash.error).toBe(true);
    expect(dash.data!.rows.map((r) => r.id)).toEqual(["r1"]);
    expect((await approvals.getApprovalDetailAction("r3")).error).toBe("Approval request not found.");
    expect((await approvals.getApprovalDetailAction("rc")).error).toBe("Approval request not found.");
    expect((await approvals.getApprovalDetailAction("nope")).error).toBe("Approval request not found.");
    expect((await approvals.decideApprovalAction("r3", "APPROVE", { expectedVersion: 1 } as never)).error).toBe("Approval request not found.");
    expect((await approvals.reassignApprovalAction("r3", "x@y.zz", 1)).error).toBe("Approval request not found.");
    expect((await approvals.getDocumentApprovalAction("QUOTE", "q3")).error).toBe(GENERIC);
    expect((await approvals.getDocumentApprovalAction("CLAIM", "claim-1")).error).toBe("Not found.");
    expect((await approvals.submitDocumentForApprovalAction("QUOTE", "q3")).error).toBe(GENERIC);
    const notes = await approvals.getMyNotificationsAction(); expect(notes.data!.notifications.map((n) => n.id).sort()).toEqual(["n1", "nq1"]);
    as("mgr"); expect((await approvals.getApprovalsDashboardAction()).data!.rows.map((r) => r.id).sort()).toEqual(["r1", "r3", "rc"]);   // org-wide roles unchanged
    expect((await approvals.getApprovalDetailAction("r3")).error).not.toBe("Approval request not found.");
  });
  it("the activity log hides NewQuip / approvals / projects entries from a Rep but keeps Toolbox entries", async () => {
    const row = (action: string) => ({ id: `a-${action}`, org_id: ORG, instance_id: null, actor_email: "x@nq.test", action, summary: action, detail: null, created_at: "2026-10-01T00:00:00Z" });
    db.rows("activity_log").push(row("newquip.quote_created"), row("approvals.decided"), row("projects.claim_approved"), row("sync.completed"), row("instance.created"));
    as("repA"); expect((await activity.listActivityAction()).data!.map((r) => r.action).sort()).toEqual(["instance.created", "sync.completed"]);
    as("adm"); expect((await activity.listActivityAction()).data!.length).toBe(5);
  });

  it("document download route: assigned -> bytes; unassigned / foreign / unknown -> the same 404 and the file is never read", async () => {
    db.rows("newquip_quote_documents").push({ id: "11111111-aaaa-4aaa-8aaa-111111111111", org_id: ORG, quote_id: "q1" }, { id: "33333333-aaaa-4aaa-8aaa-333333333333", org_id: ORG, quote_id: "q3" }, { id: "99999999-aaaa-4aaa-8aaa-999999999999", org_id: OTHER, quote_id: "qx" });
    const get = (id: string) => getDocument(new Request("https://x.test"), { params: Promise.resolve({ id }) });
    as("repA"); expect((await get("11111111-aaaa-4aaa-8aaa-111111111111")).status).toBe(200);
    vi.mocked(readBytes).mockClear();
    for (const id of ["33333333-aaaa-4aaa-8aaa-333333333333", "99999999-aaaa-4aaa-8aaa-999999999999", "00000000-aaaa-4aaa-8aaa-000000000000"]) { const r = await get(id); expect(r.status, id).toBe(404); expect(await r.text()).toBe("Not found"); }
    expect(readBytes).not.toHaveBeenCalled();
    as("mgr"); expect((await get("33333333-aaaa-4aaa-8aaa-333333333333")).status).toBe(200);   // organisation-wide role unchanged
  });
  it("evidence download route: same rule", async () => {
    db.rows("newquip_response_evidence").push({ id: "11111111-eeee-4eee-8eee-111111111111", org_id: ORG, quote_id: "q1" }, { id: "33333333-eeee-4eee-8eee-333333333333", org_id: ORG, quote_id: "q3" });
    const get = (id: string) => getEvidence(new Request("https://x.test"), { params: Promise.resolve({ id }) });
    as("repA"); expect((await get("11111111-eeee-4eee-8eee-111111111111")).status).toBe(200);
    vi.mocked(readEvidence).mockClear();
    const r = await get("33333333-eeee-4eee-8eee-333333333333"); expect(r.status).toBe(404); expect(readEvidence).not.toHaveBeenCalled();
    as("plain"); expect((await get("11111111-eeee-4eee-8eee-111111111111")).status).toBe(404);   // no assignment at all
  });
  it("customer-response upload route: refused before any file is read or anything recorded", async () => {
    const post = (quoteId: string) => { const f = new FormData(); f.set("quoteId", quoteId); f.set("intent", "record"); f.set("documentId", "d"); f.set("response", "DECLINED"); f.set("contact", JSON.stringify({ source: "DELIVERY_CONTACT" })); return postResponse(new Request("https://x.test", { method: "POST", body: f })); };
    as("repA");
    const denied = await post("00000000-0000-4000-8000-000000000003"); expect(denied.status).toBe(400); expect((await denied.json()).error).toBe(GENERIC);
    db.rows("newquip_quotes").push({ ...(db.rows("newquip_quotes").find((q) => q.id === "q3") as object), id: "33333333-0000-4000-8000-000000000033" });
    db.rows("newquip_quote_customers").push({ id: "s-x", org_id: ORG, quote_id: "33333333-0000-4000-8000-000000000033", seq: 1, cin7_customer_id: C3, snapshot: {}, snapshot_hash: "h" });
    const denied2 = await post("33333333-0000-4000-8000-000000000033"); expect((await denied2.json()).error).toBe(GENERIC);
    expect(recordStaff).not.toHaveBeenCalled();
  });

  it("an unauthenticated or forged session is rejected by every guarded surface (no data returned)", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("Not signed in"));
    expect((await grower.listGrowerQuotesAction()).ok).toBe(false); expect((await grower.getGrowerQuoteAction("q1")).ok).toBe(false);
    expect((await docs.getQuoteDocumentsAction("q1")).ok).toBe(false); expect((await approvals.getApprovalsDashboardAction()).ok).toBe(false);
    const r = await getDocument(new Request("https://x.test"), { params: Promise.resolve({ id: "11111111-aaaa-4aaa-8aaa-111111111111" }) }); expect(r.status).toBe(401);
    expect(readBytes).not.toHaveBeenCalled();
  });
  it("Demo Mode evaluates the EFFECTIVE user: the owner impersonating Rep A sees only Rep A's customers; impersonating a Manager sees everything", async () => {
    as("adm", "repA"); expect((await grower.listGrowerQuotesAction()).data!.map((q) => q.id).sort()).toEqual(["q1", "q4"]);
    as("adm", "mgr"); expect((await grower.listGrowerQuotesAction()).data!.length).toBe(5);
    as("adm"); expect((await grower.listGrowerQuotesAction()).data!.length).toBe(5);
  });
});

describe("ON: Rep creation, drafts and workflow continue within the Rep's own scope", () => {
  beforeEach(async () => { await assign("repA", C1); isolate(true); });
  it("a Rep can create a quotation and keeps access to their own customer-less draft; other Reps cannot see it; Estimators and Managers can", async () => {
    as("repA"); const c = await grower.createGrowerQuoteAction(); expect(c.ok, c.error).toBe(true);
    const id = c.data!.id;
    expect((await grower.getGrowerQuoteAction(id)).ok).toBe(true);
    expect((await ids("repA"))).toContain(id);
    as("repB"); expect((await grower.getGrowerQuoteAction(id)).error).toBe(GENERIC);
    as("est"); expect((await grower.getGrowerQuoteAction(id)).ok).toBe(true);
    as("repA"); const saved = await grower.saveGrowerDraftAction(id, readyDraft()); expect(saved.ok, saved.error).toBe(true);
  });
});

describe("reassignment: access follows the authoritative assignment immediately, history and ownership are untouched", () => {
  beforeEach(() => { isolate(true); });
  it("A -> B: A loses every quotation of the customer (including historical ones) at once, B gains them, a third assigned Rep keeps access, the creator and quotation rows are unchanged", async () => {
    quote("q6", C1, { creator: "a@nq.test", state: "MANAGER_APPROVED_FINAL" }); // a historical, approved, issued quotation created by Rep A
    await assign("repA", C1); await assign("plain", C1);
    expect(await ids("repA")).toEqual(["q1", "q4", "q6"].filter((x) => x !== "q4").concat(["q4"]).sort());
    const before = JSON.stringify(db.rows("newquip_quotes"));
    const r = await reassignCustomer(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", toRepEmail: people.repB.email, reason: "territory change" });
    expect(r.created).toBe(true);
    expect(await ids("repA")).toEqual(["q4"]);                       // only their own customer-less draft remains
    expect(await ids("repB")).toEqual(["q1", "q6"]);
    expect(await ids("plain")).toEqual(["q1", "q6"]);                // independently assigned Rep keeps access
    expect(JSON.stringify(db.rows("newquip_quotes"))).toBe(before);  // creator and every quotation field unchanged
    as("repA"); expect((await grower.getGrowerQuoteAction("q6")).error).toBe(GENERIC);
    as("repB"); expect((await grower.getGrowerQuoteAction("q6")).ok).toBe(true);
  });
  it("a FAILED reassignment changes no effective access; ending an assignment removes access immediately; a replay or duplicate request is refused", async () => {
    await assign("repA", C1); const a2 = await assign("repB", C2);
    const snap = JSON.stringify(db.rows("customer_rep_assignments"));
    await expect(reassignCustomer(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", toRepEmail: "x@", reason: "territory change" })).rejects.toThrow();
    expect(JSON.stringify(db.rows("customer_rep_assignments"))).toBe(snap);
    expect(await ids("repA")).toEqual(["q1", "q4"]);
    await endAssignment(db as never, ORG, { email: "adm@nq.test" }, a2.assignment.id, "customer left the Rep");
    expect(await ids("repB")).toEqual([]);
    const mv = () => reassignCustomer(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", toRepEmail: people.repB.email, reason: "territory change" });
    await mv(); await expect(mv()).rejects.toThrow(/not currently assigned/);
    expect(await ids("repA")).toEqual(["q4"]); expect(await ids("repB")).toEqual(["q1"]);
  });
  it("concurrent reassignments of one customer leave exactly one winner and a consistent effective access", async () => {
    await assign("repA", C1);
    const mv = (to: string) => reassignCustomer(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: to, toRepEmail: people[to].email, reason: "race" });
    const res = await Promise.allSettled([mv("repB"), mv("plain"), mv("repB")]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const holders = [await ids("repA"), await ids("repB"), await ids("plain")].filter((l) => l.includes("q1"));
    expect(holders).toHaveLength(1);
  });
});

describe("fail closed", () => {
  it("isolation ON but customer assignments unavailable: assigned-scoped Reps get nothing; organisation-wide roles are unaffected", async () => {
    isolate(true); db.assignmentsApplied = false;
    as("repA"); const r = await grower.listGrowerQuotesAction(); expect(r.ok).toBe(false); expect(r.error).toBe("Customer assignments are not available yet.");
    expect((await grower.getGrowerQuoteAction("q1")).ok).toBe(false);
    expect((await ids("adm")).length).toBe(5); expect((await ids("mgr")).length).toBe(5);
  });
  it("a settings read that fails for any reason other than 'not installed' is never treated as OFF", async () => {
    db.accessApplied = true; const real = db.from.bind(db);
    (db as unknown as { from: unknown }).from = (t: string) => t === "newquip_access_settings" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }) }) }) } : real(t);
    as("repA"); const r = await grower.listGrowerQuotesAction(); expect(r.ok).toBe(false); expect(r.error).toBe("Access settings are unavailable.");
  });
});

describe("role precedence (explicit org_functional_roles beat the organisation-tier defaults)", () => {
  beforeEach(() => { isolate(true); });
  const scopeOf = async (u: string) => (await quoteScope(db as never, { orgId: ORG, userId: u, email: people[u].email, tier: people[u].tier === "member" ? "member" : "admin" })).kind;
  it("org-wide only for owner/admin tier or an EXPLICIT Estimator/Manager; Rep, plain member and Administrator-only are assigned-scoped", async () => {
    expect(await scopeOf("adm")).toBe("ORG_WIDE"); expect(await scopeOf("est")).toBe("ORG_WIDE"); expect(await scopeOf("mgr")).toBe("ORG_WIDE");
    expect(await scopeOf("repA")).toBe("ASSIGNED"); expect(await scopeOf("plain")).toBe("ASSIGNED"); expect(await scopeOf("sysadm")).toBe("ASSIGNED");
  });
  it("a person holding Rep AND Estimator explicitly keeps organisation-wide visibility; removing the Estimator role narrows them to their assignments", async () => {
    who("both", "both@nq.test", "member", ["REP", "ESTIMATOR"]); expect(await scopeOf("both")).toBe("ORG_WIDE");
    db.rows("org_functional_roles").splice(db.rows("org_functional_roles").findIndex((r) => r.user_id === "both" && r.role === "ESTIMATOR"), 1);
    expect(await scopeOf("both")).toBe("ASSIGNED");
  });
  it("Projects data: org-wide roles and explicit Project Manager / Procurement may use it; a Rep may not while isolation is ON (and everyone may while it is OFF)", async () => {
    who("pm", "pm@nq.test", "member", ["PROJECT_MANAGER"]); who("proc", "proc@nq.test", "member", ["PROCUREMENT"]);
    const ok = async (u: string) => projectsAllowed(db as never, { orgId: ORG, userId: u, email: people[u].email, tier: people[u].tier === "member" ? "member" : "admin" });
    for (const u of ["adm", "est", "mgr", "pm", "proc"]) expect(await ok(u), u).toBe(true);
    for (const u of ["repA", "plain", "sysadm"]) expect(await ok(u), u).toBe(false);
    isolate(false); for (const u of ["repA", "plain"]) expect(await ok(u), `${u} (OFF)`).toBe(true);
  });
  it("canSeeQuote never grants beyond the assignment: ownership alone is not access once a customer is chosen", async () => {
    await assign("repB", C2);
    const scope = await quoteScope(db as never, { orgId: ORG, userId: "repA", email: "a@nq.test", tier: "member" });
    quote("q9", C2, { creator: "a@nq.test" });   // created by Rep A for a customer assigned only to Rep B
    expect(await canSeeQuote(db as never, scope, "q9")).toBe(false);
  });
});

describe("owner-gated activation and the read-only preflight", () => {
  it("only an organisation admin can read the preflight or change the switch; a Manager, Estimator, Rep and Demo Mode cannot", async () => {
    db.accessApplied = true;
    for (const u of ["mgr", "est", "repA", "plain"]) { as(u); expect((await isolation.getRepIsolationStatusAction()).ok, u).toBe(false); expect((await isolation.setRepIsolationAction({ enabled: true, reason: "because", confirmation: "ENABLE REP ISOLATION" })).ok, u).toBe(false); }
    as("adm", "repA"); expect((await isolation.setRepIsolationAction({ enabled: true, reason: "because", confirmation: "ENABLE REP ISOLATION" })).ok).toBe(false);
    expect(db.rows("newquip_access_settings")).toHaveLength(0);
  });
  it("the preflight reports unassigned customers and who becomes assigned-scoped, writes nothing, and enabling needs the typed confirmation, a reason and no blockers", async () => {
    db.accessApplied = true; await assign("repA", C1);
    as("adm"); db.writes.length = 0;
    const s = await isolation.getRepIsolationStatusAction(); expect(s.ok, s.error).toBe(true);
    expect(db.writes).toEqual([]);                                                       // read-only
    expect(s.data!.enabled).toBe(false); expect(s.data!.blockers).toEqual([]);
    expect(s.data!.unassignedCustomers.map((c) => c.cin7CustomerId).sort()).toEqual([C2, C3].sort());
    const a = s.data!.assignedScopedPeople.find((p) => p.email === "a@nq.test")!; expect(a.assignedCustomers).toBe(1); expect(a.visibleQuotations).toBe(1); expect(a.ownCustomerlessDrafts).toBe(1);
    expect(s.data!.assignedScopedPeople.find((p) => p.email === "plain@nq.test")!.usesTierDefaultRoles).toBe(true);
    expect((await isolation.setRepIsolationAction({ enabled: true, reason: "go", confirmation: "ENABLE REP ISOLATION" })).error).toMatch(/reason/);
    expect((await isolation.setRepIsolationAction({ enabled: true, reason: "owner approved", confirmation: "yes" })).error).toMatch(/Type "ENABLE REP ISOLATION"/);
    expect(db.rows("newquip_access_settings")).toHaveLength(0);
    const on = await isolation.setRepIsolationAction({ enabled: true, reason: "owner approved enforcement", confirmation: "ENABLE REP ISOLATION" });
    expect(on, JSON.stringify(on)).toMatchObject({ ok: true, data: { enabled: true } });
    expect(db.rows("newquip_access_setting_events")).toHaveLength(1);
    expect(db.rows("newquip_access_setting_events")[0]).toMatchObject({ enabled: true, actor_email: "adm@nq.test", reason: "owner approved enforcement" });
    expect((db.rows("newquip_access_setting_events")[0].preflight as { unassignedCustomers: unknown[] }).unassignedCustomers).toHaveLength(2);
    expect(await ids("repA")).toEqual(["q1", "q4"]);                                     // and it now bites
    as("adm"); const off = await isolation.setRepIsolationAction({ enabled: false, reason: "rolled back for testing" }); expect(off.ok, off.error).toBe(true); expect(off.data!.enabled).toBe(false);
    expect((await ids("repA")).length).toBe(5);
  });
  it("enabling is refused by the preflight's blockers: nobody would keep organisation-wide access (the caller is admin by session, but holds no org_members row here)", async () => {
    db.accessApplied = true; as("adm");
    const rows = db.rows("org_members"); for (const keep of rows.filter((r) => ["adm", "est", "mgr"].includes(r.user_id as string))) rows.splice(rows.indexOf(keep), 1);
    db.rows("org_functional_roles").length = 0;
    const s = await isolation.getRepIsolationStatusAction(); expect(s.data!.blockers.join(" ")).toMatch(/Nobody would have organisation-wide access/);
    const on = await isolation.setRepIsolationAction({ enabled: true, reason: "owner approved", confirmation: "ENABLE REP ISOLATION" });
    expect(on.ok).toBe(false); expect(on.error).toMatch(/cannot be enabled yet/);
    expect(db.rows("newquip_access_settings")).toHaveLength(0); expect(db.rows("newquip_access_setting_events")).toHaveLength(0);
  });
  it("enabling is refused when the switch or the assignments are not installed, or nobody would keep organisation-wide access", async () => {
    as("adm");
    expect((await isolation.setRepIsolationAction({ enabled: true, reason: "owner approved", confirmation: "ENABLE REP ISOLATION" })).error).toMatch(/not available/);   // 0119 absent
    db.accessApplied = true; db.assignmentsApplied = false;
    expect((await isolation.setRepIsolationAction({ enabled: true, reason: "owner approved", confirmation: "ENABLE REP ISOLATION" })).error).toMatch(/not available/);
    expect(db.rows("newquip_access_settings")).toHaveLength(0);
  });
});

describe("independent-review fixes", () => {
  beforeEach(() => { isolate(true); });

  it("CLEARING a customer does not hand the quotation back to its creator (only a quotation that NEVER had a customer is the creator's own enquiry)", async () => {
    await assign("repA", C1);
    quote("q10", C1, { creator: "a@nq.test" });                            // created by Rep A for customer 1
    await reassignCustomer(db as never, ORG, { email: "adm@nq.test" }, { cin7CustomerId: C1, customerName: "Farm", fromRepUserId: "repA", toRepUserId: "repB", toRepEmail: people.repB.email, reason: "territory change" });
    expect(await ids("repA")).toEqual(["q4"]);
    await appendClearMarker(db as never, ORG, "q10", { email: "b@nq.test" }, "Customer cleared (was Farm)");   // Rep B clears the customer
    expect(await ids("repA")).toEqual(["q4"]);                                                                  // Rep A does NOT regain q10 (nor its history)
    expect(await ids("repB")).not.toContain("q10");
    as("repA"); expect((await grower.getGrowerQuoteAction("q10")).error).toBe(GENERIC);
    expect((await customers.getQuoteCustomerAction("q10")).error).toBe(GENERIC);                              // the old customer's name/contacts in the history stay hidden
    expect(await ids("adm")).toContain("q10");                                                                   // organisation-wide roles still see it
    expect(await ids("repA")).toContain("q4");                                                                   // a draft that never had a customer is still the creator's
  });

  it("e-mail is decided when it LEAVES: a previous Rep, or anyone unassigned, is not mailed about a customer they cannot see; the current Rep, org-wide users and non-users are", async () => {
    await assign("repB", C1);                                               // customer 1 now belongs to Rep B (Rep A was reassigned away earlier)
    const mail = (id: string, to: string) => db.rows("approval_notifications").push({ id, org_id: ORG, request_id: null, quote_id: "q1", kind: "RESPONSE", recipient_email: to, channel: "EMAIL", subject: "S", body: "Customer: Farm", dedupe_key: id, status: "PENDING", attempts: 0, last_error: null, provider_message_id: null, sent_at: null, read_at: null, created_at: "2026-10-01T00:00:00Z" });
    mail("m-prev", "a@nq.test"); mail("m-cur", "b@nq.test"); mail("m-est", "est@nq.test"); mail("m-adm", "adm@nq.test"); mail("m-plain", "plain@nq.test"); mail("m-ext", "escalation@external.example");
    db.notificationStatuses.push("SUPPRESSED");
    const send = vi.fn(async (_i: unknown) => ({ ok: true, messageId: "m" }));
    await deliverPendingEmails(db as never, send as never, 50, { env: { VERCEL_ENV: "production", NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true" } });
    const sentTo = send.mock.calls.map((c) => (c[0] as { to: string[] }).to[0]).sort();
    expect(sentTo).toEqual(["adm@nq.test", "b@nq.test", "escalation@external.example", "est@nq.test"]);
    const st = (id: string) => (db.rows("approval_notifications").find((r) => r.id === id) as Record<string, unknown>);
    expect(st("m-prev").status).toBe("SUPPRESSED"); expect(st("m-plain").status).toBe("SUPPRESSED");
    expect(String(st("m-prev").last_error)).toMatch(/customer isolation/);
    // switch OFF: unchanged behaviour, everyone is mailed
    db.rows("newquip_access_settings")[0].rep_isolation_enabled = false; send.mockClear(); mail("m-prev2", "a@nq.test");
    await deliverPendingEmails(db as never, send as never, 50, { env: { VERCEL_ENV: "production", NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true" } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("only 'the settings TABLE is not installed' means OFF; a renamed column, a missing function or a connection error never silently turns isolation off", async () => {
    const real = db.from.bind(db);
    const failWith = (error: Record<string, string>) => { (db as unknown as { from: unknown }).from = (t: string) => t === "newquip_access_settings" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error }) }) }) } : real(t); };
    as("repA");
    failWith({ message: 'column "rep_isolation_enabled" does not exist' }); expect((await grower.listGrowerQuotesAction()).error).toBe("Access settings are unavailable.");
    failWith({ message: 'function public.is_org_admin(uuid) does not exist' }); expect((await grower.listGrowerQuotesAction()).error).toBe("Access settings are unavailable.");
    failWith({ message: "connection reset" }); expect((await grower.listGrowerQuotesAction()).error).toBe("Access settings are unavailable.");
    failWith({ code: "PGRST205", message: "Could not find the table 'public.newquip_access_settings' in the schema cache" }); expect((await grower.listGrowerQuotesAction()).ok).toBe(true);
    failWith({ code: "42P01", message: 'relation "public.newquip_access_settings" does not exist' }); expect((await grower.listGrowerQuotesAction()).ok).toBe(true);
  });

  it("explicit Project Manager / Procurement keep claim and variation approvals and projects.* activity (but not quotation approvals or NewQuip activity); a Rep keeps neither", async () => {
    who("pm", "pm@nq.test", "member", ["PROJECT_MANAGER"]);
    const reqRow = (id: string, doc_type: string, doc_id: string) => ({ id, org_id: ORG, doc_type, doc_id, doc_ref: doc_id, revision: 1, status: "PENDING", stage: "MANAGER", stage_role: "MANAGER", digest: "d", version: 1, amount_cents: 1, prepared_by_email: "p@nq.test", submitted_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
    db.rows("approval_requests").push(reqRow("r3", "QUOTE", "q3"), reqRow("rc", "CLAIM", "claim-1"), reqRow("rv", "VARIATION", "var-1"));
    const row = (action: string) => ({ id: `a-${action}`, org_id: ORG, instance_id: null, actor_email: "x@nq.test", action, summary: action, detail: null, created_at: "2026-10-01T00:00:00Z" });
    db.rows("activity_log").push(row("newquip.quote_created"), row("approvals.decided"), row("projects.claim_approved"), row("sync.completed"));
    as("pm");
    expect((await approvals.getApprovalsDashboardAction()).data!.rows.map((r) => r.id).sort()).toEqual(["rc", "rv"]);
    expect((await approvals.getApprovalDetailAction("rc")).error).not.toBe("Approval request not found.");
    expect((await approvals.getApprovalDetailAction("r3")).error).toBe("Approval request not found.");
    expect((await activity.listActivityAction()).data!.map((r) => r.action).sort()).toEqual(["projects.claim_approved", "sync.completed"]);
    as("repA"); expect((await approvals.getApprovalsDashboardAction()).data!.rows).toEqual([]);
    expect((await activity.listActivityAction()).data!.map((r) => r.action)).toEqual(["sync.completed"]);
  });

  it("approval requests follow the same rule for a cleared quotation (hidden) and a never-customered own draft (visible); unattributable mail to an assigned-scoped user is withheld", async () => {
    await assign("repA", C1); quote("q10", C1, { creator: "a@nq.test" });
    await appendClearMarker(db as never, ORG, "q10", { email: "a@nq.test" }, "Customer cleared (was Farm)");
    const reqRow = (id: string, doc_id: string) => ({ id, org_id: ORG, doc_type: "QUOTE", doc_id, doc_ref: doc_id, revision: 1, status: "PENDING", stage: "MANAGER", stage_role: "MANAGER", digest: "d", version: 1, amount_cents: 1, prepared_by_email: "p@nq.test", submitted_at: "t", created_at: "t", updated_at: "t" });
    db.rows("approval_requests").push(reqRow("r4", "q4"), reqRow("r10", "q10"));
    as("repA"); expect((await approvals.getApprovalsDashboardAction()).data!.rows.map((r) => r.id)).toEqual(["r4"]);
    const mail = (id: string, to: string, request_id: string | null, quote_id: string | null) => db.rows("approval_notifications").push({ id, org_id: ORG, request_id, quote_id, kind: "X", recipient_email: to, channel: "EMAIL", subject: "S", body: "b", dedupe_key: id, status: "PENDING", attempts: 0, last_error: null, provider_message_id: null, sent_at: null, read_at: null, created_at: "t" });
    mail("m-orphan", "plain@nq.test", null, null); mail("m-ok", "a@nq.test", "r4", null); mail("m-cleared", "a@nq.test", "r10", null);
    db.notificationStatuses.push("SUPPRESSED"); const send = vi.fn(async (_i: unknown) => ({ ok: true, messageId: "m" }));
    await deliverPendingEmails(db as never, send as never, 50, { env: { VERCEL_ENV: "production", NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true" } });
    expect(send.mock.calls.map((c) => (c[0] as { to: string[] }).to[0])).toEqual(["a@nq.test"]);   // only the one for the own never-customered draft
  });

  it("marking notifications read touches only the rows the actor can see", async () => {
    await assign("repA", C1);
    const reqRow = (id: string, doc_id: string) => ({ id, org_id: ORG, doc_type: "QUOTE", doc_id, doc_ref: doc_id, revision: 1, status: "PENDING", stage: "MANAGER", stage_role: "MANAGER", digest: "d", version: 1, amount_cents: 1, prepared_by_email: "p@nq.test", submitted_at: "t", created_at: "t", updated_at: "t" });
    db.rows("approval_requests").push(reqRow("r1", "q1"), reqRow("r3", "q3"));
    const note = (id: string, request_id: string) => ({ id, org_id: ORG, request_id, quote_id: null, kind: "SUBMITTED", recipient_email: "a@nq.test", channel: "IN_APP", subject: "s", body: "b", dedupe_key: id, status: "SENT", attempts: 0, last_error: null, provider_message_id: null, sent_at: "t", read_at: null, created_at: "2026-10-01T00:00:00Z" });
    db.rows("approval_notifications").push(note("n1", "r1"), note("n3", "r3"));
    as("repA"); const r = await approvals.getMyNotificationsAction(true); expect(r.ok, r.error).toBe(true);
    const readAt = (id: string) => (db.rows("approval_notifications").find((x) => x.id === id) as Record<string, unknown>).read_at;
    expect(readAt("n1")).toBeTruthy(); expect(readAt("n3")).toBeNull();
    expect(r.data!.notifications.map((n) => n.id)).toEqual(["n1"]); expect(r.data!.unread).toBe(0);
  });
});
