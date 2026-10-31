// NewQuip customer -> Rep assignments (migration 0118). Cin7 is the customer master: an assignment only says which Rep may SEE that customer's quotations. It grants no authority
// (editing, approving, issuing and accepting stay role-gated elsewhere) and it never writes anything to Cin7. The table is append-only history: ending an assignment records who, when
// and why, and a Rep assigned again later gets a NEW row. Every function is scoped by organisation, and every failure other than "the migration has not been applied" propagates.
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;
const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");
const fail = (m: string): never => { throw new Error(m); };

export interface AssignmentRow {
  id: string; org_id: string; cin7_customer_id: string; customer_name: string; rep_user_id: string; rep_email: string;
  assigned_by_email: string; assigned_by_owner_email: string | null; assigned_reason: string; assigned_at: string;
  ended_at: string | null; ended_by_email: string | null; end_reason: string | null;
}
export interface Actor { email: string; ownerEmail?: string | null }

/** Migration 0118 applied? When it is not, no Rep has any assignment, so every assignment-based read denies (fail closed). */
export async function assignmentsAvailable(db: Db): Promise<boolean> {
  const r = await db.from("customer_rep_assignments").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  throw new Error(r.error.message);
}

/** The customers a Rep may see right now: their ACTIVE assignments only. An ended assignment grants nothing, immediately. */
export async function activeAssignmentsForRep(db: Db, orgId: string, repUserId: string): Promise<AssignmentRow[]> {
  const r = await db.from("customer_rep_assignments").select("*").eq("org_id", orgId).eq("rep_user_id", repUserId).is("ended_at", null).order("assigned_at", { ascending: true });
  if (r.error) { if (missing(r.error.message)) return []; fail(`load assignments: ${r.error.message}`); }
  return (r.data ?? []) as AssignmentRow[];
}

/** Every assignment of one customer, newest first: the active Reps and the full history of ended periods. */
export async function assignmentsForCustomer(db: Db, orgId: string, cin7CustomerId: string): Promise<AssignmentRow[]> {
  const r = await db.from("customer_rep_assignments").select("*").eq("org_id", orgId).eq("cin7_customer_id", cin7CustomerId).order("assigned_at", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; fail(`load assignments: ${r.error.message}`); }
  return (r.data ?? []) as AssignmentRow[];
}

export interface AssignInput { cin7CustomerId: string; customerName: string; repUserId: string; repEmail: string; reason?: string }

/** Assigns a Rep to a customer. Idempotent: an already ACTIVE assignment of the same Rep is returned unchanged (`created: false`). */
export async function assignRep(db: Db, orgId: string, by: Actor, input: AssignInput): Promise<{ assignment: AssignmentRow; created: boolean }> {
  const customer = input.cin7CustomerId.trim();
  if (!customer) fail("Choose a customer.");
  const existing = (await activeAssignmentsForRep(db, orgId, input.repUserId)).find((a) => a.cin7_customer_id === customer);
  if (existing) return { assignment: existing, created: false };
  const ins = await db.from("customer_rep_assignments").insert({
    org_id: orgId, cin7_customer_id: customer, customer_name: input.customerName.trim(), rep_user_id: input.repUserId, rep_email: input.repEmail.trim().toLowerCase(),
    assigned_by_email: by.email, assigned_by_owner_email: by.ownerEmail ?? null, assigned_reason: (input.reason ?? "").trim(),
  }).select("*").single();
  if (ins.error || !ins.data) return fail(`Could not assign the Rep: ${ins.error?.message ?? "no row"}`);
  return { assignment: ins.data as AssignmentRow, created: true };
}

/** Ends ONE active assignment (a reason of at least 3 characters is mandatory). Access is lost on the very next server-authorised read. */
export async function endAssignment(db: Db, orgId: string, by: Actor, assignmentId: string, reason: string): Promise<AssignmentRow> {
  const why = reason.trim();
  if (why.length < 3) fail("Give a reason (at least 3 characters) for ending the assignment.");
  const cur = await db.from("customer_rep_assignments").select("*").eq("org_id", orgId).eq("id", assignmentId).maybeSingle();
  if (cur.error) fail(cur.error.message);
  const row = cur.data as AssignmentRow | null;
  if (!row) return fail("Assignment not found.");
  if (row.ended_at) return fail("That assignment has already ended.");
  const upd = await db.from("customer_rep_assignments").update({ ended_at: new Date().toISOString(), ended_by_email: by.email, end_reason: why }).eq("org_id", orgId).eq("id", assignmentId).is("ended_at", null).select("*");
  if (upd.error) fail(`Could not end the assignment: ${upd.error.message}`);
  const done = ((upd.data ?? []) as AssignmentRow[])[0];
  if (!done) return fail("That assignment has already ended.");
  return done;
}

export interface ReassignInput { cin7CustomerId: string; customerName: string; fromRepUserId: string; toRepUserId: string; toRepEmail: string; reason: string }

/**
 * Moves a customer from one Rep to another. ORDER MATTERS and fails closed: the old access is ended FIRST, then the new one is created. If the second step fails the customer is
 * temporarily covered by neither Rep (never by both), and the same call can simply be repeated.
 */
export async function reassignCustomer(db: Db, orgId: string, by: Actor, input: ReassignInput): Promise<{ ended: AssignmentRow; assigned: AssignmentRow }> {
  if (input.fromRepUserId === input.toRepUserId) fail("Choose a different Rep.");
  const customer = input.cin7CustomerId.trim();
  const from = (await activeAssignmentsForRep(db, orgId, input.fromRepUserId)).find((a) => a.cin7_customer_id === customer);
  if (!from) return fail("That Rep is not currently assigned to this customer.");
  const ended = await endAssignment(db, orgId, by, from.id, input.reason);
  const { assignment } = await assignRep(db, orgId, by, { cin7CustomerId: customer, customerName: input.customerName, repUserId: input.toRepUserId, repEmail: input.toRepEmail, reason: input.reason });
  return { ended, assigned: assignment };
}
