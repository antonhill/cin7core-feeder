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

  let response: Record<string, unknown>;
  try {
    response = await cin7Request<Record<string, unknown>>(creds, path, {
      query: { Page: 1, Limit: 100, [field]: value },
    });
  } catch (e) {
    // Confirmed live (2026-07-06): GET /ref/account?Code=<value that doesn't
    // exist> can itself return a 400 ("Account with specified ID not
    // found") instead of an empty list — contrary to what the community
    // spec's sample response implies. From an exists-check's perspective,
    // "Cin7 says it can't find it" and "Cin7 errored trying to look it up"
    // mean the same thing: not found. Without this, a genuinely-missing
    // value crashes the whole pre-flight check before it can finish
    // evaluating the *other* fields, and the crash surfaces as Cin7's raw
    // (and unhelpfully vague) error text instead of our own clear message —
    // exactly the bug that made this look like a Xero/QuickBooks-sync issue
    // before the diagnostic tool proved otherwise. A retryable failure
    // (rate limit, network) still propagates — that's a real infrastructure
    // problem, not a "this value doesn't exist" signal.
    if (e instanceof Cin7ApiError && !e.retryable) {
      cache.set(cacheKey, false);
      return false;
    }
    throw e;
  }
  const target = value.toLowerCase();
  const found = extractEntries(response).some((e) => (field === "Code" ? e.Code : e.Name)?.toLowerCase() === target);
  cache.set(cacheKey, found);
  return found;
}

export function locationExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, REF_LOCATION_PATH, "Name", name, cache);
}

export interface Cin7Location {
  id: string;
  name: string;
}

/**
 * Every location in the account, with its real GUID — needed by Bulk
 * Reorder Points (src/reports/replenish/reorder-config.ts) to add a
 * brand-new per-location `ReorderLevels` entry to a product that doesn't
 * have one yet: confirmed live 2026-07-14 that a `ReorderLevels` write
 * requires `LocationID`, not just `LocationName`. Unlike Replenish's own
 * "no Locations master-list, use product_availability's distinct
 * locations" approach, this works even for a location with zero currently
 * synced stock, since it comes straight from Cin7's own reference book.
 */
export async function fetchAllLocations(creds: Cin7Credentials): Promise<Cin7Location[]> {
  const pageSize = 100;
  const all: Cin7Location[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<Record<string, unknown>>(creds, REF_LOCATION_PATH, {
      query: { Page: page, Limit: pageSize },
    });
    const entries = extractEntries(response);
    for (const e of entries) if (e.ID && e.Name) all.push({ id: e.ID, name: e.Name });
    if (entries.length < pageSize) break;
  }
  return all;
}

export function companyContactExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, ME_CONTACTS_PATH, "Name", name, cache);
}

/** Tries Code first (the common case — CSV account fields are usually the numeric code), then Name, since Cin7 accepts either. */
export async function accountExists(creds: Cin7Credentials, codeOrName: string, cache: Map<string, boolean>): Promise<boolean> {
  if (await cachedFieldExists(creds, REF_ACCOUNT_PATH, "Code", codeOrName, cache)) return true;
  return cachedFieldExists(creds, REF_ACCOUNT_PATH, "Name", codeOrName, cache);
}

interface Cin7AccountEntry {
  Code?: string;
  Name?: string;
  SystemAccount?: string;
}

/**
 * AccountPayable/AccountReceivable require a *specific system-designated*
 * account, not just any existing one — confirmed live 2026-07-06 by
 * comparing two real accounts that share the same Type/Class (CURRLIAB/
 * LIABILITY): code "800" ("Accounts Payable", `SystemAccount: "Accounts
 * payable"`) genuinely works for AccountPayable, but code "801" ("Unpaid
 * Expense Claims", `SystemAccount: "Unpaid expense claims"`) exists and has
 * the identical Type/Class yet is rejected by the real push — `SystemAccount`
 * is the actual discriminator, matching Cin7's own field docs ("Only special
 * account [payable/receivable] accounts are valid for this field"). Plain
 * `accountExists` (Type/Class-blind existence only) can't tell these apart;
 * this checks both existence *and* the matching SystemAccount value.
 */
