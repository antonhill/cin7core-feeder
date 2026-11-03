import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { effectiveRoles, toQuoteRoles, type FunctionalRole } from "../roles";
import { authoriseStageDecision } from "../policy";
import { authoriseTransition, canEditDraft, QUOTE_STATES, type QuoteAction } from "@/newquip/quote/workflow";
import { hasAny, PROJECT_CREATE_ROLES, VARIATION_APPROVE_ROLES, type QuoteRole } from "@/newquip/quote/roles";

vi.mock("server-only", () => ({}));
import { canSeeCosts, resolveRoles } from "../role-store";

// UX-006h: the capability of the four NewQuip POC accounts (each ONE explicit functional role), derived from the pure role functions and the real role store.
// NOTE: the PURE workflow table (workflow.ts) lists RETURN_TO_REP for estimator AND manager; the STAGED policy (policy.ts, used on the hosted org) is stricter and lets only the
// stage's own role return (a Manager-only account is refused at estimator review). Both are asserted: the table here, the staged policy below and in single-role-authz.test.ts.
// This is the single source of the UAT capability matrix in docs/newquip-uat-multirole-procedure.md.

const ORG = "org";
type Acct = { name: string; fn: FunctionalRole; adminTier: boolean; quote: QuoteRole[]; cost: boolean };
const ACCOUNTS: Acct[] = [
  { name: "ADMINISTRATOR (org owner)", fn: "ADMINISTRATOR", adminTier: true, quote: [], cost: true },
  { name: "REP (member)", fn: "REP", adminTier: false, quote: ["rep"], cost: false },
  { name: "ESTIMATOR (member)", fn: "ESTIMATOR", adminTier: false, quote: ["estimator"], cost: true },
  { name: "MANAGER (member)", fn: "MANAGER", adminTier: false, quote: ["manager"], cost: true },
];

describe("effectiveRoles / toQuoteRoles / canSeeCosts for the four-account shape", () => {
  it.each(ACCOUNTS)("$name: quote roles $quote, cost visible: $cost", async (a) => {
    const db = new FakeDb(); db.rolesApplied = true;
    db.rows("org_functional_roles").push({ id: "r", org_id: ORG, user_id: "u", user_email: "x", role: a.fn, assigned_by_email: "o", assigned_at: "t" });
    // one explicit assignment: ONLY that role (+ ADMINISTRATOR for the admin tier), strict mode irrelevant
    for (const strict of [false, true]) {
      const eff = effectiveRoles([a.fn], a.adminTier, strict);
      expect([...eff].sort()).toEqual([...new Set<FunctionalRole>([a.fn, ...(a.adminTier ? ["ADMINISTRATOR" as const] : [])])].sort());
      expect([...toQuoteRoles(eff)].sort()).toEqual([...a.quote].sort());
    }
    expect([...toQuoteRoles(await resolveRoles(db as never, ORG, "u", a.adminTier))].sort()).toEqual([...a.quote].sort());
    expect(await canSeeCosts(db as never, ORG, "u", a.adminTier)).toBe(a.cost);
  });
  it("ADMINISTRATOR maps to NO quote role: toQuoteRoles ignores it, so it can never edit, send, sign off, approve or create a project by itself", () => {
    expect(toQuoteRoles(new Set<FunctionalRole>(["ADMINISTRATOR"])).size).toBe(0);
    expect(toQuoteRoles(new Set<FunctionalRole>(["PROJECT_MANAGER", "PROCUREMENT", "ADMINISTRATOR"])).size).toBe(0);
  });
  it("contrast: an admin with no assignment holds every quote role; a member with none holds rep + estimator (and no cost)", async () => {
    expect([...toQuoteRoles(effectiveRoles([], true, false))].sort()).toEqual(["estimator", "manager", "rep"]);
    expect([...toQuoteRoles(effectiveRoles([], false, false))].sort()).toEqual(["estimator", "rep"]);
    expect(toQuoteRoles(effectiveRoles([], false, true)).size).toBe(0);
    const db = new FakeDb(); db.rolesApplied = true;
    expect(await canSeeCosts(db as never, ORG, "u", false)).toBe(false);
  });
  it("a Rep-only user is cost-blind even with other non-cost roles", async () => {
    const db = new FakeDb(); db.rolesApplied = true;
    for (const fn of ["REP", "PROJECT_MANAGER", "PROCUREMENT", "ADMINISTRATOR"]) db.rows("org_functional_roles").push({ id: fn, org_id: ORG, user_id: "u", user_email: "x", role: fn, assigned_by_email: "o", assigned_at: "t" });
    expect(await canSeeCosts(db as never, ORG, "u", false)).toBe(false);
  });
});

