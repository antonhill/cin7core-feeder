// The NewQuip-only Projects capabilities (Variations, Products & Fulfilment). One guard, built on the authoritative NewQuip organisation
// check (src/newquip/access.ts) - no organisation id is repeated here. Every server action of those capabilities calls it, so a direct
// invocation from another organisation is refused even though the tabs are also hidden.
import { isNewquipPocOrg } from "@/newquip/access";

export const NEWQUIP_ONLY_MESSAGE = "This capability isn't available for your organization.";

export function assertNewquipOrg(orgId: string): void {
  if (!isNewquipPocOrg(orgId)) throw new Error(NEWQUIP_ONLY_MESSAGE);
}
