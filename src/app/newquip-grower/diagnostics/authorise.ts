import "server-only";
// Shared authorisation for the NewQuip read-only Cin7 diagnostic (the page and the action both use it; kept out of the "use server" file so it is not an action).
// Fails CLOSED: any throw or false is a refusal with ONE plain message. Order: NewQuip POC org, Quotes module access, no Demo Mode identity, org owner/admin or
// super admin (requireOrgAdmin passes a super admin and refuses a Demo identity), cost rights, then the env gate. The gate defaults OFF.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { assertNoDemoImpersonation } from "@/lib/demo-mode/context";
import { canSeeCosts } from "@/lib/approvals/role-store";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

export const NOT_AUTHORISED = "This diagnostic is not available.";
export const isDiagnosticEnabled = () => process.env.NEWQUIP_CIN7_DIAGNOSTIC_ENABLED === "true";

export type DiagnosticActor = { orgId: string; userId: string; email: string };

export async function authoriseDiagnostic(): Promise<{ ok: true; actor: DiagnosticActor } | { ok: false; error: string }> {
  try {
    const { orgId } = await requireNewquipPocOrg();
    const access = await requireModuleAccess(QUOTES_MODULE.href);
    await assertNoDemoImpersonation("The Cin7 diagnostic");
    await requireOrgAdmin("run the Cin7 read-only diagnostic");
    if (!(await canSeeCosts(createServiceRoleClient(), orgId, access.userId, true))) return { ok: false, error: NOT_AUTHORISED };
    if (!isDiagnosticEnabled()) return { ok: false, error: NOT_AUTHORISED };
    return { ok: true, actor: { orgId, userId: access.userId, email: access.email ?? "unknown" } };
  } catch {
    return { ok: false, error: NOT_AUTHORISED };
  }
}
