// NewQuip team invitations (pure; client-safe). A NewQuip Manager invites a person by email and picks ONE of the three process roles. The role is persisted as a functional
// role assignment (org_functional_roles) and enforced server-side by every NewQuip action; nothing here grants organisation-admin tier, module restrictions or any Spark access.
import { NEWQUIP_LOGIN_PATH } from "./entry";
import { ROLE_LABEL, type FunctionalRole } from "@/lib/approvals/roles";

export const INVITE_ROLES = ["REP", "ESTIMATOR", "MANAGER"] as const satisfies readonly FunctionalRole[];
export type InviteRole = (typeof INVITE_ROLES)[number];
export const isInviteRole = (v: unknown): v is InviteRole => typeof v === "string" && (INVITE_ROLES as readonly string[]).includes(v);

const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/;
/** Lower-cased trimmed address, or null when it is not one single plausible email address. */
export function normaliseInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && EMAIL.test(v) ? v : null;
}

/** What the inviter passes on. The invitee never gets a password: they open the NewQuip login, enter their email and use the 6-digit code emailed to them. */
export function inviteInstructions(origin: string, email: string, role: InviteRole): string {
  return [
    `You have been given NewQuip access as ${ROLE_LABEL[role]}.`,
    `1. Open ${origin}${NEWQUIP_LOGIN_PATH}`,
    `2. Enter ${email} and choose "Send sign-in code".`,
    `3. Enter the 6-digit code from the email and you will land in NewQuip.`,
  ].join("\n");
}
