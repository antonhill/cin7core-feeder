import { describe, expect, it } from "vitest";
import { authoriseTransition, canEditDraft, checkApproval, checkHandoff, QUOTE_STATES } from "../workflow";
import { COMMERCIAL_APPROVAL_ROLES, hasAny, PHYSICAL_PROGRESS_ROLES, rolesFor, VARIATION_APPROVE_ROLES, VARIATION_PREPARE_ROLES } from "../roles";
import { assessReadiness, type Readiness } from "../../grower/readiness";
import { evaluateDraft } from "../../grower/evaluate";
import { readyDraft } from "../../grower/__tests__/golden";
import { testPriceSource } from "../../grower/__tests__/test-snapshot";
import { FINAL_GROWER_DECISIONS } from "../../grower/final-feedback";

const member = rolesFor("member");
const admin = rolesFor("admin");
const none = rolesFor("none");
const ready = (): Readiness => evaluateDraft(readyDraft(), { priceSource: testPriceSource(), withholdCost: true }).readiness;
const blocked = (): Readiness => ({ ...ready(), state: "BLOCKED", reasons: ["M75: estimator commercial price required"] });

describe("quote workflow — states and transitions", () => {
  it("has exactly the three confirmed POC states", () => {
    expect([...QUOTE_STATES]).toEqual(["REP_DRAFT", "ESTIMATOR_REVIEW", "MANAGER_APPROVED_FINAL"]);
    expect([...FINAL_GROWER_DECISIONS.workflow.states]).toEqual([...QUOTE_STATES]);
  });
  it("REP_DRAFT → ESTIMATOR_REVIEW is the rep's handoff", () => {
    expect(authoriseTransition(member, "REP_DRAFT", "SEND_TO_ESTIMATOR")).toEqual({ ok: true, to: "ESTIMATOR_REVIEW" });
    expect(authoriseTransition(none, "REP_DRAFT", "SEND_TO_ESTIMATOR").ok).toBe(false);
  });
  it("only a manager can approve, and only from ESTIMATOR_REVIEW", () => {
    expect(authoriseTransition(admin, "ESTIMATOR_REVIEW", "MANAGER_APPROVE")).toEqual({ ok: true, to: "MANAGER_APPROVED_FINAL" });
    expect(authoriseTransition(member, "ESTIMATOR_REVIEW", "MANAGER_APPROVE")).toEqual({ ok: false, error: "Requires the manager role." });
    expect(authoriseTransition(admin, "REP_DRAFT", "MANAGER_APPROVE").ok).toBe(false); // no skipping the estimator
  });
  it("no transition leaves MANAGER_APPROVED_FINAL — post-acceptance changes must be Variations", () => {
    for (const a of ["SEND_TO_ESTIMATOR", "RETURN_TO_REP", "ESTIMATOR_SIGN_OFF", "MANAGER_APPROVE"] as const) {
      const r = authoriseTransition(admin, "MANAGER_APPROVED_FINAL", a);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/Variations/);
    }
    expect(canEditDraft(admin, "MANAGER_APPROVED_FINAL")).toBe(false);
  });
  it("members may edit a draft in REP_DRAFT or ESTIMATOR_REVIEW; nobody with no role may", () => {
    expect(canEditDraft(member, "REP_DRAFT")).toBe(true);
    expect(canEditDraft(member, "ESTIMATOR_REVIEW")).toBe(true);
    expect(canEditDraft(none, "REP_DRAFT")).toBe(false);
  });
});

describe("handoff and approval preconditions (fail closed)", () => {
  it("handoff records the customer's confirmed amount, which must equal the total", () => {
    expect(checkHandoff({ readiness: ready(), totalExVatCents: 100, confirmedAmountCents: 100, confirmedBy: "Joe" }).ok).toBe(true);
    expect(checkHandoff({ readiness: ready(), totalExVatCents: 100, confirmedAmountCents: 99, confirmedBy: "Joe" }).ok).toBe(false);
    expect(checkHandoff({ readiness: ready(), totalExVatCents: 100, confirmedAmountCents: 100, confirmedBy: "" }).ok).toBe(false);
    expect(checkHandoff({ readiness: blocked(), totalExVatCents: 100, confirmedAmountCents: 100, confirmedBy: "Joe" }).ok).toBe(false);
    expect(checkHandoff({ readiness: ready(), totalExVatCents: null, confirmedAmountCents: 100, confirmedBy: "Joe" }).ok).toBe(false);
  });
  const good = { readiness: ready(), totalExVatCents: 500, customerConfirmedCents: 500, signoffHash: "h", currentDraftHash: "h" };
  it("approval needs READY + confirmation + sign-off of the exact content + an unchanged total", () => {
    expect(checkApproval(good).ok).toBe(true);
    expect(checkApproval({ ...good, readiness: blocked() }).ok).toBe(false);
    expect(checkApproval({ ...good, customerConfirmedCents: null }).ok).toBe(false);
    expect(checkApproval({ ...good, signoffHash: null }).ok).toBe(false);
    expect(checkApproval({ ...good, signoffHash: "old" }).ok).toBe(false);
    expect(checkApproval({ ...good, customerConfirmedCents: 400 }).ok).toBe(false);
    expect(checkApproval({ ...good, totalExVatCents: null }).ok).toBe(false);
  });
});

