import "server-only";
import { cookies } from "next/headers";
import { createServiceRoleClient } from "@/supabase/server";
import { computeEffectiveDisabledModules, findBlockedModule } from "@/app/module-nav";
import { listOrgUsers } from "@/lib/approvals/role-store";
import { DEMO_COOKIE, DEMO_IDENTITY_EMAILS, SLOT_LABEL, demoActorName, demoGate, type DemoSlot } from "./config";
import { verifyDemoToken, type DemoClaims } from "./token";

// Server side of NewQuip Demo Mode. Three rules keep it safe:
//   1. The real session is never replaced. The owner stays the authenticated user everywhere; only the NewQuip quotation / approval actions ask
//      "who is acting?" (resolveActing) and every one of them records the real owner next to the effective user.
//   2. Everything else DENIES while a demo identity is active (assertNoDemoImpersonation, called by the shared authorisation primitives), so an
//      administrative action can never run as the owner while the screen says "Rep".
//   3. Nothing the browser sends decides identity: the cookie is a signed, 30-minute server context naming a SLOT; the account behind a slot is fixed in code.

export interface DemoInfo {
  slot: Exclude<DemoSlot, "owner">; roleLabel: string;
  effectiveUserId: string; effectiveEmail: string; ownerUserId: string; ownerEmail: string; orgId: string;
  /** The effective user's real organisation tier (owner/admin = admin). Roles beyond it come from the role tables, exactly as for a real sign-in. */
  tier: "admin" | "member"; expiresAt: string;
  /** The immutable actor name written into the approval history and notifications. */
  actorName: string;
}

async function rawCookie(): Promise<string | undefined> {
  try { return (await cookies()).get(DEMO_COOKIE)?.value; } catch { return undefined; } // outside a request (cron, build): there is no demo context
}

/** The verified claims, or null. Signature, expiry and structure only: the caller still binds them to the live session. */
export async function liveDemoClaims(): Promise<DemoClaims | null> {
  return verifyDemoToken(await rawCookie());
}

/** Shared-primitive guard: refuse the action while a demo identity is active. */
export async function assertNoDemoImpersonation(what = "This action"): Promise<void> {
  if (await liveDemoClaims()) throw new Error(`${what} is not available while Demo Mode is impersonating another user. Exit Demo Mode first.`);
}

export interface Acting { userId: string; email: string; orgId: string; /** null = not impersonating: use the normal tier lookup. */ tier: "admin" | "member" | null; demo: DemoInfo | null }

/**
 * Who is acting for a NewQuip quotation / approval action. Without a demo cookie it is the real user, unchanged. With one, every binding is re-checked on
 * EVERY call (environment switch, owner account, organisation, the owner's own session, the allowlisted account's membership, the effective user's own
 * module access) and any failure throws: it never falls back to the owner's powers.
 */
export async function resolveActing(real: { userId: string; orgId: string; email: string | null }, moduleHref?: string): Promise<Acting> {
  const claims = await liveDemoClaims();
  const realEmail = real.email ?? "unknown";
  if (!claims) return { userId: real.userId, email: realEmail, orgId: real.orgId, tier: null, demo: null };
  const gate = demoGate(process.env as Record<string, string | undefined>, { orgId: real.orgId, email: real.email });
  if (!gate.allowed) throw new Error(`Demo Mode is not valid here (${gate.reason}) Exit Demo Mode.`);
  if (claims.owner !== real.userId || claims.org !== real.orgId) throw new Error("This Demo Mode session belongs to a different sign-in. Exit Demo Mode.");
  const email = DEMO_IDENTITY_EMAILS[claims.slot];
  const db = createServiceRoleClient();
  const user = (await listOrgUsers(db, real.orgId)).find((u) => u.email === email);
  if (!user) throw new Error(`The demo account for ${SLOT_LABEL[claims.slot]} is not a member of this organisation. Exit Demo Mode.`);
  if (moduleHref) {
    // the effective user may use only what THEY may use
    const m = await db.from("org_members").select("allowed_modules").eq("org_id", real.orgId).eq("user_id", user.userId).maybeSingle();
    if (m.error) throw new Error(m.error.message);
    const org = await db.from("organizations").select("disabled_modules").eq("id", real.orgId).maybeSingle();
    if (org.error) throw new Error(org.error.message);
    const disabled = computeEffectiveDisabledModules((org.data as { disabled_modules?: string[] } | null)?.disabled_modules ?? [], (m.data as { allowed_modules?: string[] | null } | null)?.allowed_modules ?? null);
    if (findBlockedModule(moduleHref, disabled)) throw new Error(`${email} does not have access to this feature.`);
  }
  const info: DemoInfo = {
    slot: claims.slot, roleLabel: SLOT_LABEL[claims.slot], effectiveUserId: user.userId, effectiveEmail: email, ownerUserId: real.userId, ownerEmail: realEmail, orgId: real.orgId,
    tier: user.tier === "member" ? "member" : "admin", expiresAt: new Date(claims.exp * 1000).toISOString(),
    actorName: demoActorName({ slot: claims.slot, effectiveEmail: email, ownerEmail: realEmail }),
  };
  return { userId: user.userId, email, orgId: real.orgId, tier: info.tier, demo: info };
}

/** What every audit record of a demo action carries, next to the real initiating owner. */
export function demoAuditDetail(d: DemoInfo, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { demo: true, marker: "DEMO/IMPERSONATED", effectiveUser: d.effectiveEmail, effectiveUserId: d.effectiveUserId, selectedRole: d.roleLabel, actualOwner: d.ownerEmail, actualOwnerUserId: d.ownerUserId, ...extra };
}

export interface DemoBarState { visible: boolean; selectable: boolean; active: { slot: Exclude<DemoSlot, "owner">; label: string; email: string; expiresAt: string } | null; reason: string | null }

/** For the layout: the selector shows only to the authorised owner on an enabled Preview; an active banner shows whenever a live context exists. */
export async function demoBarState(session: { orgId: string | null; email: string | null }): Promise<DemoBarState> {
  const claims = await liveDemoClaims();
  const gate = session.orgId ? demoGate(process.env as Record<string, string | undefined>, { orgId: session.orgId, email: session.email }) : ({ allowed: false, reason: "No organisation." } as const);
  const active = claims ? { slot: claims.slot, label: SLOT_LABEL[claims.slot], email: DEMO_IDENTITY_EMAILS[claims.slot], expiresAt: new Date(claims.exp * 1000).toISOString() } : null;
  return { visible: gate.allowed || !!claims, selectable: gate.allowed, active, reason: gate.allowed ? null : gate.reason };
}
