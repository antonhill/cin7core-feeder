"use server";

// Deliberately a standalone implementation, NOT importing from
// src/app/admin/actions.ts, even though inviteMemberToOrg/removeMemberFromOrg
// there do almost the same thing. An earlier attempt this session to share
// upload logic between a super-admin action and a new self-serve action via
// an extracted src/lib/ helper caused an unreproduced "Server Components
// render" 500 in production, specific to that admin/self-serve pairing —
// reverted to two independent implementations rather than keep guessing at
// the exact cause. Mirroring (not importing) the same logic here avoids the
// same failure class. This is a narrow lesson, not "never share code" —
// requireCurrentOrg/billing.ts/computeEffectiveDisabledModules are all
// already safely shared across admin and non-admin code; the specific thing
// to avoid is a brand-new shared helper whose only two callers are one admin
// action and one brand-new self-serve action.

import { createServiceRoleClient } from "@/supabase/server";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requirePrivilegedOrgAdmin } from "@/lib/require-privileged";
import { MODULES } from "@/app/module-nav";
import { isNewquipPocOrg } from "@/newquip/access";
import { normaliseModulesToSave } from "@/newquip/toolbox-access";

export interface TeamMember {
  userId: string;
  email: string;
  role: string;
  /** null = unrestricted (sees every module the org allows); a non-null array is an explicit allow-list. */
  allowedModules: string[] | null;
}

export interface ListTeamMembersResult {
  ok: boolean;
  error?: string;
  members?: TeamMember[];
  /** True for the NewQuip organisation, where allowed_modules is an explicit grant list of main Toolbox modules (null/empty = none) rather than "null = everything". */
  newquipOnly?: boolean;
  /** NewQuip only: the signed-in caller, so the screen can show that an administrator cannot change their own grants. */
  callerUserId?: string;
}

export interface ModuleAuditEntry {
  id: string;
  targetEmail: string | null;
  actorEmail: string | null;
  previousModules: string[] | null;
  newModules: string[] | null;
  changedAt: string;
}

