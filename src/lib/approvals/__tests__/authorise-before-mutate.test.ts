// UX-006 owner correction (D-3): an UNAUTHORISED, FORBIDDEN or INVALID approval decision must cause ABSOLUTELY NO database change. Role, organisation, separation of
// duties, stage and action checks run BEFORE any supersession, re-opening, creation or audit attribution. Driven through the REAL approval + quote stores over the
// in-memory twin of the 0112 functions; every table is snapshotted before and after the refused attempt and must be deep-equal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { installStaged } from "./staged-emulator";
import { goldenFixtureBaseline } from "@/lib/projects/baseline";
import { seedGoldenFixture, createClaimDraft, submitClaimForApproval } from "@/lib/projects/project-store";
import { raiseVariation } from "@/lib/projects/variation-store";

vi.mock("server-only", () => ({}));
import { decide, decideDocument, docHistory, pendingRequestFor, resyncQuoteApprovals, type ApprovalCtx } from "../approval-store";

const ORG = "org-nq";
const ctxOf = (userId: string, email: string, adminTier = false, orgId = ORG): ApprovalCtx => ({ orgId, userId, email, name: email, isManager: adminTier, baseUrl: "https://toolbox.example" });
const REP = ctxOf("u-rep", "rep@a"), EST = ctxOf("u-est", "est@a"), MGR = ctxOf("u-mgr", "mgr@a", true), ADM = ctxOf("u-adm", "adm@a", true);
const OWNER_NO_ROLE = ctxOf("u-own", "own@a", true);
const OTHER_ORG = ctxOf("u-x", "x@other", true, "org-other");
const EMAILS: Record<string, string> = { "u-rep": "rep@a", "u-est": "est@a", "u-mgr": "mgr@a", "u-adm": "adm@a", "u-own": "own@a" };
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
// Authorisation tests, not costing tests: the sign-off/approval costing gate (S1a) is covered in rep-handoff.test.ts, so this fixture records the accepted-incomplete-costing exception like the other workflow fixtures.
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);

