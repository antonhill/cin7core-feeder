import "server-only";
// Shared authorisation for the NewQuip read-only Cin7 diagnostic (the page and the action both use it; kept out of the "use server" file so it is not an action).
// Fails CLOSED: any throw or false is a refusal with ONE plain message. Order: the env gate (cheap, no DB read, defaults OFF), a signed-in user, NewQuip POC org,
// no Demo Mode identity, Quotes module access, org owner/admin or super admin (requireOrgAdmin passes a super admin and refuses a Demo identity), cost rights.
// A refusal carries a short reason code and, once a user is known, that identity (so the action can audit it); it never carries one before authentication.
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { assertNoDemoImpersonation } from "@/lib/demo-mode/context";
import { requireCurrentOrg } from "@/lib/current-org";
import { canSeeCosts } from "@/lib/approvals/role-store";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

export const NOT_AUTHORISED = "This diagnostic is not available.";
export const isDiagnosticEnabled = () => process.env.NEWQUIP_CIN7_DIAGNOSTIC_ENABLED === "true";

export type DiagnosticActor = { orgId: string; userId: string; email: string };
export type RefusalReason = "not_enabled" | "wrong_org" | "demo" | "not_admin";
export type DiagnosticAuth = { ok: true; actor: DiagnosticActor } | { ok: false; error: string; reason: RefusalReason; identity: DiagnosticActor | null };

export async function authoriseDiagnostic(db: SupabaseClient): Promise<DiagnosticAuth> {
  const refuse = (reason: RefusalReason, identity: DiagnosticActor | null = null): DiagnosticAuth => ({ ok: false, error: NOT_AUTHORISED, reason, identity });
  if (!isDiagnosticEnabled()) return refuse("not_enabled");
  let identity: DiagnosticActor;
  try {
    const me = await requireCurrentOrg();
    identity = { orgId: me.orgId, userId: me.userId, email: me.email ?? "unknown" };
  } catch { return refuse("not_admin"); } // unauthenticated: nothing is known, nothing is audited
  try { await requireNewquipPocOrg(); } catch { return refuse("wrong_org", identity); }
  try { await assertNoDemoImpersonation("The Cin7 diagnostic"); } catch { return refuse("demo", identity); }
  try {
    const access = await requireModuleAccess(QUOTES_MODULE.href);
    await requireOrgAdmin("run the Cin7 read-only diagnostic");
    if (!(await canSeeCosts(db, identity.orgId, access.userId, true))) return refuse("not_admin", identity);
    return { ok: true, actor: { orgId: identity.orgId, userId: access.userId, email: access.email ?? identity.email } };
  } catch { return refuse("not_admin", identity); }
}
