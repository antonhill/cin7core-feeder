"use server";

// Managing customer -> Rep assignments (Slice 1A; no UI yet). Manager or organisation administrator only; the target must be a current member of THIS organisation who holds the Rep
// role under the existing role resolution. An assignment grants VISIBILITY only. Every change is audited with the actor (and the owner under Demo Mode). Nothing here changes roles,
// existing permissions, quotations or Projects, and nothing reaches Cin7. Only async functions and erased types are exported.
import { auditAfterCommit, authoriseAssignmentManager, errText, type Db, type RepResult } from "./rep-actor";
import { ownerEmailOf } from "@/app/newquip-grower/actor";
import { assignRep, assignmentsForCustomer, endAssignment, reassignCustomer, type AssignmentRow } from "@/lib/newquip-assignments/assignment-store";
import { resolveRoles } from "@/lib/approvals/role-store";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The target must belong to this organisation and hold the Rep role by the EXISTING role resolution (explicit role, or the tier default while strict roles are off). */
async function resolveRep(db: Db, orgId: string, userId: string): Promise<{ userId: string; email: string }> {
  const m = await db.from("org_members").select("user_id, role").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (m.error) throw new Error(m.error.message);
  const row = m.data as { user_id: string; role: string } | null;
  if (!row) throw new Error("That person is not a member of this organisation.");
  const roles = await resolveRoles(db, orgId, userId, row.role === "owner" || row.role === "admin");
  if (!roles.has("REP")) throw new Error("That person does not hold the Rep role.");
  const u = await db.auth.admin.getUserById(userId);
  const email = u.data?.user?.email?.toLowerCase();
  if (!email) throw new Error("That user could not be found.");
  return { userId, email };
}
const customerOf = (id: string, name: string): { id: string; name: string } => {
  const cid = String(id ?? "").trim(); const n = String(name ?? "").trim();
  if (!GUID.test(cid)) throw new Error("Choose the customer from Cin7 (a valid Cin7 customer ID is required).");
  if (n.length < 2) throw new Error("The customer name is required.");
  return { id: cid, name: n };
};

export async function listCustomerAssignmentsAction(cin7CustomerId: string): Promise<RepResult<AssignmentRow[]>> {
  try {
    const { actor, db } = await authoriseAssignmentManager();
    return { ok: true, data: await assignmentsForCustomer(db, actor.orgId, String(cin7CustomerId ?? "")) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function assignRepToCustomerAction(input: { cin7CustomerId: string; customerName: string; repUserId: string; reason?: string }): Promise<RepResult<{ assignment: AssignmentRow; created: boolean }>> {
  try {
    const { actor, db } = await authoriseAssignmentManager();
    const c = customerOf(input?.cin7CustomerId, input?.customerName);
    const rep = await resolveRep(db, actor.orgId, String(input?.repUserId ?? ""));
    const r = await assignRep(db, actor.orgId, { email: actor.email, ownerEmail: ownerEmailOf(actor) }, { cin7CustomerId: c.id, customerName: c.name, repUserId: rep.userId, repEmail: rep.email, reason: String(input?.reason ?? "") });
    if (r.created) await auditAfterCommit(db, actor, { action: "newquip.rep_assigned", summary: `Assigned ${rep.email} to customer ${c.name} (visibility only; no role, quotation or Cin7 change)`, detail: { customerId: c.id, repUserId: rep.userId, assignmentId: r.assignment.id } });
    return { ok: true, data: r };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function endRepAssignmentAction(assignmentId: string, reason: string): Promise<RepResult<AssignmentRow>> {
  try {
    const { actor, db } = await authoriseAssignmentManager();
    const row = await endAssignment(db, actor.orgId, { email: actor.email, ownerEmail: ownerEmailOf(actor) }, String(assignmentId ?? ""), String(reason ?? ""));
    await auditAfterCommit(db, actor, { action: "newquip.rep_assignment_ended", summary: `Ended ${row.rep_email}'s access to customer ${row.customer_name} (${row.end_reason})`, detail: { customerId: row.cin7_customer_id, repUserId: row.rep_user_id, assignmentId: row.id } });
    return { ok: true, data: row };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function reassignCustomerAction(input: { cin7CustomerId: string; customerName: string; fromRepUserId: string; toRepUserId: string; reason: string }): Promise<RepResult<{ ended: AssignmentRow; assigned: AssignmentRow; created: boolean }>> {
  try {
    const { actor, db } = await authoriseAssignmentManager();
    const c = customerOf(input?.cin7CustomerId, input?.customerName);
    const to = await resolveRep(db, actor.orgId, String(input?.toRepUserId ?? "")); // validate the new Rep BEFORE the old access is ended
    const r = await reassignCustomer(db, actor.orgId, { email: actor.email, ownerEmail: ownerEmailOf(actor) }, { cin7CustomerId: c.id, customerName: c.name, fromRepUserId: String(input?.fromRepUserId ?? ""), toRepUserId: to.userId, toRepEmail: to.email, reason: String(input?.reason ?? "") });
    await auditAfterCommit(db, actor, { action: "newquip.rep_reassigned", summary: `Moved customer ${c.name} from ${r.ended.rep_email} to ${to.email}${r.created ? "" : " (the new Rep was already assigned)"}`, detail: { customerId: c.id, fromRepUserId: r.ended.rep_user_id, toRepUserId: to.userId, endedAssignmentId: r.ended.id, assignmentId: r.assigned.id, created: r.created } });
    return { ok: true, data: r };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
