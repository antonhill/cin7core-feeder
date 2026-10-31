"use server";

// Rep customer isolation (Slice 1B): the owner-gated switch and its read-only preflight. Organisation owner/admin only, never under Demo Mode. NOTHING calls setRepIsolationAction in this
// slice: enforcement is OFF until an administrator deliberately turns it on, after reading the preflight. The change is one database transaction (setting + audit event). Only async
// functions and erased types are exported.
import { authoriseAssignmentManager, auditAfterCommit, errText, type Db, type RepResult } from "./rep-actor";
import { ownerEmailOf } from "@/app/newquip-grower/actor";
import { isolationEnabled } from "@/lib/newquip-assignments/access";
import { isolationPreflight, type IsolationPreflight } from "@/lib/newquip-assignments/isolation-preflight";

const ENABLE_CONFIRMATION = "ENABLE REP ISOLATION";

async function authoriseSwitch() {
  const r = await authoriseAssignmentManager();
  if (r.actor.tier !== "admin") throw new Error("Only an organisation owner or administrator can change customer isolation.");
  if (r.actor.demo) throw new Error("Customer isolation cannot be changed in Demo Mode. Exit Demo Mode first.");
  return r;
}

/** Read-only: the current state and the preflight report. Changes nothing. */
export async function getRepIsolationStatusAction(): Promise<RepResult<IsolationPreflight>> {
  try {
    const { actor, db } = await authoriseSwitch();
    return { ok: true, data: await isolationPreflight(db, actor.orgId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Turns isolation ON or OFF for the organisation. Enabling needs the typed confirmation, a reason, and a preflight with no blockers; the preflight is stored with the audit event. */
export async function setRepIsolationAction(input: { enabled: boolean; reason: string; confirmation?: string }): Promise<RepResult<{ enabled: boolean }>> {
  try {
    const { actor, db } = await authoriseSwitch();
    const reason = String(input?.reason ?? "").trim();
    if (reason.length < 5) throw new Error("Give a reason (at least 5 characters).");
    const pre = await isolationPreflight(db, actor.orgId);
    if (!pre.switchInstalled) throw new Error("Customer isolation is not available yet.");
    if (input?.enabled === true) {
      if (input.confirmation !== ENABLE_CONFIRMATION) throw new Error(`Type "${ENABLE_CONFIRMATION}" to confirm.`);
      if (pre.blockers.length) throw new Error(`Isolation cannot be enabled yet: ${pre.blockers.join(" ")}`);
    }
    const r = await (db as Db).rpc("newquip_set_rep_isolation", { p_org: actor.orgId, p_enabled: input?.enabled === true, p_actor_email: actor.email, p_reason: reason, p_preflight: pre });
    if (r.error) throw new Error(r.error.message.replace(/^newquip_set_rep_isolation: /, ""));
    const now = await isolationEnabled(db, actor.orgId);
    await auditAfterCommit(db, actor, { action: "newquip.rep_isolation_changed", summary: `Customer-level Rep isolation switched ${now ? "ON" : "OFF"} (${reason})`, detail: { enabled: now, owner: ownerEmailOf(actor), unassignedCustomers: pre.unassignedCustomers.length, assignedScopedPeople: pre.assignedScopedPeople.length } });
    return { ok: true, data: { enabled: now } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
