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
import { MODULES } from "@/app/module-nav";

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
}

/** Every member of the caller's own org, with email resolved via the Admin API (auth.users isn't queryable via the regular client) — same pattern as listOrgsForAdmin. */
export async function listTeamMembersAction(): Promise<ListTeamMembersResult> {
  try {
    const { orgId } = await requireOrgAdmin();
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

    return { ok: true, members: result };
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
    const { orgId } = await requireOrgAdmin();
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
    const { orgId, userId: callerId } = await requireOrgAdmin();
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
 * Sets a teammate's module allow-list — null clears any restriction
 * (unrestricted, same as a freshly-invited member's default); a non-null
 * array (including an empty one, meaning "denied everything") is the new
 * explicit allow-list. Validates every href is a real module before
 * writing, since a typo'd/stale href would otherwise silently do nothing
 * rather than error.
 */
export async function setTeamMemberModulesAction(userId: string, allowedModules: string[] | null): Promise<TeamActionResult> {
  if (allowedModules !== null) {
    const validHrefs = new Set(MODULES.map((m) => m.href));
    const invalid = allowedModules.filter((href) => !validHrefs.has(href));
    if (invalid.length > 0) return { ok: false, error: `Not a real module: ${invalid.join(", ")}` };
  }

  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();

    const { error } = await db.from("org_members").update({ allowed_modules: allowedModules }).eq("org_id", orgId).eq("user_id", userId);
    if (error) return { ok: false, error: error.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
