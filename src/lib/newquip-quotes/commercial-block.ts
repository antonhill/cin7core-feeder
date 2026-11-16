import { COMMERCIAL_SCHEMA, parseCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";

// THE INTERIM STORE for Manager-entered commercial settings (pure helpers; the database calls live in document-store.ts).
//
// There is deliberately NO new table: the owner has not approved a database change. Settings live as a versioned `commercial` block INSIDE the existing append-only
// newquip_company_profiles.profile jsonb (every save inserts a NEW row; earlier rows are never changed). They are kept strictly apart from the customer-facing fields:
//   - `latestProfile()` returns the profile WITHOUT the block, so the customer-document builder, the missing-fields check and the company-details page can never read it;
//   - saving company details (cleanProfile builds a fresh object) carries the existing block forward untouched;
//   - saving commercial settings carries the customer-facing fields forward untouched.
// MIGRATION PATH: a dedicated append-only newquip_commercial_settings table (org_id, revision, settings jsonb, entered_by, created_at, Manager-only write, Rep-isolated read like
// the 0122 tables); backfill from the latest `commercial` block of each org's newest profile row; then stop writing the block here. The block shape is the table's row shape.
// Database-level Rep isolation of newquip_company_profiles (migration 0122) is what keeps a Rep's own session from reading the block directly; the application never sends it to a Rep.

export interface CommercialBlock {
  schema: typeof COMMERCIAL_SCHEMA;
  /** 1, 2, 3 ... counts commercial changes only (a company-details save does not bump it). */
  revision: number;
  enteredBy: string;
  enteredAt: string;
  settings: CommercialSettings;
}
export interface CommercialVersion { revision: number; enteredBy: string; enteredAt: string; settings: CommercialSettings }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The profile exactly as the customer-facing code may see it: no `commercial` key, ever. */
export function withoutCommercial<T extends object>(profile: T): T {
  const { commercial: _c, ...rest } = profile as T & { commercial?: unknown }; void _c;
  return rest as T;
}

/** The commercial block of a stored profile, or null when there is none or it does not validate (a damaged block is treated as not set, never trusted). */
export function commercialOf(profile: unknown, nowIso: string): CommercialVersion | null {
  if (!isObj(profile) || !isObj(profile.commercial)) return null;
  const c = profile.commercial;
  const parsed = parseCommercialSettings(c.settings, nowIso);
  if (!parsed.ok || c.schema !== COMMERCIAL_SCHEMA || !Number.isSafeInteger(c.revision) || (c.revision as number) < 1 || typeof c.enteredBy !== "string" || typeof c.enteredAt !== "string") return null;
  return { revision: c.revision as number, enteredBy: c.enteredBy, enteredAt: c.enteredAt, settings: parsed.value };
}

/** The next profile jsonb for a commercial change: every customer-facing field carried forward verbatim, the block replaced by the next revision. */
export function nextProfileWithCommercial(storedProfile: unknown, prior: CommercialVersion | null, settings: CommercialSettings, enteredBy: string, nowIso: string): Record<string, unknown> {
  const base = isObj(storedProfile) ? withoutCommercial(storedProfile) : {};
  const block: CommercialBlock = { schema: COMMERCIAL_SCHEMA, revision: (prior?.revision ?? 0) + 1, enteredBy, enteredAt: nowIso, settings };
  return { ...base, commercial: block };
}

/** The next profile jsonb for a company-details change: the validated customer fields, with the stored block (if any) carried forward byte for byte. */
export function nextProfileWithDetails(cleanDetails: object, storedProfile: unknown): Record<string, unknown> {
  const block = isObj(storedProfile) && isObj(storedProfile.commercial) ? storedProfile.commercial : undefined;
  return { ...cleanDetails, ...(block ? { commercial: block } : {}) };
}
