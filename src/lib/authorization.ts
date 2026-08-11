import "server-only";

import { requireCurrentOrg, type CurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";
import { createServiceRoleClient } from "@/supabase/server";
import { computeEffectiveDisabledModules, findBlockedModule } from "@/app/module-nav";

/**
 * Centralized module-level authorization for Server Actions.
 *
 * WHY THIS EXISTS. Module visibility (`organizations.disabled_modules`, set
 * per-org by a super-admin; `org_members.allowed_modules`, set per-member by an
 * org owner/admin) was until now enforced in only two places, BOTH of which a
 * Server Action can slip past:
 *   - the nav (cosmetic — just hides tiles), and
 *   - `middleware.ts`, which blocks direct URL navigation by matching
 *     `request.nextUrl.pathname` against the disabled module's href.
 * A Server Action is a POST whose path is the *referer page*, not the action's
 * own module — so a crafted request can invoke, say, an `/import` action while
 * sitting on an allowed page, and middleware's path check never fires. The
 * action's own `requireCurrentOrg()` proves "a member of this org", but NOT
 * "a member allowed to use THIS module". This layer is that missing check, run
 * inside the action itself where it can't be routed around.
 *
 * It deliberately reuses `computeEffectiveDisabledModules` / `findBlockedModule`
 * from module-nav — the exact same combination logic middleware uses — so the
 * action gate and the URL gate can never drift apart.
 *
 * Capability model (how the brief's capability names map to concrete guards,
 * so this stays one place rather than scattered ad-hoc calls):
 *   - reports.read / *.view      -> requireModuleAccess(<module>.href)
 *   - imports.run / products.write / sync.run
 *                                 -> requireModuleWrite(<module>.href)
 *                                    (module access + billing write-plan gate)
 *   - instance.manage / team.manage / billing.manage
 *                                 -> requireOrgAdmin(...) [+ requireModuleAccess
 *                                    where the module is org-toggleable, e.g.
 *                                    /settings/instances]
 *   - diagnostics.run (privileged)-> requireSuperAdmin()
 * requireModuleAccess is the NEW primitive; the role/plan guards it composes
 * with already exist (require-org-admin, require-super-admin, billing).
 */

/**
 * Throw unless the current session's user may use the module identified by
 * `moduleHref` (one of the org-toggleable hrefs in module-nav's `MODULES`).
 * Returns the resolved {@link CurrentOrg} so callers don't need a second
 * `requireCurrentOrg()` round-trip.
 *
 * Semantics mirror `middleware.ts` exactly:
 *   - Resolves org via `requireCurrentOrg()` — so it's impersonation-aware (a
 *     super-admin "viewing as" an org is bound by THAT org's settings) and
 *     never trusts a client-supplied org id.
 *   - A super-admin is never restricted by a per-user `allowed_modules`
 *     allow-list, but IS still bound by the org's `disabled_modules` — same as
 *     middleware, so a module a super-admin disabled for an org stays disabled
 *     for them while impersonating it.
 *   - Passing a href that isn't an org-toggleable module (e.g. `/settings/members`,
 *     `/settings/billing`, `/reports/natas`) is always allowed here — those are
 *     gated by role/plan/single-org checks instead, not the module toggle.
 */
export async function requireModuleAccess(moduleHref: string): Promise<CurrentOrg> {
  const current = await requireCurrentOrg();
  const db = createServiceRoleClient();

  const { data: superAdminRow } = await db
    .from("super_admins")
    .select("user_id")
    .eq("user_id", current.userId)
    .maybeSingle();
  const isSuperAdmin = Boolean(superAdminRow);

  // A super-admin's module access is never narrowed by a per-user allow-list
  // (null == unrestricted), whether or not they're impersonating — mirrors
  // getCurrentUserInfo() and middleware.
  let allowedModules: string[] | null = null;
  if (!isSuperAdmin) {
    const { data: membership } = await db
      .from("org_members")
      .select("allowed_modules")
      .eq("org_id", current.orgId)
      .eq("user_id", current.userId)
      .maybeSingle();
    allowedModules = membership?.allowed_modules ?? null;
  }

  const { data: org } = await db
    .from("organizations")
    .select("disabled_modules")
    .eq("id", current.orgId)
    .maybeSingle();

  const disabledModules = computeEffectiveDisabledModules(org?.disabled_modules ?? [], allowedModules);
  if (findBlockedModule(moduleHref, disabledModules)) {
    throw new Error("You don't have access to this feature.");
  }

  return current;
}

/**
 * As {@link requireModuleAccess}, then additionally require the org's plan to
 * permit Cin7 writes (`requireWriteAllowed` — the trial/subscription gate).
 * The guard for every action that pushes changes to Cin7: it must be both a
 * module the caller may use AND an org on a writing plan.
 */
export async function requireModuleWrite(moduleHref: string): Promise<CurrentOrg> {
  const current = await requireModuleAccess(moduleHref);
  await requireWriteAllowed(current.orgId);
  return current;
}
