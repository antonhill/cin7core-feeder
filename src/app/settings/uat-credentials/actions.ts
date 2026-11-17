"use server";

// UAT-only Cin7 credential administration for the NewQuip organisation's existing instance.
//
// Why this exists: Settings > Cin7 instances is gated on being an admin of the ACTIVE organisation, and a Spark super-admin is not an admin (or even a member) of the
// NewQuip organisation. This narrow surface is for Spark super-admins only, works ONLY on a deployment running with CIN7_CREDENTIAL_STORE=uat, targets ONLY the
// NewQuip organisation's single existing instance, and writes ONLY application_key_encrypted_uat (sealed with this deployment's own ENCRYPTION_KEY). It never reads or
// writes the Toolbox column, never creates or deletes an instance, never changes the Account ID, and never returns, logs or audits the key.
import { createServiceRoleClient } from "@/supabase/server";
import { credentialColumn } from "@/cin7/credential-store";
import { encrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { logActivity } from "@/lib/activity-log";
import { createSessionClient } from "@/supabase/server-session";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

export type UatCredentialStatus =
  | { ok: true; instanceName: string; accountId: string; configured: boolean }
  | { ok: false; error: string };
export type UatCredentialResult = { ok: boolean; message: string };

const NEWQUIP_ORG_ID = NEWQUIP_POC_ORG_IDS[0];

function uatOnly(): void {
  if (credentialColumn() !== "application_key_encrypted_uat") throw new Error("This screen exists only on the UAT deployment.");
}

async function currentEmail(): Promise<string | null> {
  const session = await createSessionClient();
  const { data } = await session.auth.getUser();
  return data.user?.email ?? null;
}

async function theInstance() {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("cin7_instances")
    .select("id, name, account_id, active, application_key_encrypted_uat")
    .eq("org_id", NEWQUIP_ORG_ID);
  if (error) throw new Error("Could not read the NewQuip Cin7 instance.");
  if (!data || data.length !== 1) throw new Error("Expected exactly one NewQuip Cin7 instance.");
  return { db, row: data[0] };
}

/** Saving or testing credentials is refused for an inactive instance. */
async function theActiveInstance() {
  const found = await theInstance();
  if (!found.row.active) throw new Error("The NewQuip Cin7 instance is inactive. Activate it before setting or testing credentials.");
  return found;
}

export async function getUatCredentialStatus(): Promise<UatCredentialStatus> {
  try {
    uatOnly();
    await requirePrivilegedSuperAdmin("view the UAT Cin7 credential status");
    const { row } = await theInstance();
    return { ok: true, instanceName: row.name, accountId: row.account_id, configured: Boolean(row.application_key_encrypted_uat) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unavailable" };
  }
}

export async function saveUatCin7Key(applicationKey: string): Promise<UatCredentialResult> {
  try {
    uatOnly();
    const { userId } = await requirePrivilegedSuperAdmin("set the UAT Cin7 Application Key");
    const actor = { userId, email: await currentEmail() };
    const key = typeof applicationKey === "string" ? applicationKey.trim() : "";
    if (key.length < 8 || key.length > 200 || /\s/.test(key)) return { ok: false, message: "That does not look like a Cin7 Application Key." };
    const { db, row } = await theActiveInstance();
    const { error } = await db
      .from("cin7_instances")
      .update({ application_key_encrypted_uat: encrypt(key), updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("org_id", NEWQUIP_ORG_ID);
    // Audit: who, when, which instance and that the UAT key changed. Never the key.
    await logActivity(db, {
      orgId: NEWQUIP_ORG_ID,
      instanceId: row.id,
      actor: { userId: actor.userId, email: actor.email },
      action: "instance.uat_credential_set",
      summary: `Set the UAT-only Cin7 Application Key for "${row.name}"`,
      detail: { outcome: error ? "failed" : "success", store: "uat" },
    });
    if (error) return { ok: false, message: "Could not save the key." };
    return { ok: true, message: "Saved. The key is stored sealed and is not shown again." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unavailable" };
  }
}

/** READ-ONLY: one Cin7 product-list call (page 1, limit 1). Creates nothing in Cin7. */
export async function testUatCin7Connection(): Promise<UatCredentialResult> {
  try {
    uatOnly();
    await requirePrivilegedSuperAdmin("test the UAT Cin7 connection");
    const { db, row } = await theActiveInstance();
    if (!row.application_key_encrypted_uat) return { ok: false, message: "No UAT Application Key has been saved yet." };
    const creds = await loadCin7Credentials(db, NEWQUIP_ORG_ID, row.id);
    const r = await testConnection(creds);
    // Sanitised: only the HTTP status and a fixed diagnostic. The raw Cin7 response body / error text is never returned.
    if (r.ok) return { ok: true, message: "Connected to Cin7 successfully (HTTP 200)." };
    const diagnostic =
      r.status === 403 ? "authentication failed: check the Account ID and Application Key"
      : r.status === 503 ? "Cin7 rate limit reached; try again shortly"
      : r.status === 0 ? "network error reaching Cin7"
      : "unexpected response from Cin7";
    return { ok: false, message: `Cin7 connection test failed (HTTP ${r.status}): ${diagnostic}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unavailable" };
  }
}
