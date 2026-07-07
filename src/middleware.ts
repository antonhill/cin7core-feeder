import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { findBlockedModule } from "@/app/module-nav";

const PUBLIC_PATHS = ["/login", "/auth/callback"];

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

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // A module a super-admin has disabled for this org shouldn't just be
  // hidden from the nav — visiting the URL directly (bookmark, typed by
  // hand) must be blocked too, or "disabled" would only ever be cosmetic.
  // Redirects to home with the blocked module's href so the home page can
  // show a small explanation. Not org-scoped by isSuperAdmin: a super-admin
  // viewing through their own org membership is bound by that org's own
  // settings too, same as anyone else — this is deliberate, since otherwise
  // the block would never actually get exercised while testing it.
  if (user && !isPublic) {
    const { data: membership } = await supabase.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (membership) {
      const { data: org } = await supabase.from("organizations").select("disabled_modules").eq("id", membership.org_id).maybeSingle();
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
  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

// api/sync and api/import authenticate themselves via a bearer token
// (assertInternalAuth) for external/Cron callers with no browser session —
// they must never be intercepted by the session-cookie redirect below.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/sync|api/import).*)"],
};
