import "server-only";
import { cookies } from "next/headers";
import { ACTIVE_ROLE_COOKIE, type SwitchRole } from "./active-role";
import { verifyActiveRole } from "./active-role-token";

/** The role this person's browser chose for this organisation, only if the signed record is genuine, unexpired and bound to THIS user and organisation. Outside a request (tests, cron) there is no selection. */
export async function selectedRoleFor(orgId: string, userId: string): Promise<SwitchRole | null> {
  try {
    const claims = verifyActiveRole((await cookies()).get(ACTIVE_ROLE_COOKIE)?.value);
    return claims && claims.user === userId && claims.org === orgId ? claims.role : null;
  } catch {
    return null;
  }
}
