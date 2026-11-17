"use server";

// NewQuip team: a Manager invites a person into the NewQuip organisation with one process role. The organisation comes from the session (never a parameter), the caller must hold
// the Manager role (or be the organisation owner/admin) AND be on a two-factor session (granting access is high impact; same bar as Members). The invitee is created confirmed (no
// password, no app email; they sign in at the dedicated login with an emailed one-time code), added as an ordinary member (never admin) and given the chosen functional role through
// the audited org_role_assign function. An existing account (e.g. a Spark person in several organisations) only gains this membership; nothing else about it changes.
// Only async functions and erased types are exported. No Cin7 call.
import { authoriseActor, auditActor, errText } from "./actor";
import { requireAal2 } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";
import { addOrdinaryMember, assignRole, listOrgUsers } from "@/lib/approvals/role-store";
import { ROLE_LABEL } from "@/lib/approvals/roles";
import { isInviteRole, normaliseInviteEmail, type InviteRole } from "@/newquip/invite";

export interface TeamActionResult<T> { ok: boolean; error?: string; data?: T }
export interface TeamPerson { email: string; tier: "owner" | "admin" | "member"; roles: string[] }
export interface TeamView { people: TeamPerson[]; canInvite: boolean }
export interface InviteOutcome { email: string; role: InviteRole; created: boolean; alreadyMember: boolean; roleAdded: boolean }

const needManager = (roles: ReadonlySet<string>, tier: string) => { if (tier !== "admin" && !roles.has("manager")) throw new Error("Only a Manager can invite people to NewQuip."); };

export async function getTeamAction(): Promise<TeamActionResult<TeamView>> {
  try {
    const a = await authoriseActor();
    needManager(a.roles, a.tier);
    const people = (await listOrgUsers(createServiceRoleClient(), a.orgId)).map((u) => ({ email: u.email, tier: u.tier, roles: u.roles.map((r) => ROLE_LABEL[r] ?? r) }));
    return { ok: true, data: { people, canInvite: true } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function inviteNewquipMemberAction(emailInput: string, roleInput: string): Promise<TeamActionResult<InviteOutcome>> {
  try {
    const email = normaliseInviteEmail(emailInput);
    if (!email) throw new Error("Enter one valid email address.");
    if (!isInviteRole(roleInput)) throw new Error("Choose Rep, Estimator or Manager.");
    const a = await authoriseActor();
    needManager(a.roles, a.tier);
    await requireAal2("invite a person to NewQuip");
    const db = createServiceRoleClient();

    let userId: string | null = null; let created = false;
    const made = await db.auth.admin.createUser({ email, email_confirm: true });
    if (made.data?.user) { userId = made.data.user.id; created = true; }
    else {
      const list = await db.auth.admin.listUsers({ perPage: 1000 });
      if (list.error) throw new Error(list.error.message);
      userId = list.data.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (!userId) throw new Error(made.error?.message ?? "The account could not be created.");
    }

    const alreadyMember = !(await addOrdinaryMember(db, a.orgId, userId));

    // The caller was verified above; assignRole's own gate is satisfied by that check and the RPC refuses a non-member.
    const roleAdded = await assignRole(db, { canAdminister: true }, a.email, { orgId: a.orgId, userId, role: roleInput });
    await auditActor(db, a, { action: "newquip.member_invited", summary: `Invited a person to NewQuip as ${ROLE_LABEL[roleInput]}`, detail: { invitee: email, role: roleInput, accountCreated: created, alreadyMember, roleAdded } });
    return { ok: true, data: { email, role: roleInput, created, alreadyMember, roleAdded } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
