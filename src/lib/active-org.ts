import { cookies } from "next/headers";

export { ACTIVE_ORG_COOKIE, resolveActiveOrgId } from "@/lib/active-org-resolution";
import { ACTIVE_ORG_COOKIE } from "@/lib/active-org-resolution";

/** Reads the raw cookie value (unverified — callers must check it against the caller's real memberships via resolveActiveOrgId). */
export async function getActiveOrgCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
}
