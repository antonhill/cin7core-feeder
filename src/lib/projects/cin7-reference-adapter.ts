import "server-only";
// The READ-ONLY Cin7 adapter for the Sale-creation form's pick lists: locations and the Chart of Accounts of the organisation's own instance.
// GET only. Credentials are loaded for the org's own instance, never leave the server and are never logged. Nothing is written anywhere.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllAccounts, fetchAllLocations } from "@/cin7/reference-lookups";
import { accountOptions, unsupportedAccountError, type AccountOption } from "./cin7-account-eligibility";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface Cin7ReferenceOptions { locations: string[]; accounts: AccountOption[] }

export async function readCin7ReferenceOptions(db: Db, orgId: string, instanceId: string): Promise<Cin7ReferenceOptions> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const [locations, accounts] = await Promise.all([fetchAllLocations(creds), fetchAllAccounts(creds)]);
  return { locations: locations.map((l) => l.name).sort((x, y) => x.localeCompare(y)), accounts: accountOptions(accounts) };
}

/** Read-only server-side check of the revenue account a Sale is about to be created with. Throws if Cin7 cannot be read (fail closed); returns a message or null. */
export async function verifyRevenueAccountForSale(db: Db, orgId: string, instanceId: string, code: string): Promise<string | null> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  return unsupportedAccountError(await fetchAllAccounts(creds), code);
}
