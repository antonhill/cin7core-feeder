import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ signOut: vi.fn(), redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/supabase/server-session", () => ({ createSessionClient: async () => ({ auth: { signOut: h.signOut } }) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/org-switch", () => ({ getImpersonatedOrgId: vi.fn() }));
vi.mock("@/lib/active-org", () => ({ getActiveOrgCookie: vi.fn(), resolveActiveOrgId: vi.fn() }));

import { signOutAction, signOutNewquipAction } from "@/actions/auth";

beforeEach(() => vi.clearAllMocks());

describe("sign-out destinations", () => {
  it("the NewQuip shell signs out to /newquip/login", async () => {
    await signOutNewquipAction();
    expect(h.signOut).toHaveBeenCalled();
    expect(h.redirect).toHaveBeenCalledWith("/newquip/login");
  });
  it("other organisations still sign out to /login", async () => {
    await signOutAction();
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });
});
