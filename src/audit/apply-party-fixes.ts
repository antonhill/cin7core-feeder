import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import type { PartyKind } from "@/audit/party-audit";

export interface PartyFix {
  partyId: string;
  fields: Record<string, string>;
}

export interface ApplyPartyFixesResult {
  succeeded: number;
  failed: { partyId: string; error: string }[];
}

/**
 * Writes a bulk fix straight to the audited Cin7 instance, same "PUT only the
 * ID plus the changed field(s)" convention as applyProductFixes — already
 * confirmed live for Customer specifically (see apply-fixes.ts). Only ever
 * called for `kind: "customer"` today (Tags/SalesRepresentative/Location are
 * the only party-audit fields with one sensible shared value to bulk-apply —
 * see party-audit.ts's module comment), but takes `kind` rather than
 * hardcoding "/customer" in case a genuinely bulk-fixable Supplier field ever
 * comes up.
 */
export async function applyPartyFixes(creds: Cin7Credentials, kind: PartyKind, fixes: PartyFix[]): Promise<ApplyPartyFixesResult> {
  const path = kind === "customer" ? "/customer" : "/supplier";
  let succeeded = 0;
  const failed: { partyId: string; error: string }[] = [];
  for (const fix of fixes) {
    try {
      await cin7Request(creds, path, { method: "PUT", body: { ID: fix.partyId, ...fix.fields } });
      succeeded++;
    } catch (e) {
      failed.push({ partyId: fix.partyId, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return { succeeded, failed };
}
