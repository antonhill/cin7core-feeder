import { createSessionClient } from "@/supabase/server-session";

export interface CurrentOrg {
  userId: string;
  orgId: string;
}

/**
 * Derives the current session's org from org_members — this, not the old
 * shared passphrase, is the real authorization boundary now: a request can
 * only act on an org the logged-in user is actually a member of, not any org
 * whose UUID happens to be known (which the shared-passphrase design never
 * actually prevented, since one passphrase worked for every org).
 *
 * If a user belongs to more than one org, the first membership is used —
 * no org switcher yet, not needed until a user genuinely spans multiple
 * client orgs.
 */
export async function requireCurrentOrg(): Promise<CurrentOrg> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data: membership, error } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new Error("Your account isn't linked to an organization yet — ask your admin to invite you.");

  return { userId: user.id, orgId: membership.org_id };
}
