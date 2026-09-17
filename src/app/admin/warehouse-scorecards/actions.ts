"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { requirePrivilegedSuperAdmin } from "@/lib/require-privileged";

/**
 * Super-admin configuration for the Warehouse Performance scorecard engine:
 * which organisation gets which scorecard_definition, switched on or off.
 * Deliberately its OWN action file, not folded into src/app/admin/actions.ts
 * — that file's seven-action inventory is a documented, load-bearing
 * invariant elsewhere in this codebase (see Spark Knowledge's Admin note),
 * and adding an eighth here would change that count for a capability that
 * has nothing to do with organisation/membership/billing administration.
 *
 * This is the deliberate, non-hardcoded alternative to a Natas-Sold-style
 * constant: no organisation id is baked into application code anywhere in
 * this feature (see 0092's own migration comment) — assigning Lights by
 * Linea's real organisation happens here, at runtime, by a super-admin, the
 * same way any other org-specific capability is turned on today via /admin.
 */

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  moduleEnabled: boolean;
}

/** Lightweight org list for this page only — deliberately not reusing listOrgsForAdmin, which resolves member emails and instance counts this page has no use for. */
export async function listOrganizationsForScorecardAssignmentAction(): Promise<ActionResult<OrganizationSummary[]>> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("organizations").select("id, name, disabled_modules").order("name");
    if (error) throw new Error(error.message);
    return {
      ok: true,
      data: (data ?? []).map((o: { id: string; name: string; disabled_modules: string[] | null }) => ({
        id: o.id,
        name: o.name,
        moduleEnabled: !(o.disabled_modules ?? []).includes("/warehouse-performance"),
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface InstanceSummary {
  id: string;
  name: string;
}

/**
 * Lists an organisation's connected Cin7 instances, for scoping a scorecard
 * assignment to one business when a Toolbox tenant spans more than one
 * (confirmed live: "I-Light and LBL" is one organisation with two
 * instances, "Lights by Linea" and "I-Light" — without instance scoping,
 * LBL's own scorecard would silently include I-Light's orders too).
 */
export async function listOrganizationInstancesAction(organizationId: string): Promise<ActionResult<InstanceSummary[]>> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("cin7_instances").select("id, name").eq("org_id", organizationId).order("name");
    if (error) throw new Error(error.message);
    return { ok: true, data: (data ?? []) as InstanceSummary[] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ScorecardDefinitionSummary {
  id: string;
  name: string;
  active: boolean;
}

export async function listScorecardDefinitionsAction(): Promise<ActionResult<ScorecardDefinitionSummary[]>> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("scorecard_definitions").select("id, name, active").order("name");
    if (error) throw new Error(error.message);
    return { ok: true, data: (data ?? []) as ScorecardDefinitionSummary[] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface OrgScorecardAssignment {
  id: string;
  organizationId: string;
  organizationName: string;
  scorecardDefinitionId: string;
  scorecardName: string;
  enabled: boolean;
  instanceIds: string[] | null;
}

export async function listOrgScorecardAssignmentsAction(): Promise<ActionResult<OrgScorecardAssignment[]>> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("organization_scorecards")
      .select("id, organization_id, scorecard_definition_id, enabled, settings, organizations(name), scorecard_definitions(name)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return {
      ok: true,
      data: (data ?? []).map(
        (r: {
          id: string;
          organization_id: string;
          scorecard_definition_id: string;
          enabled: boolean;
          settings: { instanceIds?: string[] } | null;
          organizations: { name: string } | { name: string }[] | null;
          scorecard_definitions: { name: string } | { name: string }[] | null;
        }) => {
          const org = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
          const def = Array.isArray(r.scorecard_definitions) ? r.scorecard_definitions[0] : r.scorecard_definitions;
          const instanceIds = r.settings?.instanceIds;
          return {
            id: r.id,
            organizationId: r.organization_id,
            organizationName: org?.name ?? "Unknown",
            scorecardDefinitionId: r.scorecard_definition_id,
            scorecardName: def?.name ?? "Unknown",
            enabled: r.enabled,
            instanceIds: Array.isArray(instanceIds) && instanceIds.length > 0 ? instanceIds : null,
          };
        }
      ),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Toggles ONLY the /warehouse-performance href in an org's disabled_modules — narrower than admin/actions.ts's setOrgDisabledModules (which replaces the whole array), so this page can't accidentally clobber an org's other module choices. */
export async function setOrgWarehousePerformanceModuleAction(organizationId: string, enabled: boolean): Promise<ActionResult<null>> {
  try {
    await requirePrivilegedSuperAdmin("enable Warehouse Performance for an organization");
    const db = createServiceRoleClient();

    const { data: org, error: readError } = await db.from("organizations").select("disabled_modules").eq("id", organizationId).maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!org) return { ok: false, error: "Organization not found." };

    const current: string[] = org.disabled_modules ?? [];
    const next = enabled ? current.filter((h) => h !== "/warehouse-performance") : [...new Set([...current, "/warehouse-performance"])];

    const { error } = await db.from("organizations").update({ disabled_modules: next }).eq("id", organizationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Assigns (or re-enables) a scorecard for an organisation, or switches an
 * existing assignment on/off. The org id is always a caller-supplied
 * parameter here — this is a super-admin cross-org action by design, same
 * shape as setOrgDisabledModules, never resolved from the caller's own
 * session the way a member-facing action would be.
 */
export async function assignScorecardToOrgAction(
  organizationId: string,
  scorecardDefinitionId: string,
  enabled: boolean,
  instanceIds?: string[] | null
): Promise<ActionResult<null>> {
  try {
    await requirePrivilegedSuperAdmin("assign a Warehouse Performance scorecard to an organization");
    const db = createServiceRoleClient();

    if (enabled) {
      // At most one ENABLED scorecard per org (0092's own partial unique
      // index) — disable any other currently-enabled assignment for this
      // org first, in the same spirit as setOrgDisabledModules always
      // sending the complete desired state rather than an incremental
      // add/remove.
      const { error: disableError } = await db.from("organization_scorecards").update({ enabled: false }).eq("organization_id", organizationId).eq("enabled", true);
      if (disableError) throw new Error(disableError.message);
    }

    // instanceIds: undefined (not passed) leaves settings untouched on an
    // existing row; an explicit array (including []) replaces it. null and
    // [] both mean "every instance on the org" (see queries.ts).
    const settings = instanceIds === undefined ? undefined : { instanceIds: instanceIds ?? [] };

    const { error } = await db.from("organization_scorecards").upsert(
      {
        organization_id: organizationId,
        scorecard_definition_id: scorecardDefinitionId,
        enabled,
        ...(settings !== undefined ? { settings } : {}),
      },
      { onConflict: "organization_id,scorecard_definition_id" }
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
