import { isNewquipPocOrg } from "@/newquip/access";

// NEWQUIP DEMO MODE (pure, client-safe). A Preview-only way for the OWNER to demonstrate the multi-stage approval workflow as the Rep, Estimator and Manager
// test users without signing in again. This module holds only the rules; the server issues and verifies the context (context.ts). Nothing here widens any
// permission: the effective identity is evaluated by the SAME role and separation-of-duties checks as a real sign-in.

export const DEMO_SLOTS = ["rep", "estimator", "manager", "owner"] as const;
export type DemoSlot = (typeof DEMO_SLOTS)[number];
export const isDemoSlot = (v: unknown): v is DemoSlot => typeof v === "string" && (DEMO_SLOTS as readonly string[]).includes(v);
export const SLOT_LABEL: Record<DemoSlot, string> = { rep: "Rep", estimator: "Estimator", manager: "Manager", owner: "Owner (you)" };

/** The ONLY accounts that can be selected, fixed in code: a caller supplies a slot name, never an email, user id, role or organisation. */
export const DEMO_IDENTITY_EMAILS: Readonly<Record<Exclude<DemoSlot, "owner">, string>> = {
  rep: "rep@sparkconsulting.co.za",
  estimator: "estimator@sparkconsulting.co.za",
  manager: "manager@sparkconsulting.co.za",
};
/** The one account allowed to use Demo Mode (the actual signed-in owner). The environment must name the same account: a config typo can never widen it. */
export const DEMO_OWNER_EMAIL = "testing@sparkconsulting.co.za";
export const DEMO_TTL_SECONDS = 30 * 60;
export const DEMO_COOKIE = "nq_demo";

export interface DemoEnv { VERCEL_ENV?: string; NEWQUIP_DEMO_MODE_ENABLED?: string; NEWQUIP_DEMO_OWNER_EMAIL?: string }
export type DemoGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether Demo Mode may operate for this session. ALL of: a Vercel PREVIEW deployment (Production, local and unknown environments refuse), the explicit
 * server-side switch NEWQUIP_DEMO_MODE_ENABLED=true (default OFF), the environment naming the exact owner account, the signed-in user being that account,
 * and the active organisation being the NewQuip test organisation.
 */
export function demoGate(env: DemoEnv, session: { orgId: string; email: string | null }): DemoGate {
  if (env.VERCEL_ENV !== "preview") return { allowed: false, reason: "Demo Mode is available only on a Preview deployment." };
  if (env.NEWQUIP_DEMO_MODE_ENABLED !== "true") return { allowed: false, reason: "Demo Mode is switched off." };
  const configured = (env.NEWQUIP_DEMO_OWNER_EMAIL ?? "").trim().toLowerCase();
  if (configured !== DEMO_OWNER_EMAIL) return { allowed: false, reason: "Demo Mode is not configured for the owner account." };
  if ((session.email ?? "").trim().toLowerCase() !== DEMO_OWNER_EMAIL) return { allowed: false, reason: "Demo Mode is restricted to the owner account." };
  if (!isNewquipPocOrg(session.orgId)) return { allowed: false, reason: "Demo Mode is restricted to the NewQuip test organisation." };
  return { allowed: true };
}

/** What the audit trail and the approval history show for a demo action. The marker is part of the immutable actor name, so it cannot be missed. */
export function demoActorName(i: { slot: DemoSlot; effectiveEmail: string; ownerEmail: string }): string {
  return `DEMO · ${i.effectiveEmail} (${SLOT_LABEL[i.slot]}) · impersonated by ${i.ownerEmail}`;
}
export const isDemoActorName = (name: string | null | undefined): boolean => !!name && name.startsWith("DEMO · ");
