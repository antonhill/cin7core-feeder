"use server";

// NewQuip Demo Mode: select an allowlisted test identity, or exit. These are the ONLY actions that issue or clear the demo context. They authenticate the REAL
// session, evaluate the gate (Preview only + explicit switch + exact owner account + NewQuip test organisation), accept only a slot NAME (never an email, user
// id, role or organisation) and record the switch in the audit log. Nothing here changes the global session. Only async functions and erased types are exported.
import { cookies } from "next/headers";
import { requireCurrentOrg } from "@/lib/current-org";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { listOrgUsers } from "@/lib/approvals/role-store";
import { DEMO_COOKIE, DEMO_IDENTITY_EMAILS, DEMO_TTL_SECONDS, SLOT_LABEL, demoGate, isDemoSlot } from "@/lib/demo-mode/config";
import { signDemoClaims } from "@/lib/demo-mode/token";

export interface DemoActionResult { ok: boolean; error?: string }

export async function selectDemoIdentityAction(slot: string): Promise<DemoActionResult> {
  try {
    const real = await requireCurrentOrg();
    const gate = demoGate(process.env as Record<string, string | undefined>, { orgId: real.orgId, email: real.email });
    if (!gate.allowed) return { ok: false, error: gate.reason };
    if (!isDemoSlot(slot)) return { ok: false, error: "Choose Rep, Estimator, Manager or Owner." };
    const db = createServiceRoleClient();
    const store = await cookies();
    if (slot === "owner") {
      store.delete(DEMO_COOKIE);
      await logActivity(db, { orgId: real.orgId, actor: { userId: real.userId, email: real.email }, action: "newquip.demo_mode_owner", summary: "[DEMO] Returned to the real owner identity", detail: { demo: true, marker: "DEMO/IMPERSONATED", selectedRole: SLOT_LABEL.owner, actualOwner: real.email } });
      return { ok: true };
    }
    const email = DEMO_IDENTITY_EMAILS[slot];
    const user = (await listOrgUsers(db, real.orgId)).find((u) => u.email === email);
    if (!user) return { ok: false, error: `${email} is not a member of the NewQuip test organisation, so it cannot be selected.` };
    const { token } = signDemoClaims({ owner: real.userId, org: real.orgId, slot });
    store.set(DEMO_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: DEMO_TTL_SECONDS });
    await logActivity(db, { orgId: real.orgId, actor: { userId: real.userId, email: real.email }, action: "newquip.demo_mode_selected", summary: `[DEMO] Now acting as ${SLOT_LABEL[slot]} (${email})`, detail: { demo: true, marker: "DEMO/IMPERSONATED", effectiveUser: email, effectiveUserId: user.userId, selectedRole: SLOT_LABEL[slot], actualOwner: real.email, actualOwnerUserId: real.userId, ttlSeconds: DEMO_TTL_SECONDS } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

/** Always available (even if the gate has since closed): it only ever REMOVES the demo context, restoring the real owner identity. */
export async function exitDemoModeAction(): Promise<DemoActionResult> {
  try {
    const real = await requireCurrentOrg();
    (await cookies()).delete(DEMO_COOKIE);
    await logActivity(createServiceRoleClient(), { orgId: real.orgId, actor: { userId: real.userId, email: real.email }, action: "newquip.demo_mode_exited", summary: "[DEMO] Exited Demo Mode", detail: { demo: true, marker: "DEMO/IMPERSONATED", actualOwner: real.email } }).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
