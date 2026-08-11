import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A chainable Supabase-query stub: every builder method returns itself, and
// the terminal .maybeSingle() resolves to no row. Enough for the org-member /
// super-admin lookups the module-block branch makes.
function queryStub() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null });
  return chain;
}

// getClaims() behaviour is swapped per-test via this holder.
let getClaims: () => Promise<{ data: { claims: { sub: string } | null } | null }>;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: () => getClaims(),
      exchangeCodeForSession: async () => ({ error: null }),
      mfa: {
        // aal1 == nextLevel → no MFA step-up required, so the MFA gate is a
        // no-op and we exercise the auth gate itself.
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal1" },
        }),
      },
    },
    from: () => queryStub(),
  }),
}));

vi.mock("@/supabase/server", () => ({
  createServiceRoleClient: () => ({ from: () => queryStub() }),
}));

import { middleware } from "@/middleware";

const PROTECTED = "https://app.example.com/settings/instances";

function loginRedirect(res: Response | undefined) {
  if (!res) return false;
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!loc && new URL(loc).pathname === "/login";
}

describe("middleware auth gate (fail-closed)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  });

  it("redirects to /login when there is no verifiable session", async () => {
    getClaims = async () => ({ data: null });
    const res = await middleware(new NextRequest(PROTECTED));
    expect(loginRedirect(res)).toBe(true);
  });

  it("FAILS CLOSED — redirects to /login when getClaims() throws (was fail-open on 429)", async () => {
    getClaims = async () => {
      throw new Error("jwks unreachable / rate-limited");
    };
    const res = await middleware(new NextRequest(PROTECTED));
    // The whole point of this phase: an unverifiable auth check must NOT let
    // the request through to a protected route.
    expect(loginRedirect(res)).toBe(true);
  });

  it("lets a verified session reach a protected route (no login redirect)", async () => {
    getClaims = async () => ({ data: { claims: { sub: "user-123" } } });
    const res = await middleware(new NextRequest(PROTECTED));
    expect(loginRedirect(res)).toBe(false);
  });
});
