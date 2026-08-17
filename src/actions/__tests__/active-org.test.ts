import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/supabase/server-session", () => ({ createSessionClient: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { listMyOrgsAction, setActiveOrgAction } from "@/actions/active-org";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { cookies } from "next/headers";

const sessionClient = vi.mocked(createSessionClient);
const serviceClient = vi.mocked(createServiceRoleClient);
const mockCookies = vi.mocked(cookies);

const USER = { id: "u1" };
const COOKIE = "active_org_id";

function makeSession(user: typeof USER | null = USER) {
  return { auth: { getUser: async () => ({ data: { user } }) } } as unknown as Awaited<ReturnType<typeof createSessionClient>>;
}

let store: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  sessionClient.mockResolvedValue(makeSession());
  store = { set: vi.fn(), get: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCookies.mockResolvedValue(store as any);
});

describe("listMyOrgsAction", () => {
  it("returns only orgs the caller is a member of", async () => {
    serviceClient.mockReturnValue({
      from: (table: string) => {
        if (table === "org_members") {
          return { select: () => ({ eq: async () => ({ data: [{ org_id: "org-1" }, { org_id: "org-2" }], error: null }) }) };
        }
        if (table === "organizations") {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({
                  data: [
                    { id: "org-1", name: "Acme" },
                    { id: "org-2", name: "Beta" },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as ReturnType<typeof createServiceRoleClient>);

    const res = await listMyOrgsAction();
    expect(res).toEqual({
      ok: true,
      orgs: [
        { id: "org-1", name: "Acme" },
        { id: "org-2", name: "Beta" },
      ],
    });
  });

  it("returns an empty list without querying organizations when the caller has no memberships", async () => {
    const orgsQuery = vi.fn();
    serviceClient.mockReturnValue({
      from: (table: string) => {
        if (table === "org_members") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
        orgsQuery();
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as ReturnType<typeof createServiceRoleClient>);

    const res = await listMyOrgsAction();
    expect(res).toEqual({ ok: true, orgs: [] });
    expect(orgsQuery).not.toHaveBeenCalled();
  });

  it("fails when not signed in", async () => {
    sessionClient.mockResolvedValue(makeSession(null));
    const res = await listMyOrgsAction();
    expect(res).toEqual({ ok: false, error: "Not signed in." });
  });
});

describe("setActiveOrgAction — security re-audit P1-8", () => {
  function membershipLookup(row: { org_id: string } | null) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
    } as unknown as ReturnType<typeof createServiceRoleClient>;
  }

  it("sets the cookie when the caller is a real member of the target org", async () => {
    serviceClient.mockReturnValue(membershipLookup({ org_id: "org-2" }));
    const res = await setActiveOrgAction("org-2");
    expect(res).toEqual({ ok: true });
    const [name, value, opts] = store.set.mock.calls[0];
    expect(name).toBe(COOKIE);
    expect(value).toBe("org-2");
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(opts.maxAge).toBeUndefined();
  });

  it("refuses to set the cookie for an org the caller isn't actually a member of — the whole point of this fix", async () => {
    serviceClient.mockReturnValue(membershipLookup(null));
    const res = await setActiveOrgAction("some-other-org");
    expect(res).toEqual({ ok: false, error: "You're not a member of that organization." });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("marks the cookie secure in production only", async () => {
    serviceClient.mockReturnValue(membershipLookup({ org_id: "org-2" }));
    vi.stubEnv("NODE_ENV", "production");
    await setActiveOrgAction("org-2");
    expect(store.set.mock.calls[0][2].secure).toBe(true);
    vi.unstubAllEnvs();
  });

  it("fails when not signed in", async () => {
    sessionClient.mockResolvedValue(makeSession(null));
    const res = await setActiveOrgAction("org-2");
    expect(res).toEqual({ ok: false, error: "Not signed in." });
    expect(store.set).not.toHaveBeenCalled();
  });
});
