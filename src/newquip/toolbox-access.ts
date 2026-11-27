// NewQuip-only users and the MAIN Cin7 Toolbox modules. Pure and client-safe (no server-only imports) so middleware, server actions, navigation and tests share ONE rule.
//
// THE MODEL (one permission system: org_members.allowed_modules over the existing MODULES registry, enforced by the existing middleware and requireModuleAccess):
//   * For every organisation EXCEPT NewQuip POC, allowed_modules is unchanged: null = unrestricted, an array = an explicit allow-list.
//   * For a NewQuip-only user (a NewQuip POC member who is not a super-admin) allowed_modules means ONLY "which main Toolbox modules may this person use". null and [] both mean
//     none (default-deny): the NewQuip-only default is preserved, and an empty list never grants the Toolbox.
//   * NewQuip's own workspace (Solution Builder, Approvals, Projects, Claims, Reports) is NOT a Toolbox grant. It keeps its own module keys ("/quotes" for the Grower server actions,
//     "/projects" for Projects/Approvals) and those keys are always available to a NewQuip-only user, whatever allowed_modules holds, so enabling or disabling a Toolbox module can never
//     remove Grower access. The main Toolbox Quotes screens (/quotes) are a different surface that happens to share the "/quotes" key, so they opt in with `toolbox: true` and then need
//     a real grant.
// Organisation-wide switches (organizations.disabled_modules) still win over any grant, exactly as before.

/** Module keys NewQuip's own workspace owns. Never a Toolbox grant, always available to a NewQuip-only user. */
export const NEWQUIP_NATIVE_MODULE_HREFS: readonly string[] = ["/projects"];

/** The module key the Grower server actions check. Shared with the main Toolbox Quotes screens, which therefore pass `toolbox: true` to require a real grant. */
export const NEWQUIP_GROWER_MODULE_HREF = "/quotes";

const underHref = (pathname: string, href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

/**
 * The main Toolbox modules that may be granted to a NewQuip-only user AT ALL. A deliberately small, code-reviewed list: modules that write to Cin7 or change data/config (import, migrate,
 * templates, pricing, replenish, instances, diagnostics...) are not grantable until each has been reviewed for NewQuip use and added here. Quotes first (Spares Quotations). Applied on
 * READ as well as on save, so a stray value in allowed_modules can never act as a grant.
 */
export const NEWQUIP_GRANTABLE_TOOLBOX_HREFS: readonly string[] = ["/quotes"];

/** The main Toolbox modules a NewQuip-only user has been explicitly granted: allowed_modules (null/[] = none) limited to real, grantable registry modules. */
export function toolboxGrantsOf(allowedModules: readonly string[] | null | undefined, registryHrefs: readonly string[]): string[] {
  if (!allowedModules || allowedModules.length === 0) return [];
  return [...new Set(allowedModules.filter((h) => registryHrefs.includes(h) && NEWQUIP_GRANTABLE_TOOLBOX_HREFS.includes(h) && !NEWQUIP_NATIVE_MODULE_HREFS.includes(h)))];
}

/**
 * The allow-list module visibility uses for a NewQuip-only user. `toolbox: true` is the main Toolbox surface (only real grants count); otherwise the Grower surface, where the
 * workspace's own keys are always on. Feed the result to computeEffectiveDisabledModules in place of the raw allowed_modules.
 */
export function newquipOnlyAllowList(allowedModules: readonly string[] | null | undefined, registryHrefs: readonly string[], opts: { toolbox: boolean }): string[] {
  const grants = toolboxGrantsOf(allowedModules, registryHrefs);
  return [...new Set([...grants, ...NEWQUIP_NATIVE_MODULE_HREFS, ...(opts.toolbox ? [] : [NEWQUIP_GROWER_MODULE_HREF])])];
}

/** True when `pathname` is a route of a granted Toolbox module (segment boundary: "/quotes-x" is not "/quotes"). Pure. */
export function isGrantedToolboxPath(pathname: string, grants: readonly string[]): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.includes("\\") || pathname.split("/").includes("..")) return false;
  return grants.some((g) => underHref(pathname, g));
}

/**
 * What a "save module access" request may store. Pure, so the Server Action and its tests share it.
 *  - Any organisation: every href must be a real registry module (a typo would otherwise silently do nothing).
 *  - NewQuip POC: stored as an explicit array, never null (null would read as unrestricted on a build that predates this rule); NewQuip's own workspace keys are not Toolbox
 *    grants and are rejected so they can never be (mis)used as one; duplicates collapse. An empty array is the valid "no Toolbox modules" state.
 */
export function normaliseModulesToSave(i: { newquipOnly: boolean; modules: readonly string[] | null; registryHrefs: readonly string[] }): { ok: true; modules: string[] | null } | { ok: false; error: string } {
  if (i.modules === null) return i.newquipOnly ? { ok: true, modules: [] } : { ok: true, modules: null };
  const invalid = i.modules.filter((h) => !i.registryHrefs.includes(h));
  if (invalid.length > 0) return { ok: false, error: `Not a real module: ${invalid.join(", ")}` };
  if (i.newquipOnly) {
    const native = i.modules.filter((h) => NEWQUIP_NATIVE_MODULE_HREFS.includes(h));
    if (native.length > 0) return { ok: false, error: `${native.join(", ")} belongs to the NewQuip workspace and is not a Toolbox module to grant.` };
    const notGrantable = i.modules.filter((h) => !NEWQUIP_GRANTABLE_TOOLBOX_HREFS.includes(h));
    if (notGrantable.length > 0) return { ok: false, error: `Not available to NewQuip users: ${notGrantable.join(", ")}.` };
  }
  return { ok: true, modules: [...new Set(i.modules)] };
}