describe("roles — physical vs commercial progress, fail closed", () => {
  it("members are rep + estimator; admins add manager; anything else has NO role", () => {
    expect([...member].sort()).toEqual(["estimator", "rep"]);
    expect([...admin].sort()).toEqual(["estimator", "manager", "rep"]);
    expect(none.size).toBe(0);
  });
  it("PHYSICAL progress: rep + estimator. COMMERCIAL approval: manager only", () => {
    expect([...PHYSICAL_PROGRESS_ROLES]).toEqual([...FINAL_GROWER_DECISIONS.project.physicalProgressRoles]);
    expect([...COMMERCIAL_APPROVAL_ROLES]).toEqual([...FINAL_GROWER_DECISIONS.project.commercialApprovalRoles]);
    expect(hasAny(member, PHYSICAL_PROGRESS_ROLES)).toBe(true);
    expect(hasAny(member, COMMERCIAL_APPROVAL_ROLES)).toBe(false);
    expect(hasAny(admin, COMMERCIAL_APPROVAL_ROLES)).toBe(true);
    expect(hasAny(none, PHYSICAL_PROGRESS_ROLES)).toBe(false);
    expect(hasAny(none, COMMERCIAL_APPROVAL_ROLES)).toBe(false);
  });
  it("VARIATIONS: estimator raises/prices, manager approves (and may also prepare)", () => {
    expect([...VARIATION_PREPARE_ROLES].sort()).toEqual([...FINAL_GROWER_DECISIONS.variations.raiseAndPriceRoles].sort());
    expect(hasAny(member, VARIATION_PREPARE_ROLES)).toBe(true);
    expect(hasAny(member, VARIATION_APPROVE_ROLES)).toBe(false);
    expect(hasAny(admin, VARIATION_APPROVE_ROLES)).toBe(true);
    expect(hasAny(admin, VARIATION_PREPARE_ROLES)).toBe(true);
  });
});

describe("readiness states", () => {
  const ctx = { priceSource: testPriceSource(), withholdCost: false };
  it("DRAFT: a blank draft (invalid engineering inputs / no customer) is DRAFT, not BLOCKED", async () => {
    const { emptyDraft } = await import("../../grower/draft");
    const ev = evaluateDraft(emptyDraft(), ctx);
    expect(ev.readiness.state).toBe("DRAFT");
    expect(ev.budget).toBeNull();
    const noName = evaluateDraft({ ...readyDraft(), customerName: "" }, ctx);
    expect(noName.readiness.state).toBe("DRAFT");
  });
  it("BLOCKED only when a required commercial value/input genuinely remains unresolved", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, config: { ...d.config, estimatorQuantities: { ...d.config.estimatorQuantities, feeder: undefined } } }, ctx);
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.readiness.reasons.join()).toMatch(/CCM feeder/);
  });
  it("READY once every required value is supplied — manual-by-design items are then NOT defects", () => {
    const ev = evaluateDraft(readyDraft(), ctx);
    expect(ev.readiness.state).toBe("READY");
    expect(ev.readiness.reasons).toEqual([]);
    expect(ev.readiness.counts.estimatorInputs).toBeGreaterThan(5); // feeder, drinker, slat, tank, M75, doors, charges…
    expect(ev.readiness.counts.missingMappings).toBe(0);
  });
  it("reports every category the estimator needs on one surface", () => {
    const ev = evaluateDraft(readyDraft(), ctx);
    expect(Object.keys(ev.readiness.counts).sort()).toEqual(["autoCalculated", "estimatorInputs", "missingMappings", "overrides", "pricingExceptions", "suggestedDefault", "supplierQuoteRequired", "warnings"]);
    expect(ev.readiness.counts.suggestedDefault).toBe(2); // lighting minimum, feed saver mat
    expect(ev.readiness.counts.pricingExceptions).toBe(1); // FORTIS 1.2 resolved by the estimator
    expect(ev.readiness.counts.supplierQuoteRequired).toBe(1); // NQ3132 inside M75 (covered by the higher-level price)
    expect(ev.readiness.items.supplierQuoteRequired[0].detail).toMatch(/Covered by the estimator's higher-level price/);
    expect(assessReadiness(readyDraft(), ev.calc, ev.budget).state).toBe("READY");
  });
  it("unconfirmed mappings are listed as missing product mappings", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, estimator: { ...d.estimator, confirmedMappings: {} } }, ctx);
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.readiness.counts.missingMappings).toBeGreaterThanOrEqual(4);
  });
});
