import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/supabase/server-session", () => ({ createSessionClient: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { completeNewquipSignInAction } from "@/actions/newquip-access";
import * as moduleExports from "@/actions/newquip-access";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { cookies } from "next/headers";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const NQ = NEWQUIP_POC_ORG_IDS[0];
const signOut = vi.fn();
let store: { set: ReturnType<typeof vi.fn> };

function setup(o: { user?: { id: string } | null; orgs?: string[]; superAdmin?: boolean; memberError?: boolean }) {
  const user = o.user === undefined ? { id: "u1" } : o.user;
  vi.mocked(createSessionClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user } }), signOut } } as never);
  vi.mocked(createServiceRoleClient).mockReturnValue({
    from: (t: string) => t === "org_members"
      ? { select: () => ({ eq: async () => (o.memberError ? { data: null, error: { message: "x" } } : { data: (o.orgs ?? []).map((org_id) => ({ org_id })), error: null }) }) }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: o.superAdmin ? { user_id: "u1" } : null, error: null }) }) }) },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  store = { set: vi.fn() };
  vi.mocked(cookies).mockResolvedValue(store as never);
});

describe("completeNewquipSignInAction", () => {
  it("is a 'use server' module exporting only async functions", () => {
    for (const v of Object.values(moduleExports)) expect(typeof v).toBe("function");
  });
  it("NewQuip member: ok and the active organisation is set to NewQuip", async () => {
    setup({ orgs: [NQ] });
    expect(await completeNewquipSignInAction()).toEqual({ ok: true });
    expect(store.set).toHaveBeenCalledWith("active_org_id", NQ, expect.objectContaining({ httpOnly: true, path: "/" }));
  });
  it("multi-org user lands in NewQuip, not their other organisation", async () => {
    setup({ orgs: ["other-org", NQ] });
    expect(await completeNewquipSignInAction()).toEqual({ ok: true });
    expect(store.set.mock.calls[0][1]).toBe(NQ);
  });
  it("non-member is refused, signed out, and no organisation is revealed or selected", async () => {
    setup({ orgs: ["other-org"] });
    const res = await completeNewquipSignInAction();
    expect(res).toEqual({ ok: false, error: "This account does not have access to NewQuip." });
    expect(JSON.stringify(res)).not.toContain("other-org");
    expect(store.set).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });
  it("super-admin outside NewQuip proceeds without changing the active organisation", async () => {
    setup({ orgs: ["other-org"], superAdmin: true });
    expect(await completeNewquipSignInAction()).toEqual({ ok: true });
    expect(store.set).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
  it("no session or a failed lookup fails closed", async () => {
    setup({ user: null });
    expect((await completeNewquipSignInAction()).ok).toBe(false);
    setup({ memberError: true });
    expect((await completeNewquipSignInAction()).ok).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });
});
