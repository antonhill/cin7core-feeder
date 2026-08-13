import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mutable per-test fixture the mocked Supabase clients read from.
const cfg: {
  claims: { sub: string } | null;
  getClaimsThrows: boolean;
  aal: { currentLevel: string; nextLevel: string };
  isSuperAdmin: boolean;
  membership: { org_id: string; role: string; allowed_modules: string[] | null } | null;
  org: { subscription_status: string; disabled_modules: string[] } | null;
} = {
  claims: { sub: "user-1" },
  getClaimsThrows: false,
  aal: { currentLevel: "aal1", nextLevel: "aal1" },
  isSuperAdmin: false,
  membership: { org_id: "org1", role: "member", allowed_modules: null },
  org: { subscription_status: "trialing", disabled_modules: [] },
};

// A chainable query stub whose terminal resolves to the supplied row.
function chain(data: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit", "in"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data });
  c.single = async () => ({ data });
  return c;
}

vi.mock("@supabase/ssr", () => ({
  // The session (anon) client: getClaims, the MFA AAL read, and org_members.
  createServerClient: () => ({
    auth: {
      getClaims: async () => {
        if (cfg.getClaimsThrows) throw new Error("jwks unreachable");
        return { data: cfg.claims ? { claims: cfg.claims } : null };
      },
      exchangeCodeForSession: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: cfg.aal }) },
    },
    from: (table: string) => (table === "org_members" ? chain(cfg.membership) : chain(null)),
  }),
}));

vi.mock("@/supabase/server", () => ({
  // The service-role client: super_admins + organizations.
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "super_admins") return chain(cfg.isSuperAdmin ? { user_id: "u" } : null);
      if (table === "organizations") return chain(cfg.org);
      return chain(null);
    },
  }),
}));

import { middleware } from "@/middleware";

const PROTECTED = "https://app.example.com/settings/instances";

function redirectTo(res: Response | undefined, pathname: string) {
  if (!res) return false;
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!loc && new URL(loc).pathname === pathname;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  cfg.claims = { sub: "user-1" };
  cfg.getClaimsThrows = false;
  cfg.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  cfg.isSuperAdmin = false;
  cfg.membership = { org_id: "org1", role: "member", allowed_modules: null };
  cfg.org = { subscription_status: "trialing", disabled_modules: [] };
});

describe("middleware auth gate (fail-closed)", () => {
  it("redirects to /login when there is no verifiable session", async () => {
    cfg.claims = null;
    expect(redirectTo(await middleware(new NextRequest(PROTECTED)), "/login")).toBe(true);
  });

  it("FAILS CLOSED — redirects to /login when getClaims() throws (was fail-open on 429)", async () => {
    cfg.getClaimsThrows = true;
    expect(redirectTo(await middleware(new NextRequest(PROTECTED)), "/login")).toBe(true);
  });

  it("lets a verified (member) session reach a protected route", async () => {
    const res = await middleware(new NextRequest(PROTECTED));
    expect(redirectTo(res, "/login")).toBe(false);
    expect(redirectTo(res, "/settings/security")).toBe(false);
  });
});

describe("middleware mandatory MFA for privileged users (Phase 1.5)", () => {
  it("super-admin without a verified factor is forced to Settings > Security", async () => {
    cfg.isSuperAdmin = true;
    const res = await middleware(new NextRequest(PROTECTED));
    expect(redirectTo(res, "/settings/security")).toBe(true);
    expect(new URL(res!.headers.get("location")!).searchParams.get("mfa")).toBe("required");
  });

  it("paid-org owner without a verified factor is forced to enrol", async () => {
    cfg.membership = { org_id: "org1", role: "owner", allowed_modules: null };
    cfg.org = { subscription_status: "active", disabled_modules: [] };
    expect(redirectTo(await middleware(new NextRequest(PROTECTED)), "/settings/security")).toBe(true);
  });

  it("TRIAL-org owner is exempt (read-only trial, no forced enrolment)", async () => {
    cfg.membership = { org_id: "org1", role: "owner", allowed_modules: null };
    cfg.org = { subscription_status: "trialing", disabled_modules: [] };
    const res = await middleware(new NextRequest(PROTECTED));
    expect(redirectTo(res, "/settings/security")).toBe(false);
    expect(redirectTo(res, "/login")).toBe(false);
  });

  it("a plain member is never forced to enrol", async () => {
    cfg.membership = { org_id: "org1", role: "member", allowed_modules: null };
    cfg.org = { subscription_status: "active", disabled_modules: [] };
    expect(redirectTo(await middleware(new NextRequest(PROTECTED)), "/settings/security")).toBe(false);
  });

  it("a privileged user WITH a verified factor (stepped up) is not forced anywhere", async () => {
    cfg.isSuperAdmin = true;
    cfg.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    const res = await middleware(new NextRequest(PROTECTED));
    expect(redirectTo(res, "/settings/security")).toBe(false);
    expect(redirectTo(res, "/mfa-challenge")).toBe(false);
  });

  it("does not loop: an unenrolled privileged user already on Settings > Security is let through", async () => {
    cfg.isSuperAdmin = true;
    const res = await middleware(new NextRequest("https://app.example.com/settings/security"));
    expect(redirectTo(res, "/settings/security")).toBe(false);
    expect(redirectTo(res, "/login")).toBe(false);
  });

  it("still steps up an enrolled-but-not-verified privileged user via /mfa-challenge", async () => {
    cfg.isSuperAdmin = true;
    cfg.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = await middleware(new NextRequest(PROTECTED));
    expect(redirectTo(res, "/mfa-challenge")).toBe(true);
  });
});
