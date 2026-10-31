import "server-only";
// Authorisation for the Rep boundary and for managing customer assignments. Kept OUT of the "use server" files (which may export only async functions) so several action files share
// it. Identity resolution is the existing one (authoriseActor: NewQuip org, Quotes module access, Demo Mode effective user, tier, functional roles), re-established inside EVERY
// action. This slice changes nobody's roles: it only adds the assignment check on top.
import { authoriseActor, type Actor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { assignmentsAvailable } from "@/lib/newquip-assignments/assignment-store";

export type Db = ReturnType<typeof createServiceRoleClient>;
export interface RepResult<T> { ok: boolean; error?: string; data?: T }
export const errText = (e: unknown): string => (e instanceof Error ? e.message : "Unexpected error");

/** A Rep using the Rep workspace. Every Rep response is assignment-scoped and cost-free, even when the same person is also an Estimator, Manager or administrator. */
export async function authoriseRep(): Promise<{ actor: Actor; db: Db }> {
  const actor = await authoriseActor();
  if (!actor.roles.has("rep")) throw new Error("Only a Rep can use the Rep workspace.");
  const db = createServiceRoleClient();
  if (!(await assignmentsAvailable(db))) throw new Error("Customer assignments are not available yet.");
  return { actor, db };
}

/** A Manager or organisation administrator managing which Rep sees which customer. Visibility only: it grants no approval power to anyone. */
export async function authoriseAssignmentManager(): Promise<{ actor: Actor; db: Db }> {
  const actor = await authoriseActor();
  if (!actor.roles.has("manager") && actor.tier !== "admin") throw new Error("Only a Manager or administrator can manage customer assignments.");
  const db = createServiceRoleClient();
  if (!(await assignmentsAvailable(db))) throw new Error("Customer assignments are not available yet.");
  return { actor, db };
}
