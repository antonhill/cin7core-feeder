import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-super-admin", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { setImpersonatedOrgAction, clearImpersonatedOrgAction } from "@/actions/org-switch";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// setImpersonatedOrgAction uses requirePrivilegedSuperAdmin (security
// re-audit round 3, item 1 — AAL2 required to start impersonation);
// clearImpersonatedOrgAction still uses the plain requireSuperAdmin
// (exiting impersonation isn't gated on AAL2).
const reqPrivilegedSuper = vi.mocked(requirePrivilegedSuperAdmin);
const reqSuper = vi.mocked(requireSuperAdmin);
const serviceClient = vi.mocked(createServiceRoleClient);
const mockCookies = vi.mocked(cookies);

const COOKIE = "impersonated_org_id";
const EIGHT_HOURS = 60 * 60 * 8;

function orgLookup(row: { id: string; name: string } | null) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

let store: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  reqSuper.mockResolvedValue({ userId: "admin-1" });
  reqPrivilegedSuper.mockResolvedValue({ userId: "admin-1" });
  store = { set: vi.fn(), get: vi.fn(() => ({ value: "org-prev" })), delete: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCookies.mockResolvedValue(store as any);
});

describe("setImpersonatedOrgAction", () => {
  it("sets a short-lived cookie and audits the start", async () => {
    serviceClient.mockReturnValue(orgLookup({ id: "org-9", name: "Acme" }));
    const res = await setImpersonatedOrgAction("org-9");
    expect(res).toEqual({ ok: true });

    const [name, value, opts] = store.set.mock.calls[0];
    expect(name).toBe(COOKIE);
    expect(value).toBe("org-9");
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: EIGHT_HOURS });
    expect(opts.maxAge).toBeLessThan(60 * 60 * 24); // no longer 30 days
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("[impersonation.start]"));
  });

  it("marks the cookie secure in production only", async () => {
    serviceClient.mockReturnValue(orgLookup({ id: "org-9", name: "Acme" }));

    vi.stubEnv("NODE_ENV", "production");
    await setImpersonatedOrgAction("org-9");
    expect(store.set.mock.calls[0][2].secure).toBe(true);
    vi.unstubAllEnvs();

    store.set.mockClear();
    vi.stubEnv("NODE_ENV", "development");
    await setImpersonatedOrgAction("org-9");
    expect(store.set.mock.calls[0][2].secure).toBe(false);
    vi.unstubAllEnvs();
  });

  it("does not set a cookie when the org doesn't exist", async () => {
    serviceClient.mockReturnValue(orgLookup(null));
    const res = await setImpersonatedOrgAction("nope");
    expect(res.ok).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("does not set a cookie for a non-super-admin", async () => {
    reqPrivilegedSuper.mockRejectedValue(new Error("Not authorized."));
    const res = await setImpersonatedOrgAction("org-9");
    expect(res).toEqual({ ok: false, error: "Not authorized." });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("security re-audit round 3, item 1: does not set a cookie when the super-admin hasn't verified AAL2", async () => {
    reqPrivilegedSuper.mockRejectedValue(new Error("Two-factor authentication is required to view as another organization."));
    const res = await setImpersonatedOrgAction("org-9");
    expect(res).toEqual({ ok: false, error: "Two-factor authentication is required to view as another organization." });
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("clearImpersonatedOrgAction", () => {
  it("deletes the cookie, audits the end with the previous org, and redirects", async () => {
    await clearImpersonatedOrgAction();
    expect(store.delete).toHaveBeenCalledWith(COOKIE);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("[impersonation.end]"));
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("org-prev"));
    expect(redirect).toHaveBeenCalledWith("/");
  });
});
