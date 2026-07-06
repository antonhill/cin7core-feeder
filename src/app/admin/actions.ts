"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireSuperAdmin } from "@/lib/require-super-admin";

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
      .select("id, name, created_at, logo_url")
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

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export interface UploadLogoResult {
  ok: boolean;
  error?: string;
  logoUrl?: string;
}

/**
 * Uploads a logo for an org into the public "org-logos" storage bucket
 * (created in migration 0012) and records its public URL on the org row.
 * Shown in that org's own nav bar, and as a thumbnail on this admin list.
 */
export async function uploadOrgLogo(orgId: string, formData: FormData): Promise<UploadLogoResult> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file first." };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "Logo must be under 2MB." };
  const ext = ALLOWED_LOGO_TYPES[file.type];
  if (!ext) return { ok: false, error: "Logo must be a PNG, JPEG, WebP, or SVG image." };

  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();

    const path = `${orgId}/logo.${ext}`;
    const { error: uploadError } = await db.storage
      .from("org-logos")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) return { ok: false, error: uploadError.message };

    // Bust CDN/browser caching on re-upload — the path is stable (upsert
    // overwrites in place) so without a cache-busting param the org's nav
    // would keep showing the old logo until a hard refresh.
    const { data: publicUrlData } = db.storage.from("org-logos").getPublicUrl(path);
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const { error: updateError } = await db.from("organizations").update({ logo_url: logoUrl }).eq("id", orgId);
    if (updateError) return { ok: false, error: updateError.message };

    return { ok: true, logoUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
