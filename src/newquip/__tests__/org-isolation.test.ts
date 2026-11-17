import { describe, it, expect, vi, beforeEach } from "vitest";

// Server-side isolation: a signed-in user who is NOT a member of the NewQuip organisation cannot obtain it as their current organisation, even with a forged active_org_id cookie, so NewQuip routes (layout) and actions (authoriseActor) refuse them.
const h = vi.hoisted(() => ({ cookie: null as string | null, orgs: [] as string[], superAdmin: false }));
vi.mock("@/supabase/server-session", () => ({
  createSessionClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "u@x" } } }) },
    from: () => ({ select: () => ({ eq: async () => ({ data: h.orgs.map((org_id) => ({ org_id })), error: null }) }) }),
  }),
}));
vi.mock("@/supabase/server", () => ({
  createServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.superAdmin ? { user_id: "u1" } : null }) }) }) }) }),
}));
vi.mock("@/lib/active-org", async () => {
  const real = await vi.importActual<typeof import("@/lib/active-org-resolution")>("@/lib/active-org-resolution");
  return { ...real, getActiveOrgCookie: async () => h.cookie };
});
vi.mock("@/lib/org-switch", () => ({ getImpersonatedOrgId: async () => null }));

import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const NQ = NEWQUIP_POC_ORG_IDS[0];
beforeEach(() => { h.cookie = null; h.orgs = []; h.superAdmin = false; });

describe("requireNewquipPocOrg (route layout + action guard)", () => {
  it("refuses a member of another organisation only", async () => {
    h.orgs = ["other-org"];
    await expect(requireNewquipPocOrg()).rejects.toThrow("isn't available");
  });
  it("refuses a non-member who forges the active-org cookie to the NewQuip organisation", async () => {
    h.orgs = ["other-org"]; h.cookie = NQ;
    await expect(requireNewquipPocOrg()).rejects.toThrow("isn't available");
  });
  it("refuses a user with no membership at all", async () => {
    await expect(requireNewquipPocOrg()).rejects.toThrow();
  });
  it("admits a NewQuip member", async () => {
    h.orgs = [NQ];
    expect((await requireNewquipPocOrg()).orgId).toBe(NQ);
  });
  it("a multi-org member is admitted only when NewQuip is their active organisation", async () => {
    h.orgs = ["other-org", NQ]; h.cookie = "other-org";
    await expect(requireNewquipPocOrg()).rejects.toThrow("isn't available");
    h.cookie = NQ;
    expect((await requireNewquipPocOrg()).orgId).toBe(NQ);
  });
});