describe("workflow transition x single-role matrix (pure)", () => {
  const ACTIONS: Array<[QuoteAction, "REP_DRAFT" | "ESTIMATOR_REVIEW", QuoteRole[]]> = [
    ["SEND_TO_ESTIMATOR", "REP_DRAFT", ["rep"]], ["ESTIMATOR_SIGN_OFF", "ESTIMATOR_REVIEW", ["estimator"]], ["RETURN_TO_REP", "ESTIMATOR_REVIEW", ["estimator", "manager"]],
    ["MANAGER_APPROVE", "ESTIMATOR_REVIEW", ["manager"]], ["RETURN_TO_ESTIMATOR", "ESTIMATOR_REVIEW", ["manager"]],
  ];
  it.each(ACTIONS)("%s from %s is allowed for exactly %j and refused for every other single role (and for no role)", (action, from, allowed) => {
    for (const r of ["rep", "estimator", "manager"] as QuoteRole[]) expect(authoriseTransition(new Set([r]), from, action).ok).toBe(allowed.includes(r));
    expect(authoriseTransition(new Set<QuoteRole>(), from, action).ok).toBe(false); // the ADMINISTRATOR-only owner
  });
  it("no single role, and no role-less account, can change an approved quotation", () => {
    for (const roles of [[], ["rep"], ["estimator"], ["manager"]] as QuoteRole[][]) {
      expect(canEditDraft(new Set(roles), "MANAGER_APPROVED_FINAL")).toBe(false);
      for (const [action] of ACTIONS) expect(authoriseTransition(new Set(roles), "MANAGER_APPROVED_FINAL", action).ok).toBe(false);
    }
  });
  it("editing: Rep and Estimator only (a Manager-only or role-less account cannot edit a draft)", () => {
    for (const s of QUOTE_STATES.filter((x) => x !== "MANAGER_APPROVED_FINAL")) {
      expect([canEditDraft(new Set<QuoteRole>(["rep"]), s), canEditDraft(new Set<QuoteRole>(["estimator"]), s), canEditDraft(new Set<QuoteRole>(["manager"]), s), canEditDraft(new Set<QuoteRole>(), s)]).toEqual([true, true, false, false]);
    }
  });
  it("project creation and variation approval: Manager only", () => {
    for (const [r, ok] of [["rep", false], ["estimator", false], ["manager", true]] as Array<[QuoteRole, boolean]>) {
      expect(hasAny(new Set([r]), PROJECT_CREATE_ROLES)).toBe(ok);
      expect(hasAny(new Set([r]), VARIATION_APPROVE_ROLES)).toBe(ok);
    }
    expect(hasAny(new Set<QuoteRole>(), PROJECT_CREATE_ROLES)).toBe(false);
  });
});

describe("staged approval decisions (policy.ts) x single-role account", () => {
  const req = (stage: "ESTIMATOR" | "MANAGER") => ({ status: "PENDING", stage, doc_type: "QUOTE", prepared_by_email: "someone@x", originator_email: "rep@x", assigned_to_email: null } as never);
  const actor = (fn: FunctionalRole, isAdmin: boolean) => ({ email: "me@x", roles: new Set<FunctionalRole>(isAdmin ? [fn, "ADMINISTRATOR"] : [fn]), isAdmin });
  const decide = (fn: FunctionalRole, isAdmin: boolean, action: "APPROVE" | "RETURN", stage: "ESTIMATOR" | "MANAGER", extra: { override?: boolean } = {}) =>
    authoriseStageDecision(actor(fn, isAdmin), action, req(stage), stage, { reason: "a sufficiently long reason", ...extra });
  it("only the stage's own role approves or returns; Rep never; Estimator never at manager stage; Manager never at estimator stage", () => {
    for (const stage of ["ESTIMATOR", "MANAGER"] as const) for (const action of ["APPROVE", "RETURN"] as const) {
      const hold = (fn: FunctionalRole) => decide(fn, false, action, stage).ok;
      expect([hold("REP"), hold("ESTIMATOR"), hold("MANAGER")]).toEqual(stage === "ESTIMATOR" ? [false, true, false] : [false, false, true]);
    }
  });
  it("the ADMINISTRATOR-owner cannot approve or return normally; approval only as an explicit reasoned override (not exposed by the quotation screen's actions)", () => {
    for (const stage of ["ESTIMATOR", "MANAGER"] as const) {
      expect(decide("ADMINISTRATOR", true, "APPROVE", stage).ok).toBe(false);
      expect(decide("ADMINISTRATOR", true, "RETURN", stage).ok).toBe(false);
      expect(decide("ADMINISTRATOR", true, "APPROVE", stage, { override: true })).toMatchObject({ ok: true, override: true });
    }
  });
  it("a non-admin can never override", () => {
    for (const fn of ["REP", "ESTIMATOR", "MANAGER"] as FunctionalRole[]) expect(decide(fn, false, "APPROVE", fn === "MANAGER" ? "ESTIMATOR" : "MANAGER", { override: true }).ok).toBe(false);
  });
});
