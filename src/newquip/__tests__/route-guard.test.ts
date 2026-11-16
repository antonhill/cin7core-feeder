import { describe, expect, it } from "vitest";
import { NEWQUIP_POC_ORG_IDS } from "../access";
import { isNewquipOnlyPathAllowed, isNewquipOnlyUser, newquipGuardRedirects } from "../route-guard";

const NQ = NEWQUIP_POC_ORG_IDS[0];
const OTHER = "00000000-0000-0000-0000-000000000000";

describe("isNewquipOnlyPathAllowed", () => {
  it("allows the NewQuip workspace, settings entries and sign-in flows (including nested paths)", () => {
    for (const p of ["/", "/newquip-grower", "/newquip-grower/abc", "/newquip-grower/settings", "/projects", "/projects/1", "/approvals", "/approvals/roles", "/claims", "/settings/members", "/settings/security", "/settings/notifications", "/login", "/auth/callback", "/mfa-challenge", "/privacy", "/api/anything"]) expect(isNewquipOnlyPathAllowed(p), p).toBe(true);
  });
  it("refuses every Toolbox module and other settings", () => {
    for (const p of ["/reports", "/reports/order-fulfillment", "/quotes", "/import", "/templates", "/migrate", "/audit", "/health", "/activity", "/admin", "/replenish", "/warehouse-performance", "/settings", "/settings/billing", "/settings/instances", "/settings/diagnostics", "/stocktake-assistant", "/supplier-planner"]) expect(isNewquipOnlyPathAllowed(p), p).toBe(false);
  });
  it("matches on a segment boundary, never a bare prefix", () => {
    for (const p of ["/projects-x", "/approvalsx", "/claimsfoo", "/newquip-growerx", "/settings/members-x", "/apix", "/loginx", "/authz"]) expect(isNewquipOnlyPathAllowed(p), p).toBe(false);
  });
  it("fails closed on malformed or traversal-style paths", () => {
    for (const p of ["", "projects", "//evil.example", "/projects/../reports", "/projects\\..\\reports"]) expect(isNewquipOnlyPathAllowed(p), p).toBe(false);
  });
});

describe("isNewquipOnlyUser", () => {
  it("is the NewQuip organisation's non-super-admin members only", () => {
    expect(isNewquipOnlyUser(NQ, false)).toBe(true);
    expect(isNewquipOnlyUser(NQ, true)).toBe(false);
    expect(isNewquipOnlyUser(OTHER, false)).toBe(false);
    expect(isNewquipOnlyUser(null, false)).toBe(false);
  });
});

describe("newquipGuardRedirects", () => {
  it("redirects a NewQuip non-super-admin from a Toolbox path, not from an allowed one", () => {
    expect(newquipGuardRedirects({ pathname: "/reports", orgId: NQ, isSuperAdmin: false })).toBe(true);
    expect(newquipGuardRedirects({ pathname: "/projects/1", orgId: NQ, isSuperAdmin: false })).toBe(false);
  });
  it("never applies to a super-admin, or to another organisation", () => {
    expect(newquipGuardRedirects({ pathname: "/reports", orgId: NQ, isSuperAdmin: true })).toBe(false);
    expect(newquipGuardRedirects({ pathname: "/reports", orgId: NQ, isSuperAdmin: true, uncertain: true })).toBe(false);
    expect(newquipGuardRedirects({ pathname: "/reports", orgId: OTHER, isSuperAdmin: false })).toBe(false);
  });
  it("fails closed (non-allowlisted paths only) when the user's identity could not be read", () => {
    expect(newquipGuardRedirects({ pathname: "/reports", orgId: null, isSuperAdmin: false, uncertain: true })).toBe(true);
    expect(newquipGuardRedirects({ pathname: "/", orgId: null, isSuperAdmin: false, uncertain: true })).toBe(false);
  });
});