function world() {
  const db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG);
  db.approvalsApplied = true; db.rolesApplied = true;
  installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push(
    { org_id: ORG, user_id: "u-rep", role: "member" }, { org_id: ORG, user_id: "u-est", role: "member" }, { org_id: ORG, user_id: "u-mgr", role: "admin" },
    { org_id: ORG, user_id: "u-adm", role: "admin" }, { org_id: ORG, user_id: "u-own", role: "owner" }, { org_id: "org-other", user_id: "u-x", role: "owner" },
  );
  const grant = (user: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${user}-${role}`, org_id: ORG, user_id: user, user_email: EMAILS[user], role, assigned_by_email: "adm@a", assigned_at: "t" });
  grant("u-rep", "REP"); grant("u-est", "ESTIMATOR"); grant("u-mgr", "MANAGER"); grant("u-adm", "ADMINISTRATOR");
  db.rows("approval_settings").push({ org_id: ORG, roles_enforced: true }); // strict: an owner/admin with no assignment holds NO role
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft, draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
  return db;
}
const quote = (db: FakeDb) => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Every table, plus the count of write operations and mutating RPC calls: nothing may differ after a refused attempt. */
function snapshot(db: FakeDb) {
  return { tables: nonEmpty(db), writes: db.writes.length };
}
/** Reading a table makes the fake create an empty one; that is not a database change. */
const nonEmpty = (db: FakeDb) => Object.fromEntries(Object.entries(structuredClone(db.tables)).filter(([, rows]) => rows.length > 0));
/** Counts every RPC (the engine's mutating entry points) so a mutation that is rolled back in the twin still shows up. */
function watchRpc(db: FakeDb) {
  const calls: string[] = [];
  const orig = (db as any).rpc.bind(db); // eslint-disable-line @typescript-eslint/no-explicit-any
  (db as any).rpc = (fn: string, a: unknown) => { calls.push(fn); return orig(fn, a); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return calls;
}
/** The Estimator edited after the Rep submitted: the open request's digest no longer matches the current content. */
const estimatorEdits = (db: FakeDb) => { quote(db).draft_hash = "h2"; };

type Scenario = { name: string; actor: ApprovalCtx; action: "APPROVE" | "RETURN" | "REJECT"; stage?: "ESTIMATOR" | "MANAGER"; input?: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null }; error: RegExp };
const estimatorStageRefusals: Scenario[] = [
  { name: "the Rep signs off", actor: REP, action: "APPROVE", stage: "ESTIMATOR", error: /estimator role/ },
  { name: "the Rep returns", actor: REP, action: "RETURN", stage: "ESTIMATOR", input: { reason: "send it back please" }, error: /estimator role/ },
  { name: "the Rep rejects", actor: REP, action: "REJECT", stage: "ESTIMATOR", input: { reason: "not wanted" }, error: /estimator role/ },
  { name: "a Manager (no Estimator role) signs off the ESTIMATOR stage", actor: MGR, action: "APPROVE", stage: "ESTIMATOR", error: /estimator role/ },
  { name: "an Administrator with no Estimator role signs off without an override", actor: ADM, action: "APPROVE", stage: "ESTIMATOR", error: /explicit override/ },
  { name: "an Administrator override with too short a reason", actor: ADM, action: "APPROVE", stage: "ESTIMATOR", input: { override: true, reason: "short" }, error: /written reason/ },
  { name: "an organisation owner who holds no functional role", actor: OWNER_NO_ROLE, action: "APPROVE", stage: "ESTIMATOR", error: /estimator role/ },
  { name: "a user from ANOTHER organisation", actor: OTHER_ORG, action: "APPROVE", stage: "ESTIMATOR", error: /not found|not waiting/ },
  { name: "the Estimator returns with no written reason", actor: EST, action: "RETURN", stage: "ESTIMATOR", input: { reason: "" }, error: /written reason/ },
  { name: "a stage mismatch (Manager approves while the Estimator stage is open)", actor: MGR, action: "APPROVE", stage: "MANAGER", error: /waiting for estimator review, not manager approval/ },
  { name: "the Estimator tries to approve the MANAGER stage while the Estimator stage is open", actor: EST, action: "APPROVE", stage: "MANAGER", error: /waiting for estimator review, not manager approval/ },
];

describe("an unauthorised decision on the ESTIMATOR stage changes nothing", () => {
  for (const variant of ["current digest", "stale digest (the Estimator edited after the Rep submitted)"] as const) {
    describe(variant, () => {
      for (const s of estimatorStageRefusals) {
        it(`${s.name}: refused, and every table is byte-identical afterwards`, async () => {
          const db = world();
          await resyncQuoteApprovals(db as never, REP, "q1"); // the Rep submitted: an ESTIMATOR request is open
          if (variant !== "current digest") estimatorEdits(db);
          const calls = watchRpc(db);
          const before = snapshot(db);
          await expect(decideDocument(db as never, s.actor, "QUOTE", "q1", s.action, { ...(s.input ?? {}), ...(s.stage ? { stage: s.stage } : {}) })).rejects.toThrow(s.error);
          expect(nonEmpty(db)).toEqual(before.tables);
          expect(db.writes.length).toBe(before.writes);
          expect(calls.filter((c) => /submit|decide|reassign/.test(c))).toEqual([]); // not a single mutating database function was called
        });
      }
    });
  }

  it("the reproduced defect: the Rep replaying the Estimator sign-off after the Estimator edited writes no SUPERSEDED/RESUBMITTED event and no new request", async () => {
    const db = world();
    const opened = (await resyncQuoteApprovals(db as never, REP, "q1"))!;
    estimatorEdits(db);
    const events = (await docHistory(db as never, ORG, "QUOTE", "q1")).length;
    const res = await decideDocument(db as never, REP, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" }).then(() => "ok", (e: Error) => e.message);
    expect(res).toBe("Approval at this stage needs the estimator role.");
    expect((await docHistory(db as never, ORG, "QUOTE", "q1")).length).toBe(events);
    expect(db.rows("approval_requests")).toHaveLength(1);
    expect((await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!).toMatchObject({ id: opened.id, status: "PENDING", version: opened.version, digest: opened.digest });
  });

  it("separation of duties is judged against the request that WOULD be re-opened: an Estimator who became the originator since the request opened is refused before anything is superseded", async () => {
    const db = world();
    await resyncQuoteApprovals(db as never, REP, "q1");
    estimatorEdits(db); quote(db).handoff_by_email = "est@a"; // the open request still names the Rep; the current content was handed off by the Estimator
    const before = snapshot(db);
    await expect(decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" })).rejects.toThrow(/prepared or originated/);
    expect(nonEmpty(db)).toEqual(before.tables);
  });

  it("the OPEN request is judged too (kills 'drop check(open)'): an Estimator who originated the content when the request opened is refused even if the re-opened content is no longer theirs", async () => {
    const db = world();
    quote(db).handoff_by_email = "est@a"; // the Estimator handed it off, so the request that opens names them as preparer AND originator
    await resyncQuoteApprovals(db as never, EST, "q1");
    quote(db).handoff_by_email = "rep@a"; estimatorEdits(db); // later the Rep owns the content and it moved on: the re-opened request alone would look innocent
    const before = snapshot(db);
    await expect(decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" })).rejects.toThrow(/prepared or originated/);
    expect(nonEmpty(db)).toEqual(before.tables);
  });

  it("an already-decided request cannot be decided again, and a refused retry changes nothing", async () => {
    const db = world();
    const est = (await resyncQuoteApprovals(db as never, REP, "q1"))!;
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const before = snapshot(db);
    await expect(decide(db as never, EST, est.id, "APPROVE", { expectedVersion: est.version, expectedDigest: est.digest })).rejects.toThrow(/already/);
    await expect(decide(db as never, REP, est.id, "APPROVE", { expectedVersion: est.version, expectedDigest: est.digest })).rejects.toThrow(/already/);
    expect(nonEmpty(db)).toEqual(before.tables);
  });
});

describe("an unauthorised decision with NO open request creates nothing", () => {
  for (const s of estimatorStageRefusals.filter((x) => x.stage !== "MANAGER" || x.actor === MGR)) {
    it(`${s.name}: no request is created on a decision attempt`, async () => {
      const db = world(); // confirmed, in estimator review, but nobody has opened the request
      const calls = watchRpc(db);
      const before = snapshot(db);
      await expect(decideDocument(db as never, s.actor, "QUOTE", "q1", s.action, { ...(s.input ?? {}), ...(s.stage ? { stage: s.stage } : {}) })).rejects.toThrow();
      expect(nonEmpty(db)).toEqual(before.tables);
      expect(db.rows("approval_requests")).toHaveLength(0);
      expect(db.rows("approval_events")).toHaveLength(0);
      expect(db.rows("approval_notifications")).toHaveLength(0);
      expect(calls.filter((c) => /submit|decide|reassign/.test(c))).toEqual([]);
    });
  }

  it("a quotation that is not in review (returned to the Rep) cannot be decided and nothing is written", async () => {
    const db = world(); quote(db).state = "REP_DRAFT";
    const before = snapshot(db);
    await expect(decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" })).rejects.toThrow();
    expect(nonEmpty(db)).toEqual(before.tables);
  });
});

describe("an unauthorised decision on the MANAGER stage changes nothing", () => {
  async function toManagerStage() {
    const db = world();
    await resyncQuoteApprovals(db as never, REP, "q1");
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    return db;
  }
  const refusals: Scenario[] = [
    { name: "the Estimator approves the MANAGER stage", actor: EST, action: "APPROVE", stage: "MANAGER", error: /manager role/ },
    { name: "the Rep approves the MANAGER stage", actor: REP, action: "APPROVE", stage: "MANAGER", error: /manager role/ },
    { name: "an organisation owner with no functional role", actor: OWNER_NO_ROLE, action: "APPROVE", stage: "MANAGER", error: /explicit override/ },
    { name: "the Estimator returns the MANAGER stage", actor: EST, action: "RETURN", stage: "MANAGER", input: { reason: "I do not like it" }, error: /manager role/ },
    { name: "another organisation", actor: OTHER_ORG, action: "APPROVE", stage: "MANAGER", error: /not found|not waiting/ },
    { name: "a stage mismatch (the Estimator stage is asked for while the Manager stage is open)", actor: EST, action: "APPROVE", stage: "ESTIMATOR", error: /waiting for manager approval, not estimator review/ },
  ];
  for (const variant of ["current digest", "stale digest"] as const) {
    for (const s of refusals) {
      it(`${variant}: ${s.name}`, async () => {
        const db = await toManagerStage();
        if (variant === "stale digest") estimatorEdits(db); // the content changed after the Manager request opened
        const before = snapshot(db);
        await expect(decideDocument(db as never, s.actor, "QUOTE", "q1", s.action, { ...(s.input ?? {}), ...(s.stage ? { stage: s.stage } : {}) })).rejects.toThrow(s.error);
        expect(nonEmpty(db)).toEqual(before.tables);
      });
    }
  }
});

describe("the authorised path is unchanged", () => {
  it("the Estimator signing off after editing re-opens the request on the CURRENT content (attributed as before), then opens the Manager stage", async () => {
    const db = world();
    const first = (await resyncQuoteApprovals(db as never, REP, "q1"))!;
    estimatorEdits(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const h = await docHistory(db as never, ORG, "QUOTE", "q1");
    expect(h.map((e) => `${e.stage}:${e.action}:${e.actor_email}`)).toEqual([
      "ESTIMATOR:SUBMITTED:rep@a", "ESTIMATOR:SUPERSEDED:est@a", "ESTIMATOR:RESUBMITTED:est@a", "ESTIMATOR:APPROVED:est@a", "MANAGER:SUBMITTED:est@a",
    ]);
    expect(h[1]!.reason).toBe("The document changed and was submitted again.");
    const all = db.rows("approval_requests") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(all.find((r) => r.id === first.id)).toMatchObject({ status: "SUPERSEDED" });
    expect(quote(db)).toMatchObject({ estimator_signoff_by_email: "est@a", estimator_signoff_hash: "h2" });
    expect(await pendingRequestFor(db as never, ORG, "QUOTE", "q1")).toMatchObject({ stage: "MANAGER" });
  });

  it("with no open request an authorised Estimator still has the request opened (as the preparer) and signs off", async () => {
    const db = world();
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    expect(quote(db).estimator_signoff_by_email).toBe("est@a");
    expect(await pendingRequestFor(db as never, ORG, "QUOTE", "q1")).toMatchObject({ stage: "MANAGER" });
  });
});

describe("staged claims and variations with NO open request: an unauthorised decision changes nothing", () => {
  async function stagedProjectWorld() {
    const db = new FakeDb();
    db.approvalsApplied = true; db.rolesApplied = true;
    installStaged(db);
    (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    db.rows("org_members").push({ org_id: ORG, user_id: "u-rep", role: "member" }, { org_id: ORG, user_id: "u-mgr", role: "admin" }, { org_id: ORG, user_id: "u-adm", role: "admin" });
    const grant = (user: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${user}-${role}`, org_id: ORG, user_id: user, user_email: EMAILS[user], role, assigned_by_email: "adm@a", assigned_at: "t" });
    grant("u-rep", "REP"); grant("u-mgr", "MANAGER"); grant("u-adm", "ADMINISTRATOR");
    db.rows("approval_settings").push({ org_id: ORG, roles_enforced: true });
    const projectId = await seedGoldenFixture(db as never, ORG, "seed@a", goldenFixtureBaseline());
    return { db, projectId };
  }
  async function docs(db: FakeDb, projectId: string, preparer: string) {
    const d = await createClaimDraft(db as never, ORG, preparer, projectId); await submitClaimForApproval(db as never, ORG, projectId, d.claimId);
    const v = await raiseVariation(db as never, ORG, preparer, { projectId, title: "V1", description: "extra", amountCents: 100_000_00 });
    return { CLAIM: d.claimId, VARIATION: v.variationId };
  }
  for (const docType of ["CLAIM", "VARIATION"] as const) {
    it(`${docType}: a Rep, an Administrator with no override, and another organisation are refused; nothing is written`, async () => {
      const { db, projectId } = await stagedProjectWorld();
      const id = (await docs(db, projectId, "rep@a"))[docType];
      const calls = watchRpc(db);
      const before = snapshot(db);
      for (const actor of [REP, ADM, OTHER_ORG]) await expect(decideDocument(db as never, actor, docType, id, "APPROVE")).rejects.toThrow();
      await expect(decideDocument(db as never, REP, docType, id, "REJECT", { reason: "no thanks" })).rejects.toThrow();
      expect(nonEmpty(db)).toEqual(before.tables);
      expect(db.writes.length).toBe(before.writes);
      expect(calls.filter((c) => /submit|decide|reassign/.test(c))).toEqual([]);
      expect(db.rows("approval_requests")).toHaveLength(0);
    });
    it(`${docType}: the manager who prepared it, approving without an override, is refused before anything is submitted`, async () => {
      const { db, projectId } = await stagedProjectWorld();
      const id = (await docs(db, projectId, "mgr@a"))[docType];
      const before = snapshot(db);
      await expect(decideDocument(db as never, MGR, docType, id, "APPROVE")).rejects.toThrow(/prepared or originated/);
      expect(nonEmpty(db)).toEqual(before.tables);
      expect(db.rows("approval_requests")).toHaveLength(0);
    });
  }
});

beforeEach(() => vi.useRealTimers());
