import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { findBlockedModule } from "@/app/module-nav";
import { createServiceRoleClient } from "@/supabase/server";

// Must match src/lib/org-switch.ts's IMPERSONATED_ORG_COOKIE — duplicated
// rather than imported, since that module calls next/headers' cookies() and
// middleware uses NextRequest's own cookie API instead.
const IMPERSONATED_ORG_COOKIE = "impersonated_org_id";

const PUBLIC_PATHS = ["/login", "/auth/callback", "/privacy", "/signup"];

/**
 * Refreshes the Supabase session cookie on every request (required — the
 * access token expires and must be rotated server-side, this is the
 * standard Supabase+Next.js App Router pattern) and redirects unauthenticated
 * users to /login for anything else.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // Handles the magic-link code landing on ANY path, not just /auth/callback
  // — if Supabase's redirect-URL allowlist (Dashboard > Authentication > URL
  // Configuration) doesn't include /auth/callback, it silently falls back to
  // the bare Site URL, dropping ?code= on "/" instead. Exchanging it here,
  // regardless of path, makes login work even before that's configured.
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete("code");
    return NextResponse.redirect(cleanUrl);
  }

  const {
    data: { user },
    error: getUserError,
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));
  // The root path is public too, but can't just join PUBLIC_PATHS — that
  // array is prefix-matched (startsWith), and "/" prefixes every path, which
  // would make the whole app public. An exact-match check keeps this narrow:
  // src/app/page.tsx itself decides marketing-page vs dashboard based on
  // whether a session exists.
  const isRoot = request.nextUrl.pathname === "/";

  // getUser() validates the token against Supabase's Auth API on every
  // request — under heavy testing volume (or any transient network blip)
  // that call itself can be rate-limited/fail, which previously looked
  // identical to "not logged in" and bounced a genuinely signed-in user
  // back to /login. A rate-limit (429) specifically means "couldn't check",
  // not "not authenticated" — fail open just for that narrow case rather
  // than treating every possible error the same as a real logged-out user.
  if (getUserError && getUserError.status === 429) {
    console.error("middleware: getUser() rate-limited, allowing request through without a fresh check", getUserError);
    return response;
  }

  if (!user && !isPublic && !isRoot) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // A signed-in user who's enrolled a verified TOTP factor but hasn't
  // completed it yet this session (currentLevel aal1, nextLevel aal2) must
  // clear /mfa-challenge before reaching anything else — email-code sign-in
  // alone only ever proves aal1. Checked before the blocked-module logic
  // below so a half-authenticated session can't route around MFA by hitting
  // a disabled-module redirect first.
  if (user) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const needsMfa = Boolean(aal && aal.nextLevel === "aal2" && aal.currentLevel !== aal.nextLevel);
    const onMfaChallenge = request.nextUrl.pathname.startsWith("/mfa-challenge");

    if (needsMfa && !onMfaChallenge) {
      const mfaUrl = request.nextUrl.clone();
      mfaUrl.pathname = "/mfa-challenge";
      mfaUrl.search = "";
      return NextResponse.redirect(mfaUrl);
    }
    // Already cleared (or never required) MFA — don't let a stale bookmark
    // strand the user on the challenge page.
    if (!needsMfa && onMfaChallenge) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      homeUrl.search = "";
      return NextResponse.redirect(homeUrl);
    }
  }

  // A module a super-admin has disabled for this org shouldn't just be
  // hidden from the nav — visiting the URL directly (bookmark, typed by
  // hand) must be blocked too, or "disabled" would only ever be cosmetic.
  // Redirects to home with the blocked module's href so the home page can
  // show a small explanation. Not org-scoped by isSuperAdmin: a super-admin
  // viewing through their own org membership is bound by that org's own
  // settings too, same as anyone else — this is deliberate, since otherwise
  // the block would never actually get exercised while testing it. A
  // super-admin currently "viewing as" another org (see
  // src/actions/org-switch.ts) is bound by THAT org's settings instead —
  // otherwise this check would silently apply the wrong org's module
  // visibility while impersonating.
  if (user && !isPublic) {
    const db = createServiceRoleClient();
    let orgId: string | null = null;

    const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (superAdminRow) {
      const impersonatedOrgId = request.cookies.get(IMPERSONATED_ORG_COOKIE)?.value;
      if (impersonatedOrgId) {
        const { data: org } = await db.from("organizations").select("id").eq("id", impersonatedOrgId).maybeSingle();
        if (org) orgId = org.id;
      }
    }

    if (!orgId) {
      const { data: membership } = await supabase.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
      orgId = membership?.org_id ?? null;
    }

    if (orgId) {
      const { data: org } = await db.from("organizations").select("disabled_modules").eq("id", orgId).maybeSingle();
      const disabledModules: string[] = org?.disabled_modules ?? [];
      const blockedModule = findBlockedModule(request.nextUrl.pathname, disabledModules);
      if (blockedModule) {
        const homeUrl = request.nextUrl.clone();
        homeUrl.pathname = "/";
        homeUrl.search = "";
        homeUrl.searchParams.set("blocked", blockedModule.href);
        return NextResponse.redirect(homeUrl);
      }
    }
  }

  // An already-signed-in user landing back on /login (e.g. after a
  // successful sign-in the login form is still on screen, or a bookmark)
  // would otherwise just see the form again — resubmitting a stale code
  // there fails confusingly since one-time codes can't be reused, even
  // though they're already logged in. Send them straight into the app.
  // Same treatment for /signup — an already-signed-in user re-visiting it
  // (e.g. to start a "new" trial without signing out first) would otherwise
  // see their *previous* org's trial banner rendered on top of the signup
  // form (confirmed live 2026-07-07), and createSelfServeOrgAction would
  // silently discard the org name they typed and reuse their existing
  // membership instead — confusing either way. You can't have two accounts
  // in one session; sign out first to genuinely start a second trial.
  if (user && (request.nextUrl.pathname.startsWith("/login") || request.nextUrl.pathname.startsWith("/signup"))) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

// api/sync (and api/sync-sales, api/sync-purchases, api/sync-assembly-builds,
// api/sync-product-availability — all matched by the same "api/sync" prefix),
// api/import, and api/delete-expired-trials all authenticate themselves via a bearer token
// (assertInternalAuth) for external/Cron callers with no browser session —
// they must never be intercepted by the session-cookie redirect below, or
// Vercel Cron's bearer-token request just gets bounced to /login and the
// job silently never runs.
// icon.svg is Next's file-convention favicon route — it must be reachable
// with no session too, or the browser's (unauthenticated) request for it
// gets swallowed by the login redirect and the favicon never loads.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api/sync|api/import|api/delete-expired-trials).*)"],
};
