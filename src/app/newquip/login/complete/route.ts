import { NextRequest, NextResponse } from "next/server";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { ACTIVE_ORG_COOKIE } from "@/lib/active-org-resolution";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { NEWQUIP_LOGIN_PATH, NEWQUIP_NO_ACCESS_MESSAGE, safeNewquipNext } from "@/newquip/entry";

export const dynamic = "force-dynamic";

/**
 * Runs on a NEW document request after client-side verifyOtp succeeds.
 * The freshly set Supabase session cookie is now available to middleware and
 * to this handler, unlike a same-tick Server Action from the OTP callback.
 * Every access decision remains server-side and organisation-scoped.
 */
export async function GET(request: NextRequest) {
  const fallback = new URL(NEWQUIP_LOGIN_PATH, request.url);
  const fail = (reason: string) => {
    fallback.searchParams.set("error", reason);
    return NextResponse.redirect(fallback);
  };

  try {
    const session = await createSessionClient();
    const { data: { user }, error: authError } = await session.auth.getUser();
    if (authError || !user) return fail("session");

    const db = createServiceRoleClient();
    const [{ data: memberships, error: membershipError }, { data: admin, error: adminError }] = await Promise.all([
      db.from("org_members").select("org_id").eq("user_id", user.id),
      db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
    ]);

    if (membershipError || adminError) {
      console.error("newquip login completion: membership lookup failed", { membershipError: !!membershipError, adminError: !!adminError });
      return fail("lookup");
    }

    const orgId = (memberships ?? []).map(m => m.org_id).find(id => NEWQUIP_POC_ORG_IDS.includes(id));
    if (!orgId && !admin) {
      await session.auth.signOut();
      return fail("access");
    }

    const target = safeNewquipNext(request.nextUrl.searchParams.get("next")) ?? "/";
    const response = NextResponse.redirect(new URL(target, request.url));
    if (orgId) {
      response.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
        httpOnly: true, secure: process.env.NODE_ENV === "production",
        sameSite: "lax", path: "/",
      });
    }
    return response;
  } catch (error) {
    console.error("newquip login completion: unexpected failure", error instanceof Error ? error.name : "unknown");
    return fail("unexpected");
  }
}