/** Every member of the caller's own org, with email resolved via the Admin API (auth.users isn't queryable via the regular client) — same pattern as listOrgsForAdmin. */
export async function listTeamMembersAction(): Promise<ListTeamMembersResult> {
  try {
    const { orgId, userId: callerId } = await requireOrgAdmin();
    const db = createServiceRoleClient();

    const { data: members, error } = await db
      .from("org_members")
      .select("user_id, role, allowed_modules")
      .eq("org_id", orgId);
    if (error) throw new Error(error.message);

    const result: TeamMember[] = [];
    for (const m of members ?? []) {
      const { data } = await db.auth.admin.getUserById(m.user_id);
      if (!data.user?.email) continue;
      result.push({ userId: m.user_id, email: data.user.email, role: m.role, allowedModules: m.allowed_modules });
    }

    return { ok: true, members: result, newquipOnly: isNewquipPocOrg(orgId), callerUserId: callerId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface TeamActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Invites a new teammate to the caller's own org — orgId comes from the
 * session (requireOrgAdmin), never a client-supplied param, so an org
 * owner/admin can only ever invite into their own org. Mirrors
 * inviteMemberToOrg's invite-or-look-up-existing-user fallback: if the
 * email already has an account, inviteUserByEmail correctly rejects as
 * "already registered" and this falls back to finding them by email and
 * just adding the membership row. Known pre-existing limitation being
 * knowingly inherited, not introduced: listUsers() is paginated (50/page
 * default) and this only scans the first page, so a fallback lookup could
 * miss an existing user past page 1 at high enough total user counts — a
 * generous perPage keeps this a non-issue at this app's actual scale
 * without fully solving it for arbitrary scale.
 */
export async function inviteTeamMemberAction(email: string): Promise<TeamActionResult> {
  const trimmedEmail = email.trim();
  if (!trimmedEmail) return { ok: false, error: "Email is required." };

  try {
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — grants a new person access to the org.
    const { orgId } = await requirePrivilegedOrgAdmin("invite a team member");
    const db = createServiceRoleClient();

    const { data: invite, error: inviteError } = await db.auth.admin.inviteUserByEmail(trimmedEmail);

    let userId: string;
    if (inviteError) {
      const { data: existing, error: listError } = await db.auth.admin.listUsers({ perPage: 1000 });
      if (listError) return { ok: false, error: listError.message };
      const match = existing.users.find((u) => u.email?.toLowerCase() === trimmedEmail.toLowerCase());
      if (!match) return { ok: false, error: inviteError.message };
      userId = match.id;
    } else if (!invite.user) {
      return { ok: false, error: "Invite succeeded but returned no user." };
    } else {
      userId = invite.user.id;
    }

    const { error: memberError } = await db.from("org_members").insert({ org_id: orgId, user_id: userId, role: "member", allowed_modules: null });
    if (memberError) {
      if (memberError.code === "23505") return { ok: false, error: "That person is already a member of this org." };
      return { ok: false, error: memberError.message };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Removes a teammate from the caller's own org — refuses self-removal, since a team member locking themselves out (accidentally or otherwise) has no recovery path short of a super-admin fixing it via /admin. */
export async function removeTeamMemberAction(userId: string): Promise<TeamActionResult> {
  try {
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — revokes a person's org access.
    const { orgId, userId: callerId } = await requirePrivilegedOrgAdmin("remove a team member");
    if (userId === callerId) return { ok: false, error: "You can't remove yourself." };

    const db = createServiceRoleClient();
    const { error } = await db.from("org_members").delete().eq("org_id", orgId).eq("user_id", userId);
    if (error) return { ok: false, error: error.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Sets a teammate's module allow-list. Outside the NewQuip organisation: null clears any restriction (unrestricted), a non-null array (including an empty one, meaning
 * "denied everything") is the explicit allow-list. In the NewQuip organisation the list is the person's grant of MAIN Toolbox modules (see src/newquip/toolbox-access.ts):
 * stored as an explicit array (null is stored as [] = none), NewQuip's own workspace keys are not grantable, and an administrator cannot change their OWN grants. NewQuip
 * Grower access is independent of this list. Every change is written together with its audit row by set_member_modules() (one transaction: previous, new, actor, time).
 * The organisation always comes from the session, never from the request.
 */
export async function setTeamMemberModulesAction(userId: string, allowedModules: string[] | null): Promise<TeamActionResult> {
  try {
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — changes a person's permissions.
    const { orgId, userId: callerId, email: callerEmail } = await requirePrivilegedOrgAdmin("change a team member's module access");
    const newquipOnly = isNewquipPocOrg(orgId);
    const norm = normaliseModulesToSave({ newquipOnly, modules: allowedModules, registryHrefs: MODULES.map((m) => m.href) });
    if (!norm.ok) return { ok: false, error: norm.error };
    if (newquipOnly && userId === callerId) return { ok: false, error: "You can't change your own Toolbox access. Ask another administrator." };

    const db = createServiceRoleClient();
    // The target must be a member of THIS organisation (never trust the supplied id); the same read resolves the email recorded in the audit row.
    const { data: member, error: memberError } = await db.from("org_members").select("user_id").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
    if (memberError) return { ok: false, error: memberError.message };
    if (!member) return { ok: false, error: "That person is not a member of this organization." };
    const { data: target } = await db.auth.admin.getUserById(userId);

    const { error } = await db.rpc("set_member_modules", {
      p_org_id: orgId,
      p_user_id: userId,
      p_modules: norm.modules,
      p_actor_user_id: callerId,
      p_actor_email: callerEmail,
      p_target_email: target.user?.email ?? null,
    });
    if (error) return { ok: false, error: error.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** The most recent module-access changes in the caller's own organisation (who changed whose access, from what, to what, when). Org owner/admin only; org from the session. */
export async function listModuleAuditAction(): Promise<{ ok: boolean; error?: string; entries?: ModuleAuditEntry[] }> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("org_member_module_audit")
      .select("id, target_email, actor_email, previous_modules, new_modules, changed_at")
      .eq("org_id", orgId)
      .order("changed_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return {
      ok: true,
      entries: (data ?? []).map((r) => ({ id: r.id, targetEmail: r.target_email, actorEmail: r.actor_email, previousModules: r.previous_modules, newModules: r.new_modules, changedAt: r.changed_at })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
