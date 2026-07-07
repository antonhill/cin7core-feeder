import { cookies } from "next/headers";
import { createServiceRoleClient } from "@/supabase/server";

/**
 * Cookie name shared conceptually with middleware.ts's own copy of this
 * string (middleware reads it via NextRequest's cookie API, not
 * next/headers, so it can't import this constant directly without risking
 * an Edge-bundling issue from pulling in next/headers — keep both in sync by
 * hand if this ever changes).
 */
export const IMPERSONATED_ORG_COOKIE = "impersonated_org_id";

/**
 * Which org a super-admin is currently "viewing as," if any — verifies the
 * org still exists (it could've been deleted since the cookie was set)
 * rather than trusting the cookie value blindly. Callers MUST already have
 * confirmed super-admin status before calling this; the cookie is only ever
 * a "which org," never an authorization grant on its own — every read still
 * goes through the normal service-role-gated server actions exactly as if
 * the super-admin were a real member.
 */
export async function getImpersonatedOrgId(): Promise<string | null> {
  const cookieStore = await cookies();
  const orgId = cookieStore.get(IMPERSONATED_ORG_COOKIE)?.value;
  if (!orgId) return null;

  const db = createServiceRoleClient();
  const { data } = await db.from("organizations").select("id").eq("id", orgId).maybeSingle();
  return data?.id ?? null;
}
