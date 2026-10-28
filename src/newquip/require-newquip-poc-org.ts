import { requireCurrentOrg, type CurrentOrg } from "@/lib/current-org";
import { isNewquipPocOrg } from "@/newquip/access";

/** Shared by the POC's layout.tsx (redirect) and its actions.ts (defence in depth). */
export async function requireNewquipPocOrg(): Promise<CurrentOrg> {
  const current = await requireCurrentOrg();
  if (!isNewquipPocOrg(current.orgId)) throw new Error("This tool isn't available for your organization.");
  return current;
}
