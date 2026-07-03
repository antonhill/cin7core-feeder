import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed via github.com/nnhansg/dear-openapi's Apiary spec transcription
 * and corroborated by real wired-up calls in
 * github.com/FalconEyeSolutions/CIN7-DearInventory's generated client (not
 * just schema definitions): Category, Brand, and UOM are all simple
 * "reference book" CRUD resources with an identical shape — GET to list
 * (matched by exact Name), POST `{"Name": "..."}` to create, no other
 * required fields. Each is referenced on the Product payload by plain Name
 * string, not by ID, so there's nothing to resolve for the push itself —
 * this only needs to ensure the name exists first. Confirmed live:
 * POST/PUT /Product rejects an unrecognized Category/Brand with a 404
 * ("Category not found." / "Brand '...' was not found in reference book")
 * — unlike Cin7's own UI/CSV bulk-import, which auto-creates these on the
 * fly. UOM push-side rejection hasn't been hit live yet, but the same risk
 * applies since Cin7's API never auto-creates reference-book entries.
 *
 * Deliberately NOT extended to every reference-book field: Tax Rules
 * (`/ref/tax`) require an existing liability Account to create, and Chart of
 * Accounts (`/ref/account`) explicitly must not be auto-created — Cin7's own
 * spec states account writes are blocked when Xero/QuickBooks integration is
 * enabled, since the accounting system (not Cin7) is the source of truth
 * there. Those must already exist in Cin7; a rejection there is a real
 * config gap to flag to the client, not something to paper over.
 */
export const REF_CATEGORY_PATH = "/ref/category";
export const REF_BRAND_PATH = "/ref/brand";
export const REF_UOM_PATH = "/ref/unit";

interface Cin7RefEntry {
  ID?: string;
  Name?: string;
}

/** The list-wrapper key differs per resource (e.g. CategoryList) and isn't confirmed for Brand/UOM — just take whichever field holds the array. */
function extractEntries(response: Record<string, unknown>): Cin7RefEntry[] {
  const arr = Object.values(response).find((v) => Array.isArray(v));
  return (arr as Cin7RefEntry[] | undefined) ?? [];
}

async function referenceExists(creds: Cin7Credentials, path: string, name: string): Promise<boolean> {
  const response = await cin7Request<Record<string, unknown>>(creds, path, {
    query: { Page: 1, Limit: 100, Name: name },
  });
  return extractEntries(response).some((e) => e.Name === name);
}

async function createReference(creds: Cin7Credentials, path: string, name: string): Promise<void> {
  await cin7Request(creds, path, { method: "POST", body: { Name: name } });
}

/**
 * Ensures a reference-book entry (Category/Brand/UOM) exists in this Cin7
 * instance, creating it if missing — mutates `cache` in place (keyed by
 * `path::name`, so the same name under different fields, e.g. a Category and
 * a Brand both called "Acme", aren't conflated) so a name checked once
 * doesn't need a second call for the rest of this sync run.
 */
export async function ensureReferenceExists(
  creds: Cin7Credentials,
  path: string,
  name: string,
  cache: Set<string>
): Promise<void> {
  const cacheKey = `${path}::${name}`;
  if (cache.has(cacheKey)) return;
  if (await referenceExists(creds, path, name)) {
    cache.add(cacheKey);
    return;
  }
  await createReference(creds, path, name);
  cache.add(cacheKey);
}
