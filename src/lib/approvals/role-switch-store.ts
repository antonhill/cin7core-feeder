import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";
import { activeFor, parseSwitchEmails, switchHeldRoles, type SwitchRole, type SwitchState } from "./active-role";
import { selectedRoleFor } from "./active-role-session";

// POC ROLE SWITCH, server side. Kept apart from role-store.ts (which it must not import: role-store uses it). With NEWQUIP_ROLE_SWITCH_EMAILS unset (the default) every
// function here returns "not a switch user" before touching the database, so nothing changes for anyone until the allowlist is deliberately set.
type Db = ReturnType<typeof createServiceRoleClient>;

/**
 * The roles a person may switch between: non-null only for someone on the server-side allowlist, in the NewQuip test organisation, with at least two EXPLICIT
 * assignments among Rep / Estimator / Manager. Everyone else (René, any single-role user, every other organisation) gets null.
 */
export async function switchHeldFor(db: Db, orgId: string, userId: string): Promise<readonly SwitchRole[] | null> {
  const allowlist = parseSwitchEmails(process.env.NEWQUIP_ROLE_SWITCH_EMAILS);
  if (allowlist.size === 0) return null;
  const r = await db.from("org_functional_roles").select("user_id, role").eq("org_id", orgId);
  if (r.error) return null; // fail closed: no switch (the ordinary role resolution is unaffected)
  const assigned = ((r.data ?? []) as Array<{ user_id: string; role: string }>).filter((a) => a.user_id === userId).map((a) => a.role);
  if (assigned.length < 2) return null;
  const u = await db.auth.admin.getUserById(userId);
  return switchHeldRoles({ orgId, email: u.data?.user?.email ?? null, assigned, allowlist });
}

/** The active role: a verified selection of a role they hold, else the least-privileged one. */
export async function resolveSwitchState(db: Db, orgId: string, userId: string): Promise<SwitchState | null> {
  const held = await switchHeldFor(db, orgId, userId);
  if (!held) return null;
  return { held, ...activeFor(held, await selectedRoleFor(orgId, userId)) };
}

/** The organisation admin tier counts only while a switch user acts as Manager; in Rep or Estimator mode it grants nothing. Everyone else is unchanged. */
export async function narrowTier(db: Db, orgId: string, userId: string, adminTier: boolean): Promise<boolean> {
  if (!adminTier) return false;
  const sw = await resolveSwitchState(db, orgId, userId);
  return sw ? sw.active === "MANAGER" : true;
}
