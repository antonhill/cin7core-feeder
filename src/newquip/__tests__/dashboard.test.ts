import { describe, expect, it } from "vitest";
import { activeProjectCount, claimBucket, claimCounts, queueFor, quoteStageCounts } from "../dashboard";
import { claimListRows, claimStatusLabel } from "../claims-list";
import { settingsEntries } from "../settings-entries";
import { rolesFor } from "../quote/roles";

describe("quoteStageCounts", () => {
  it("splits estimator review into Estimator review and Manager decision by sign-off, like the quotation list", () => {
    const c = quoteStageCounts([
      { state: "REP_DRAFT", signed_off: false }, { state: "REP_DRAFT", signed_off: false },
      { state: "ESTIMATOR_REVIEW", signed_off: false }, { state: "ESTIMATOR_REVIEW", signed_off: true },
      { state: "MANAGER_APPROVED_FINAL", signed_off: true },
    ]);
    expect(c).toEqual({ repDraft: 2, estimatorReview: 1, managerDecision: 1, approved: 1, total: 5 });
  });
});

describe("claim buckets", () => {
  it("classifies every status", () => {
    expect(["DRAFT", "READY_FOR_APPROVAL", "FAILED_UNCERTAIN", "APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED", "FAILED_CONFIRMED_NO_WRITE", "CANCELLED_BEFORE_WRITE", "WHATEVER"].map(claimBucket))
      .toEqual(["draft", "open", "open", "approved", "approved", "approved", "approved", null, null, null]);
  });
  it("counts them", () => {
    expect(claimCounts(["DRAFT", "DRAFT", "READY_FOR_APPROVAL", "RECONCILED", "CANCELLED_BEFORE_WRITE"])).toEqual({ draft: 2, open: 1, approved: 1 });
  });
  it("counts active projects", () => {
    expect(activeProjectCount([{ status: "ACTIVE" }, { status: "COMPLETE" }, { status: "ACTIVE" }])).toBe(2);
  });
});

describe("queueFor (role-aware, counts only)", () => {
  const q = { repDraft: 3, estimatorReview: 2, managerDecision: 1, approved: 9, total: 15 };
  it("a member (rep + estimator) is not offered the manager decision queue", () => {
    expect(queueFor(rolesFor("member"), q).map((i) => i.count)).toEqual([3, 2]);
  });
  it("an admin tier also sees the manager queue", () => {
    expect(queueFor(rolesFor("admin"), q).map((i) => i.count)).toEqual([3, 2, 1]);
  });
  it("no roles, no queue", () => {
    expect(queueFor(rolesFor("none"), q)).toEqual([]);
  });
});

describe("claimListRows", () => {
  const claim = (id: string, seq: number, date: string, status: string, total = 1000) => ({ id, claim_seq: seq, claim_number: `C${seq}`, claim_date: date, status, subtotal_cents: total, tax_cents: 0, total_cents: total });
  const proj = (id: string, ref: string, extra = {}) => ({ id, org_id: "o", project_reference: ref, name: `${ref} name`, customer_name: `${ref} cust`, originating_quote_ref: null, original_contract_cents: 0, currency: "ZAR", tax_rule: null, tax_rate_bps: 0, salesperson: null, project_manager: null, start_date: null, target_completion_date: null, status: "ACTIVE", ...extra });
  it("lists every claim of customer-facing projects, newest first, linking to the claims tab", () => {
    const rows = claimListRows([
      { project: proj("p1", "PRJ-1"), claims: [claim("a", 1, "2026-10-01", "APPROVED"), claim("b", 2, "2026-11-01", "DRAFT")] },
      { project: proj("p2", "PRJ-2", { billing_scope: "VARIATION" }), claims: [claim("v", 1, "2026-11-05", "DRAFT")] },
    ] as never);
    expect(rows.map((r) => r.claimId)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ projectReference: "PRJ-1", customerName: "PRJ-1 cust", claimNumber: "C2", bucket: "draft", href: "/projects/p1?tab=claims" });
  });
  it("labels statuses", () => { expect(claimStatusLabel("READY_FOR_APPROVAL")).toBe("Ready for approval"); });
});

describe("settingsEntries", () => {
  const hrefs = (v: Parameters<typeof settingsEntries>[0]) => settingsEntries(v).map((e) => e.href);
  it("a plain member sees company, templates, security, notifications only", () => {
    expect(hrefs({ isOrgAdmin: false, canSeeCost: false, demo: false })).toEqual(["/newquip-grower/company-profile", "/newquip-grower/project-templates", "/settings/security", "/settings/notifications"]);
  });
  it("cost survey needs cost entitlement outside Demo Mode; members needs org admin", () => {
    expect(hrefs({ isOrgAdmin: true, canSeeCost: true, demo: false })).toContain("/newquip-grower/cost-survey");
    expect(hrefs({ isOrgAdmin: true, canSeeCost: true, demo: false })).toContain("/settings/members");
    expect(hrefs({ isOrgAdmin: true, canSeeCost: true, demo: true })).not.toContain("/newquip-grower/cost-survey");
    expect(hrefs({ isOrgAdmin: false, canSeeCost: true, demo: false })).not.toContain("/settings/members");
  });
  it("has no entry for the not-yet-built Commercial settings page", () => {
    expect(settingsEntries({ isOrgAdmin: true, canSeeCost: true, demo: false }).some((e) => /commercial/i.test(e.label + e.href))).toBe(false);
  });
});
