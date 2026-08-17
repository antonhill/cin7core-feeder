import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mutable per-test fixture the mocked Supabase clients read from.
const cfg: {
  claims: { sub: string } | null;
  getClaimsThrows: boolean;
  aal: { currentLevel: string; nextLevel: string };
  isSuperAdmin: boolean;
  // Security re-audit round 3, item 1: a real user can belong to MULTIPLE
  // orgs with different roles in each — memberships is an array (not a
  // single row) so tests can exercise resolveActiveOrgId's cookie-driven
  // selection, exactly what middleware must now share with Server Actions.
  memberships: { org_id: string; role: string; allowed_modules: string[] | null }[];
  orgs: Record<string, { subscription_status: string; disabled_modules: string[] }>;
} = {
  claims: { sub: "user-1" },
  getClaimsThrows: false,
  aal: { currentLevel: "aal1", nextLevel: "aal1" },
  isSuperAdmin: false,
  memberships: [{ org_id: "org1", role: "member", allowed_modules: null }],
  orgs: { org1: { subscription_status: "trialing", disabled_modules: [] } },
};

// A chainable query stub whose terminal (.maybeSingle/.single) resolves to
// the supplied single row — used for organizations/super_admins, which
// middleware still narrows to one row via .maybeSingle().
function chainSingle(data: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit", "in"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data });
  c.single = async () => ({ data });
  return c;
}

// Security re-audit round 3, item 1: org_members is now fetched WITHOUT a
// .limit(1)/.maybeSingle() terminal — middleware awaits the query builder
// directly (matching the real Supabase client's own thenable query builder)
// to get every membership row, then resolves the active one via
// resolveActiveOrgId. This stub must be awaitable directly (implements
// .then()) rather than requiring an explicit terminal call.
function chainList(data: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) c[m] = () => c;
  c.then = (resolve: (v: { data: unknown[] }) => void) => resolve({ data });
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
    from: (table: string) => (table === "org_members" ? chainList(cfg.memberships) : chainSingle(null)),
  }),
}));

vi.mock("@/supabase/server", () => ({
  // The service-role client: super_admins + organizations.
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "super_admins") return chainSingle(cfg.isSuperAdmin ? { user_id: "u" } : null);
      if (table === "organizations") {
        // Real query is .eq("id", orgId).maybeSingle() — this stub doesn't
        // see which orgId was requested, so it returns a chainSingle whose
        // .maybeSingle() looks up cfg.orgs by whichever org ends up
        // resolved; simplest correct approach: return a proxy that resolves
        // lazily based on the LAST org_id resolved by the test's own setup.
        // In practice every test here uses exactly one active org's worth
        // of org data at a time, so keying by "whatever's in cfg.orgs" via
        // a single-entry lookup is sufficient — see chainOrgLookup below.
        return chainOrgLookup();
      }
      return chainSingle(null);
    },
  }),
}));

// organizations is queried by whichever orgId middleware resolved
// (super-admin impersonation, or the newly-fixed multi-membership
// resolution) — this stub captures the .eq("id", X) call so it can look up
// the right row in cfg.orgs by that id, instead of a fixed single value.
function chainOrgLookup() {
  const c: Record<string, unknown> = { select: () => c };
  let requestedId: string | undefined;
  c.eq = (col: string, val: string) => {
    if (col === "id") requestedId = val;
    return c;
  };
  c.maybeSingle = async () => ({ data: requestedId ? (cfg.orgs[requestedId] ?? null) : null });
  return c;
}

import { middleware } from "@/middleware";

const PROTECTED_PATH = "/settings/instances";

/** Builds a request against PROTECTED_PATH, optionally carrying an active_org_id cookie. */
function protectedRequest(activeOrgCookie?: string) {
  const headers: HeadersInit = activeOrgCookie ? { cookie: `active_org_id=${activeOrgCookie}` } : {};
  return new NextRequest(`https://app.example.com${PROTECTED_PATH}`, { headers });
}

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
  cfg.memberships = [{ org_id: "org1", role: "member", allowed_modules: null }];
  cfg.orgs = { org1: { subscription_status: "trialing", disabled_modules: [] } };
});

describe("middleware auth gate (fail-closed)", () => {
  it("redirects to /login when there is no verifiable session", async () => {
    cfg.claims = null;
    expect(redirectTo(await middleware(protectedRequest()), "/login")).toBe(true);
  });

  it("FAILS CLOSED — redirects to /login when getClaims() throws (was fail-open on 429)", async () => {
    cfg.getClaimsThrows = true;
    expect(redirectTo(await middleware(protectedRequest()), "/login")).toBe(true);
  });

  it("lets a verified (member) session reach a protected route", async () => {
    const res = await middleware(protectedRequest());
    expect(redirectTo(res, "/login")).toBe(false);
    expect(redirectTo(res, "/settings/security")).toBe(false);
  });
});

