import "server-only";
// The effective NewQuip actor for the customer / document actions: the same identity resolution as actions.ts (NewQuip org check, Quotes module access, Demo Mode
// effective user, tier, functional roles) - re-established inside EVERY action. Kept here (not in a "use server" file) so several action files can share it.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { type OrgTier, type QuoteRole } from "@/newquip/quote/roles";
import { toQuoteRoles } from "@/lib/approvals/roles";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { demoAuditDetail, resolveActing, type DemoInfo } from "@/lib/demo-mode/context";

export interface Actor {
  /** The EFFECTIVE user (under Demo Mode, the allowlisted test account). Permissions evaluate this one. */
  orgId: string; userId: string; email: string; tier: OrgTier; roles: ReadonlySet<QuoteRole>; canSeeCost: boolean;
  /** Set only while the owner is impersonating a demo identity. */
  demo: DemoInfo | null;
}
export type Db = ReturnType<typeof createServiceRoleClient>;

export async function authoriseActor(): Promise<Actor> {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href, { allowDemo: true });
  const acting = await resolveActing(access, QUOTES_MODULE.href);
  let tier: OrgTier = "member";
  if (acting.demo) {
    tier = acting.tier === "admin" ? "admin" : "member";
  } else {
    try { await requireOrgAdmin("act as a NewQuip manager"); tier = "admin"; } catch { tier = "member"; } // fail closed
  }
  const db = createServiceRoleClient();
  const functional = await resolveRoles(db, orgId, acting.userId, tier === "admin");
  return { orgId, userId: acting.userId, email: acting.email, tier, roles: toQuoteRoles(functional), canSeeCost: await canSeeCosts(db, orgId, acting.userId, tier === "admin"), demo: acting.demo };
}

/** The authenticated OWNER email when a Demo identity is active, else null. Recorded next to the effective user on every audited write. */
export const ownerEmailOf = (a: Actor): string | null => a.demo?.ownerEmail ?? null;

/** Audit record: the REAL owner is the actor; the effective user and the DEMO marker are in the detail. */
export async function auditActor(db: Db, a: Actor, i: { action: string; summary: string; detail: Record<string, unknown> }): Promise<void> {
  await logActivity(db, a.demo
    ? { orgId: a.orgId, actor: { userId: a.demo.ownerUserId, email: a.demo.ownerEmail }, action: i.action, summary: `[DEMO] ${i.summary}`, detail: demoAuditDetail(a.demo, i.detail) }
    : { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: i.action, summary: i.summary, detail: i.detail });
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : "Unexpected error");
