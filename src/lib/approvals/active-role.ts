import { isNewquipPocOrg } from "@/newquip/access";
import type { FunctionalRole } from "./roles";

// NEWQUIP POC ROLE SWITCH (pure, client-safe). One real person holding several EXPLICITLY ASSIGNED process roles chooses which ONE they are acting as. It is not
// impersonation and not a bypass: the session, the identity and the role assignments are the person's own; the choice can only NARROW what they may do, and the
// server re-derives everything on every request. Who may switch is an explicit, exact-email allowlist held in server configuration (default EMPTY = nobody), so
// production separation of duties is the default and the POC arrangement is a deliberate, reversible, per-person setting.

export const SWITCH_ROLES = ["REP", "ESTIMATOR", "MANAGER"] as const satisfies readonly FunctionalRole[];
export type SwitchRole = (typeof SWITCH_ROLES)[number];
export const isSwitchRole = (v: unknown): v is SwitchRole => typeof v === "string" && (SWITCH_ROLES as readonly string[]).includes(v);
export const ACTIVE_ROLE_COOKIE = "nq_active_role";
export const ACTIVE_ROLE_TTL_SECONDS = 12 * 60 * 60;
export const SWITCH_LABEL: Record<SwitchRole, string> = { REP: "Rep", ESTIMATOR: "Estimator", MANAGER: "Manager" };

/** Exact lower-cased emails from NEWQUIP_ROLE_SWITCH_EMAILS (comma separated). Anything that is not a plain email is ignored; empty / unset = nobody. */
export function parseSwitchEmails(raw: string | undefined | null): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s,]+@[^@\s,]+$/.test(s)));
}

export interface SwitchState {
  /** The explicitly assigned roles the person may switch between (never fewer than two). */
  held: readonly SwitchRole[];
  /** The role currently in force: a verified selection, else the least-privileged held role. */
  active: SwitchRole;
  /** True when the active role came from a verified selection rather than the default. */
  selected: boolean;
}

/** Least privilege first: Rep sees no costs and approves nothing. */
const ORDER: readonly SwitchRole[] = ["REP", "ESTIMATOR", "MANAGER"];

/**
 * Whether the person may switch, and between what. ALL of: the NewQuip test organisation, an email on the allowlist, and at least TWO explicit assignments among
 * Rep / Estimator / Manager. A person with one role (for example René, Estimator only) never gets a switch; neither does anyone not on the allowlist.
 */
export function switchHeldRoles(i: { orgId: string; email: string | null; assigned: readonly string[]; allowlist: ReadonlySet<string> }): readonly SwitchRole[] | null {
  if (!isNewquipPocOrg(i.orgId)) return null;
  if (!i.email || !i.allowlist.has(i.email.trim().toLowerCase())) return null;
  const held = ORDER.filter((r) => i.assigned.includes(r));
  return held.length >= 2 ? held : null;
}

/** The role in force: the selection only if it is one the person holds; otherwise the least-privileged one. */
export function activeFor(held: readonly SwitchRole[], selection: string | null | undefined): { active: SwitchRole; selected: boolean } {
  if (isSwitchRole(selection) && held.includes(selection)) return { active: selection, selected: true };
  return { active: held[0], selected: false };
}

/** Narrows an effective role set to the one active process role. Administrator (which never approves by itself) and non-process roles are left alone. */
export function narrowToActive(roles: ReadonlySet<FunctionalRole>, active: SwitchRole): ReadonlySet<FunctionalRole> {
  const out = new Set<FunctionalRole>();
  for (const r of roles) if (!isSwitchRole(r) || r === active) out.add(r);
  out.add(active);
  return out;
}

/** What may be seen: only Estimator and Manager mode see costs, margins and markups. Rep mode never does, whatever else the person holds. */
export const activeSeesCosts = (active: SwitchRole): boolean => active === "ESTIMATOR" || active === "MANAGER";
