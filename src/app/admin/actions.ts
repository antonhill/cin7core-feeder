"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireSuperAdmin } from "@/lib/require-super-admin";

export interface OrgSummary {
  id: string;
  name: string;
  createdAt: string;
  memberEmails: string[];
  instanceCount: number;
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
      .select("id, name, created_at")
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

    const memberEmailsByOrg = new Map<string, string[]>();
    for (const m of members ?? []) {
      const list = memberEmailsByOrg.get(m.org_id) ?? [];
      const email = emailByUserId.get(m.user_id);
      if (email) list.push(email);
      memberEmailsByOrg.set(m.org_id, list);
    }

    const result: OrgSummary[] = (orgs ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.created_at,
      memberEmails: memberEmailsByOrg.get(o.id) ?? [],
      instanceCount: instanceCountByOrg.get(o.id) ?? 0,
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
