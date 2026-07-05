import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

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
  Code?: string;
}

/** The list-wrapper key differs per resource (e.g. CategoryList) and isn't confirmed for Brand/UOM — just take whichever field holds the array. */
function extractEntries(response: Record<string, unknown>): Cin7RefEntry[] {
  const arr = Object.values(response).find((v) => Array.isArray(v));
  return (arr as Cin7RefEntry[] | undefined) ?? [];
}

/**
 * Case-insensitive: confirmed live that Cin7's own uniqueness check is
 * case-insensitive too — a create of "hour" was rejected with "This unit
 * already exists" when an entry differing only in case (e.g. "Hour") was
 * already there. An exact-case comparison here would miss that match and
 * attempt (and fail) to create a redundant entry.
 */
async function referenceExists(creds: Cin7Credentials, path: string, name: string): Promise<boolean> {
  const response = await cin7Request<Record<string, unknown>>(creds, path, {
    query: { Page: 1, Limit: 100, Name: name },
  });
  const target = name.toLowerCase();
  return extractEntries(response).some((e) => e.Name?.toLowerCase() === target);
}

/**
 * Treats Cin7's own "already exists" rejection as success rather than an
 * error — the desired end state (the entry exists) is already true. A
 * belt-and-suspenders safety net alongside the case-insensitive existence
 * check above, for any other mismatch (whitespace, a concurrent sync run)
 * that could produce the same false negative.
 */
async function createReference(creds: Cin7Credentials, path: string, name: string): Promise<void> {
  try {
    await cin7Request(creds, path, { method: "POST", body: { Name: name } });
  } catch (e) {
    if (e instanceof Cin7ApiError && /already exists|must be unique/i.test(e.message)) return;
    throw e;
  }
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

/**
 * Exists-only checks (no auto-create) for reference fields Cin7 can't or
 * won't auto-create on push — confirmed via the same Apiary spec used above:
 * Location (`/ref/location`, matched by Name), Company Contacts
 * (`/me/contacts`, matched by Name — this is what a Customer's
 * SalesRepresentative resolves against, confirmed by Cin7's own error text
 * "...was not found in Company Contacts reference book"), and Chart of
 * Accounts (`/ref/account`, matched by Code OR Name per Cin7's own field
 * docs — "Active account code or name from the chart of accounts").
 *
 * Why these run as a pre-flight check rather than just letting the push
 * itself fail: confirmed live that Cin7's own /customer PUT only reports a
 * handful of validation issues per request — fixing the reported ones
 * reveals a *different* set on the next push, rather than everything at
 * once. Checking every reference field up front (before attempting the
 * actual push) surfaces every problem in one pass instead of a multi-round
 * whack-a-mole cycle.
 */
export const REF_LOCATION_PATH = "/ref/location";
export const REF_ACCOUNT_PATH = "/ref/account";
export const ME_CONTACTS_PATH = "/me/contacts";

/** Unlike `cache` above (Set — only ever records confirmed-exists), this records both outcomes: a wrong value is often repeated across many rows, so a negative result is worth caching too. */
async function cachedFieldExists(
  creds: Cin7Credentials,
  path: string,
  field: "Name" | "Code",
  value: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const cacheKey = `${path}::${field}::${value}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const response = await cin7Request<Record<string, unknown>>(creds, path, {
    query: { Page: 1, Limit: 100, [field]: value },
  });
  const target = value.toLowerCase();
  const found = extractEntries(response).some((e) => (field === "Code" ? e.Code : e.Name)?.toLowerCase() === target);
  cache.set(cacheKey, found);
  return found;
}

export function locationExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, REF_LOCATION_PATH, "Name", name, cache);
}

export function companyContactExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, ME_CONTACTS_PATH, "Name", name, cache);
}

/** Tries Code first (the common case — CSV account fields are usually the numeric code), then Name, since Cin7 accepts either. */
export async function accountExists(creds: Cin7Credentials, codeOrName: string, cache: Map<string, boolean>): Promise<boolean> {
  if (await cachedFieldExists(creds, REF_ACCOUNT_PATH, "Code", codeOrName, cache)) return true;
  return cachedFieldExists(creds, REF_ACCOUNT_PATH, "Name", codeOrName, cache);
}

export const REF_TAX_PATH = "/ref/tax";
export const REF_PRICE_TIER_PATH = "/ref/priceTier";

/**
 * A Customer's TaxRule resolves against `/ref/tax` — not yet part of the
 * pre-flight check (Anton scoped that to fields that had actually failed at
 * the time), but worth a standalone existence check for diagnosing a vague
 * push error: Cin7's own Tax Rule model requires every tax rule to link to a
 * Chart-of-Accounts liability code, so an unresolvable TaxRule could plausibly
 * surface as an "Account ..." error rather than naming TaxRule directly.
 */
export function taxRuleExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, REF_TAX_PATH, "Name", name, cache);
}

/**
 * PriceTier's list endpoint takes no filter params and is normally small
 * (Cin7 ships 10 fixed tiers) — fetched once and matched client-side, unlike
 * the other checks here which filter server-side.
 */
export async function priceTierExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  const cacheKey = `${REF_PRICE_TIER_PATH}::Name::${name}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const response = await cin7Request<{ PriceTiers?: { Code?: number; Name?: string }[] }>(creds, REF_PRICE_TIER_PATH);
  const target = name.toLowerCase();
  const found = (response.PriceTiers ?? []).some((t) => t.Name?.toLowerCase() === target);
  cache.set(cacheKey, found);
  return found;
}
