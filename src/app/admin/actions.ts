"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { deleteOrganizationById } from "@/lib/delete-organization";
import { uploadOrgLogoForOrgId, type UploadLogoResult } from "@/lib/org-logo";

export interface OrgMember {
  userId: string;
  email: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  createdAt: string;
  members: OrgMember[];
  instanceCount: number;
  logoUrl: string | null;
  /** Module hrefs (e.g. "/reports") hidden from this org. Empty means every module is visible. */
  disabledModules: string[];
  subscriptionStatus: string;
  trialEndsAt: string | null;
}

export interface ListOrgsResult {
  ok: boolean;
  error?: string;
  orgs?: OrgSummary[];
}

/** Every org, with member emails and instance counts — the /admin overview. */
export async function listOrgsForAdmin(): Promise<ListOrgsResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { data: orgs, error: orgsError } = await db
      .from("organizations")
      .select("id, name, created_at, logo_url, disabled_modules, subscription_status, trial_ends_at")
      .order("created_at", { ascending: false });
    if (orgsError) throw new Error(orgsError.message);

    const { data: members, error: membersError } = await db.from("org_members").select("org_id, user_id");
    if (membersError) throw new Error(membersError.message);

    const { data: instances, error: instancesError } = await db.from("cin7_instances").select("org_id");
    if (instancesError) throw new Error(instancesError.message);

    // auth.users isn't queryable via the regular client — resolve emails via the Admin API.
    const userIds = [...new Set((members ?? []).map((m) => m.user_id))];
    const emailByUserId = new Map<string, string>();
    for (const userId of userIds) {
      const { data } = await db.auth.admin.getUserById(userId);
      if (data.user?.email) emailByUserId.set(userId, data.user.email);
    }

    const instanceCountByOrg = new Map<string, number>();
    for (const inst of instances ?? []) {
      instanceCountByOrg.set(inst.org_id, (instanceCountByOrg.get(inst.org_id) ?? 0) + 1);
    }

    const membersByOrg = new Map<string, OrgMember[]>();
    for (const m of members ?? []) {
      const list = membersByOrg.get(m.org_id) ?? [];
      const email = emailByUserId.get(m.user_id);
      if (email) list.push({ userId: m.user_id, email });
      membersByOrg.set(m.org_id, list);
    }

    const result: OrgSummary[] = (orgs ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.created_at,
      members: membersByOrg.get(o.id) ?? [],
      instanceCount: instanceCountByOrg.get(o.id) ?? 0,
      logoUrl: o.logo_url,
      disabledModules: o.disabled_modules ?? [],
      subscriptionStatus: o.subscription_status,
      trialEndsAt: o.trial_ends_at,
    }));

    return { ok: true, orgs: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface CreateOrgResult {
  ok: boolean;
  error?: string;
}

/**
 * Creates a new org and invites its first user by email — no self-serve
 * signup, no org ID/passphrase ever shown to them. Supabase's own invite
 * email carries a magic link that signs the recipient straight in.
 */
export async function createOrgAndInvite(orgName: string, email: string): Promise<CreateOrgResult> {
  if (!orgName.trim()) return { ok: false, error: "Organization name is required." };
  if (!email.trim()) return { ok: false, error: "Email is required." };

  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: orgName.trim() })
      .select("id")
      .single();
    if (orgError) return { ok: false, error: orgError.message };

    const { data: invite, error: inviteError } = await db.auth.admin.inviteUserByEmail(email.trim());
    if (inviteError) return { ok: false, error: inviteError.message };
    if (!invite.user) return { ok: false, error: "Invite succeeded but returned no user." };

    const { error: memberError } = await db
      .from("org_members")
      .insert({ org_id: org.id, user_id: invite.user.id, role: "owner" });
    if (memberError) return { ok: false, error: memberError.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Adds an additional member to an already-existing org. If the email has
 * never signed up, sends the same Supabase invite as a brand-new org
 * (magic link, no passphrase) — if the person already has an account
 * (e.g. they belong to another org already), inviteUserByEmail correctly
 * rejects as "already registered", so this falls back to looking them up
 * by email and just adding the membership row.
 */
export async function inviteMemberToOrg(orgId: string, email: string): Promise<CreateOrgResult> {
  const trimmedEmail = email.trim();
  if (!trimmedEmail) return { ok: false, error: "Email is required." };

  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { data: invite, error: inviteError } = await db.auth.admin.inviteUserByEmail(trimmedEmail);

    let userId: string;
    if (inviteError) {
      const { data: existing, error: listError } = await db.auth.admin.listUsers();
      if (listError) return { ok: false, error: listError.message };
      const match = existing.users.find((u) => u.email?.toLowerCase() === trimmedEmail.toLowerCase());
      if (!match) return { ok: false, error: inviteError.message };
      userId = match.id;
    } else if (!invite.user) {
      return { ok: false, error: "Invite succeeded but returned no user." };
    } else {
      userId = invite.user.id;
    }

    const { error: memberError } = await db.from("org_members").insert({ org_id: orgId, user_id: userId, role: "member" });
    if (memberError) {
      if (memberError.code === "23505") return { ok: false, error: "That person is already a member of this org." };
      return { ok: false, error: memberError.message };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Removes a user's membership from an org — just the org_members row, not
 * their Supabase Auth account, and not anything else the user might own
 * (they may still belong to other orgs). Scoped to (org_id, user_id) so it
 * can never remove a membership in the wrong org even if called with a
 * stale/mismatched pair.
 */
export async function removeMemberFromOrg(orgId: string, userId: string): Promise<CreateOrgResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { error } = await db.from("org_members").delete().eq("org_id", orgId).eq("user_id", userId);
    if (error) return { ok: false, error: error.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Sets the full list of module hrefs hidden from an org — replaces
 * whatever was there before rather than adding/removing one at a time,
 * since the admin UI always sends the complete desired state after a
 * checkbox toggle. Disabled modules are hidden from that org's nav/home
 * tiles AND blocked at the URL level by middleware.ts — this isn't just
 * cosmetic.
 */
export async function setOrgDisabledModules(orgId: string, disabledModules: string[]): Promise<CreateOrgResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { error } = await db.from("organizations").update({ disabled_modules: disabledModules }).eq("id", orgId);
    if (error) return { ok: false, error: error.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export type { UploadLogoResult };

/**
 * Uploads a logo for an org into the public "org-logos" storage bucket
 * (created in migration 0012) and records its public URL on the org row.
 * Shown in that org's own nav bar, and as a thumbnail on this admin list.
 * The upload/DB-write logic itself is shared with the org's own self-serve
 * upload (see src/lib/org-logo.ts) — this wrapper is just the super-admin
 * authorization for acting on an arbitrary orgId.
 */
export async function uploadOrgLogo(orgId: string, formData: FormData): Promise<UploadLogoResult> {
  try {
    await requireSuperAdmin();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  return uploadOrgLogoForOrgId(orgId, formData);
}

/**
 * Permanently deletes an organization and every row scoped to it (cascades
 * — see deleteOrganizationById). Irreversible, so the caller must pass the
 * org's exact current name as confirmation — checked server-side against a
 * fresh read (not trusted from the client), so this can't be bypassed by
 * calling the action directly without going through the UI's own
 * type-the-name-to-confirm step.
 */
export async function deleteOrganization(orgId: string, confirmName: string): Promise<CreateOrgResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const { data: org, error: fetchError } = await db.from("organizations").select("name").eq("id", orgId).single();
    if (fetchError) return { ok: false, error: fetchError.message };
    if (confirmName.trim() !== org.name) return { ok: false, error: "Organization name didn't match — nothing was deleted." };

    return await deleteOrganizationById(db, orgId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
