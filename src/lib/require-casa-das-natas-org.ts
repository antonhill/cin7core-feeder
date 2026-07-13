import { requireCurrentOrg, type CurrentOrg } from "@/lib/current-org";
import { CASA_DAS_NATAS_ORG_ID } from "@/lib/casa-das-natas";

/** Shared guard for both the Natas report's layout.tsx (redirect on failure) and its actions.ts (defense in depth) — same convention as requireOrgAdmin being shared across settings/members' layout + actions. */
export async function requireCasaDasNatasOrg(): Promise<CurrentOrg> {
  const current = await requireCurrentOrg();
  if (current.orgId !== CASA_DAS_NATAS_ORG_ID) throw new Error("This report isn't available for your organization.");
  return current;
}