describe("middleware mandatory MFA for privileged users (Phase 1.5)", () => {
  it("super-admin without a verified factor is forced to Settings > Security", async () => {
    cfg.isSuperAdmin = true;
    const res = await middleware(protectedRequest());
    expect(redirectTo(res, "/settings/security")).toBe(true);
    expect(new URL(res!.headers.get("location")!).searchParams.get("mfa")).toBe("required");
  });

  it("paid-org owner without a verified factor is forced to enrol", async () => {
    cfg.memberships = [{ org_id: "org1", role: "owner", allowed_modules: null }];
    cfg.orgs = { org1: { subscription_status: "active", disabled_modules: [] } };
    expect(redirectTo(await middleware(protectedRequest()), "/settings/security")).toBe(true);
  });

  it("TRIAL-org owner is exempt (read-only trial, no forced enrolment)", async () => {
    cfg.memberships = [{ org_id: "org1", role: "owner", allowed_modules: null }];
    cfg.orgs = { org1: { subscription_status: "trialing", disabled_modules: [] } };
    const res = await middleware(protectedRequest());
    expect(redirectTo(res, "/settings/security")).toBe(false);
    expect(redirectTo(res, "/login")).toBe(false);
  });

  it("a plain member is never forced to enrol", async () => {
    cfg.memberships = [{ org_id: "org1", role: "member", allowed_modules: null }];
    cfg.orgs = { org1: { subscription_status: "active", disabled_modules: [] } };
    expect(redirectTo(await middleware(protectedRequest()), "/settings/security")).toBe(false);
  });

  it("a privileged user WITH a verified factor (stepped up) is not forced anywhere", async () => {
    cfg.isSuperAdmin = true;
    cfg.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    const res = await middleware(protectedRequest());
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
    const res = await middleware(protectedRequest());
    expect(redirectTo(res, "/mfa-challenge")).toBe(true);
  });
});

describe("security re-audit round 3, item 1: multi-org active-org resolution matches Server Actions (resolveActiveOrgId), not an arbitrary first row", () => {
  it("member in A / admin in B / B active (cookie=orgB) — MFA gate evaluates the ACTIVE org (B), not an arbitrary membership", async () => {
    cfg.memberships = [
      { org_id: "orgA", role: "member", allowed_modules: null },
      { org_id: "orgB", role: "admin", allowed_modules: null },
    ];
    cfg.orgs = {
      orgA: { subscription_status: "active", disabled_modules: [] },
      orgB: { subscription_status: "active", disabled_modules: [] },
    };
    // Cookie says orgB is active — orgB's role (admin) + paid plan must
    // trigger the MFA-enrolment gate. Before this fix, an unordered
    // .limit(1) could just as easily have resolved orgA (member) and
    // silently skipped MFA enforcement for a user who's actually acting as
    // an admin.
    const res = await middleware(protectedRequest("orgB"));
    expect(redirectTo(res, "/settings/security")).toBe(true);
  });

  it("admin in A / member in B / B active (cookie=orgB) — no MFA gate, since the ACTIVE org (B) is only a member role", async () => {
    cfg.memberships = [
      { org_id: "orgA", role: "admin", allowed_modules: null },
      { org_id: "orgB", role: "member", allowed_modules: null },
    ];
    cfg.orgs = {
      orgA: { subscription_status: "active", disabled_modules: [] },
      orgB: { subscription_status: "active", disabled_modules: [] },
    };
    const res = await middleware(protectedRequest("orgB"));
    expect(redirectTo(res, "/settings/security")).toBe(false);
  });

  it("stale/invalid active-org cookie (points at an org the user no longer belongs to) falls back to the first real membership, not a crash or a phantom org", async () => {
    cfg.memberships = [{ org_id: "orgA", role: "owner", allowed_modules: null }];
    cfg.orgs = { orgA: { subscription_status: "active", disabled_modules: [] } };
    // Cookie names an org that isn't in cfg.memberships at all.
    const res = await middleware(protectedRequest("orgC-not-a-real-membership"));
    // Falls back to orgA (owner, paid) — still correctly gated on MFA,
    // proving the stale cookie didn't silently bypass the check or crash.
    expect(redirectTo(res, "/settings/security")).toBe(true);
  });

  it("with no cookie at all, resolves the first membership — same deterministic fallback resolveActiveOrgId documents", async () => {
    cfg.memberships = [
      { org_id: "orgA", role: "owner", allowed_modules: null },
      { org_id: "orgB", role: "member", allowed_modules: null },
    ];
    cfg.orgs = {
      orgA: { subscription_status: "active", disabled_modules: [] },
      orgB: { subscription_status: "active", disabled_modules: [] },
    };
    const res = await middleware(protectedRequest());
    expect(redirectTo(res, "/settings/security")).toBe(true); // orgA (owner) resolved, not orgB
  });

  it("module-block check also uses the ACTIVE org's own disabled_modules, not an arbitrary membership's org", async () => {
    cfg.memberships = [
      { org_id: "orgA", role: "member", allowed_modules: null },
      { org_id: "orgB", role: "member", allowed_modules: null },
    ];
    // orgA blocks the instances module (module identity is its href, per
    // findBlockedModule in module-nav.tsx); orgB doesn't. With orgB active
    // via the cookie, the block must NOT apply.
    cfg.orgs = {
      orgA: { subscription_status: "active", disabled_modules: ["/settings/instances"] },
      orgB: { subscription_status: "active", disabled_modules: [] },
    };
    const res = await middleware(protectedRequest("orgB"));
    const loc = res?.headers.get("location");
    const blockedParam = loc ? new URL(loc).searchParams.get("blocked") : null;
    expect(blockedParam).toBeNull();
  });
});