async function specialAccountExists(
  creds: Cin7Credentials,
  codeOrName: string,
  systemAccount: "Accounts payable" | "Accounts receivable",
  cache: Map<string, boolean>
): Promise<boolean> {
  const cacheKey = `${REF_ACCOUNT_PATH}::special::${systemAccount}::${codeOrName}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const target = codeOrName.toLowerCase();
  for (const field of ["Code", "Name"] as const) {
    try {
      const response = await cin7Request<{ AccountsList?: Cin7AccountEntry[] }>(creds, REF_ACCOUNT_PATH, {
        query: { Page: 1, Limit: 100, [field]: codeOrName },
      });
      const match = (response.AccountsList ?? []).some(
        (a) => (field === "Code" ? a.Code?.toLowerCase() === target : a.Name?.toLowerCase() === target) && a.SystemAccount === systemAccount
      );
      if (match) {
        cache.set(cacheKey, true);
        return true;
      }
    } catch (e) {
      // Same non-retryable-error-means-not-found handling as cachedFieldExists — try the next field instead of crashing.
      if (!(e instanceof Cin7ApiError && !e.retryable)) throw e;
    }
  }

  cache.set(cacheKey, false);
  return false;
}

export function payableAccountExists(creds: Cin7Credentials, codeOrName: string, cache: Map<string, boolean>): Promise<boolean> {
  return specialAccountExists(creds, codeOrName, "Accounts payable", cache);
}

export function receivableAccountExists(creds: Cin7Credentials, codeOrName: string, cache: Map<string, boolean>): Promise<boolean> {
  return specialAccountExists(creds, codeOrName, "Accounts receivable", cache);
}

export const REF_TAX_PATH = "/ref/tax";
export const REF_PRICE_TIER_PATH = "/ref/priceTier";
export const REF_PAYMENT_TERM_PATH = "/ref/paymentterm";

/**
 * A Customer's TaxRule resolves against `/ref/tax`. Originally added only for
 * a standalone diagnostic (Cin7's own Tax Rule model requires every rule to
 * link to a Chart-of-Accounts liability code, so an unresolvable TaxRule can
 * surface as a generic "Account ..." error rather than naming TaxRule
 * directly) — folded into the real customer pre-flight check in run-sync.ts
 * once that diagnostic confirmed TaxRule/PriceTier are fields that actually
 * fail in practice, same bar Anton originally set for the first four fields.
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

/**
 * A Customer/Supplier's PaymentTerm resolves against `/ref/paymentterm`
 * (confirmed via the same Apiary spec used throughout this file — matched by
 * Name, same shape as Location/Tax). Added for parity with TaxRule once
 * Anton flagged a fake-but-non-blank PaymentTerm ("cashe") that the blank
 * check alone can't catch.
 *
 * Real bug found 2026-07-06: an early version used the generic
 * `cachedFieldExists` (Name-only match), which said a payment term "existed"
 * even when the real push rejected it — confirmed by Cin7's own error text,
 * `"Active payment term with name cash was not found"`. The push requires an
 * *active* payment term specifically; a same-named but deactivated one
 * still shows up in the plain GET list. Now filters on `IsActive` too — a
 * term with `IsActive` explicitly `false` doesn't count as a match, but a
 * missing/undefined `IsActive` does (Cin7's own docs: "`True` as default").
 *
 * Doesn't reuse `cachedFieldExists` (Name/Code-only) since this needs the
 * extra IsActive field from the response — bespoke, like priceTierExists.
 *
 * No equivalent exists for Currency: searched the same spec end-to-end and
 * there is no reference-book/list endpoint for currency codes anywhere —
 * Currency is a free-text 3-character field everywhere it appears, with
 * nothing to check it against live. Left unchecked rather than guessed.
 */
export async function paymentTermExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  const cacheKey = `${REF_PAYMENT_TERM_PATH}::Name::${name}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let response: { PaymentTermList?: { Name?: string; IsActive?: boolean }[] };
  try {
    response = await cin7Request<{ PaymentTermList?: { Name?: string; IsActive?: boolean }[] }>(creds, REF_PAYMENT_TERM_PATH, {
      query: { Page: 1, Limit: 100, Name: name },
    });
  } catch (e) {
    if (e instanceof Cin7ApiError && !e.retryable) {
      cache.set(cacheKey, false);
      return false;
    }
    throw e;
  }

  const target = name.toLowerCase();
  const found = (response.PaymentTermList ?? []).some((t) => t.Name?.toLowerCase() === target && t.IsActive !== false);
  cache.set(cacheKey, found);
  return found;
}

export const REF_ATTRIBUTE_SET_PATH = "/ref/attributeset";
export const REF_DISCOUNT_PATH = "/reference/discount";

/**
 * A Product's ProductAttributeSet resolves against `/ref/attributeset` —
 * same shape as Location/Tax (Name/Page/Limit, `AttributeSetList` wrapper),
 * confirmed via the Apiary spec. No `IsActive` field exists on this
 * resource, unlike PaymentTerm/DiscountRule, so the generic exists-only
 * check applies unmodified.
 */
export function attributeSetExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  return cachedFieldExists(creds, REF_ATTRIBUTE_SET_PATH, "Name", name, cache);
}

/**
 * A Product's DiscountName resolves against `/reference/discount` — note the
 * different path prefix (`/reference/*`, not `/ref/*`) confirmed via the
 * Apiary spec. Unlike the other reference-book endpoints here, there's no
 * exact-match `Name` query param — only `Search` (a substring match), so
 * results are fetched by Search and filtered client-side for an exact
 * case-insensitive match, same reasoning as `priceTierExists`' full-fetch.
 * Cin7's own field docs for DiscountRule ("discount with this name must
 * exist ... and should be active") mirror PaymentTerm's IsActive
 * requirement, so a same-named but deactivated rule doesn't count either.
 */
export async function productDiscountExists(creds: Cin7Credentials, name: string, cache: Map<string, boolean>): Promise<boolean> {
  const cacheKey = `${REF_DISCOUNT_PATH}::Name::${name}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let response: { DiscountRules?: { Name?: string; IsActive?: boolean }[] };
  try {
    response = await cin7Request<{ DiscountRules?: { Name?: string; IsActive?: boolean }[] }>(creds, REF_DISCOUNT_PATH, {
      query: { Page: 1, Limit: 100, Search: name },
    });
  } catch (e) {
    if (e instanceof Cin7ApiError && !e.retryable) {
      cache.set(cacheKey, false);
      return false;
    }
    throw e;
  }

  const target = name.toLowerCase();
  const found = (response.DiscountRules ?? []).some((d) => d.Name?.toLowerCase() === target && d.IsActive !== false);
  cache.set(cacheKey, found);
  return found;
}
