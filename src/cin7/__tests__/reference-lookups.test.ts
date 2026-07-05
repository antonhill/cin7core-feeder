import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ensureReferenceExists,
  REF_BRAND_PATH,
  REF_CATEGORY_PATH,
  REF_UOM_PATH,
  REF_LOCATION_PATH,
  ME_CONTACTS_PATH,
  REF_TAX_PATH,
  REF_PRICE_TIER_PATH,
  REF_PAYMENT_TERM_PATH,
  locationExists,
  companyContactExists,
  accountExists,
  taxRuleExists,
  priceTierExists,
  paymentTermExists,
} from "@/cin7/reference-lookups";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("ensureReferenceExists", () => {
  it("does nothing when the entry already exists", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ CategoryList: [{ ID: "cat-1", Name: "Widgets" }] });
    const cache = new Set<string>();

    await ensureReferenceExists(creds, REF_CATEGORY_PATH, "Widgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cache.has(`${REF_CATEGORY_PATH}::Widgets`)).toBe(true);
  });

  it("creates the entry when it doesn't exist yet, regardless of the list-wrapper key name", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ BrandList: [] }) // not found — key name isn't confirmed for Brand, extractEntries should still find it
      .mockResolvedValueOnce({ ID: "brand-new", Name: "Acme" }); // create
    const cache = new Set<string>();

    await ensureReferenceExists(creds, REF_BRAND_PATH, "Acme", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[1];
    expect(path).toBe("/ref/brand");
    expect(options).toMatchObject({ method: "POST", body: { Name: "Acme" } });
  });

  it("skips a cached path+name pair (no extra API call)", async () => {
    const cache = new Set<string>([`${REF_UOM_PATH}::Item`]);
    await ensureReferenceExists(creds, REF_UOM_PATH, "Item", cache);
    expect(cin7Request).not.toHaveBeenCalled();
  });

  it("doesn't confuse the same name across different reference types (Category 'Acme' vs Brand 'Acme')", async () => {
    const cache = new Set<string>([`${REF_CATEGORY_PATH}::Acme`]);
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ BrandList: [] })
      .mockResolvedValueOnce({ ID: "brand-new", Name: "Acme" });

    await ensureReferenceExists(creds, REF_BRAND_PATH, "Acme", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
  });

  it("doesn't treat a differently-named entry as a match", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CategoryList: [{ ID: "cat-1", Name: "Widgets Old" }] })
      .mockResolvedValueOnce({ ID: "cat-new", Name: "Widgets" });
    const cache = new Set<string>();

    await ensureReferenceExists(creds, REF_CATEGORY_PATH, "Widgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "POST" });
  });

  it("matches an existing entry case-insensitively — confirmed live: Cin7's own uniqueness check is case-insensitive too", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ UnitList: [{ ID: "uom-1", Name: "Hour" }] });
    const cache = new Set<string>();

    await ensureReferenceExists(creds, REF_UOM_PATH, "hour", cache);

    expect(cin7Request).toHaveBeenCalledTimes(1); // no create attempted — exact-case exists check alone would have missed this
  });

  it("treats Cin7's 'already exists' create rejection as success rather than an error", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ UnitList: [] }) // exists-check misses it (e.g. some other mismatch)
      .mockRejectedValueOnce(new Cin7ApiError(400, "This unit already exists. Unit name must be unique.", false));
    const cache = new Set<string>();

    await expect(ensureReferenceExists(creds, REF_UOM_PATH, "hour", cache)).resolves.toBeUndefined();
    expect(cache.has(`${REF_UOM_PATH}::hour`)).toBe(true);
  });

  it("still throws a create failure that isn't an 'already exists' conflict", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ UnitList: [] })
      .mockRejectedValueOnce(new Cin7ApiError(400, "Name is required.", false));

    await expect(ensureReferenceExists(creds, REF_UOM_PATH, "hour", new Set())).rejects.toThrow("Name is required.");
  });
});

describe("locationExists / companyContactExists / accountExists (exists-only, no auto-create)", () => {
  it("locationExists checks /ref/location by Name", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ LocationList: [{ ID: "loc-1", Name: "Main Warehouse" }] });

    await expect(locationExists(creds, "Main Warehouse", new Map())).resolves.toBe(true);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe(REF_LOCATION_PATH);
    expect(options).toMatchObject({ query: { Name: "Main Warehouse" } });
  });

  it("locationExists returns false for a location that isn't in the list", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ LocationList: [] });
    await expect(locationExists(creds, "Main Warehouse Nooo", new Map())).resolves.toBe(false);
  });

  it("companyContactExists checks /me/contacts by Name", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ MeContactsList: [{ ContactID: "c-1", Name: "Anton" }] });

    await expect(companyContactExists(creds, "Anton", new Map())).resolves.toBe(true);
    const [, path] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe(ME_CONTACTS_PATH);
  });

  it("accountExists tries Code first, then falls back to Name", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ AccountsList: [] }) // Code lookup misses
      .mockResolvedValueOnce({ AccountsList: [{ Code: "610", Name: "Accounts Receivable" }] }); // Name lookup hits

    await expect(accountExists(creds, "Accounts Receivable", new Map())).resolves.toBe(true);
    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, , codeOptions] = vi.mocked(cin7Request).mock.calls[0];
    expect(codeOptions).toMatchObject({ query: { Code: "Accounts Receivable" } });
    const [, , nameOptions] = vi.mocked(cin7Request).mock.calls[1];
    expect(nameOptions).toMatchObject({ query: { Name: "Accounts Receivable" } });
  });

  it("accountExists matches by Code without a second call when the code lookup hits", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ AccountsList: [{ Code: "610", Name: "Accounts Receivable" }] });

    await expect(accountExists(creds, "610", new Map())).resolves.toBe(true);
    expect(cin7Request).toHaveBeenCalledTimes(1);
  });

  it("accountExists returns false when neither Code nor Name matches", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ AccountsList: [] }).mockResolvedValueOnce({ AccountsList: [] });
    await expect(accountExists(creds, "6767676", new Map())).resolves.toBe(false);
  });

  it("accountExists returns false (not a crash) when Cin7 itself errors on an unmatched Code — confirmed live, GET /ref/account?Code= can 400 instead of returning an empty list", async () => {
    vi.mocked(cin7Request)
      .mockRejectedValueOnce(new Cin7ApiError(400, '[{"ErrorCode":400,"Exception":"Account with specified ID not found"}]', false))
      .mockResolvedValueOnce({ AccountsList: [] }); // Name lookup still runs, also misses

    await expect(accountExists(creds, "3443434", new Map())).resolves.toBe(false);
  });

  it("still propagates a retryable Cin7ApiError (rate limit, network) rather than treating it as not-found", async () => {
    vi.mocked(cin7Request).mockRejectedValueOnce(new Cin7ApiError(503, "Rate limited", true));
    await expect(locationExists(creds, "Main Warehouse", new Map())).rejects.toThrow("Rate limited");
  });

  it("caches a non-retryable-error-derived false result too, so a repeated bad value doesn't re-hit a failing endpoint", async () => {
    const cache = new Map<string, boolean>();
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(400, "Account with specified ID not found", false));

    await locationExists(creds, "Main Warehouse Nooo", cache);
    await locationExists(creds, "Main Warehouse Nooo", cache);

    expect(cin7Request).toHaveBeenCalledTimes(1);
  });

  it("caches a negative result too — a wrong value repeated across many rows shouldn't re-hit the API", async () => {
    const cache = new Map<string, boolean>();
    vi.mocked(cin7Request).mockResolvedValue({ LocationList: [] });

    await locationExists(creds, "Main Warehouse Nooo", cache);
    await locationExists(creds, "Main Warehouse Nooo", cache);

    expect(cin7Request).toHaveBeenCalledTimes(1);
  });

  it("taxRuleExists checks /ref/tax by Name", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ TaxRuleList: [{ ID: "t-1", Name: "Standard Rate Sales", Account: "820" }] });

    await expect(taxRuleExists(creds, "Standard Rate Sales", new Map())).resolves.toBe(true);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe(REF_TAX_PATH);
    expect(options).toMatchObject({ query: { Name: "Standard Rate Sales" } });
  });

  it("taxRuleExists returns false for a tax rule that isn't in the list", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ TaxRuleList: [] });
    await expect(taxRuleExists(creds, "Standard Rate Sales1", new Map())).resolves.toBe(false);
  });

  it("priceTierExists fetches the full (unfiltered) list and matches client-side", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      PriceTiers: [{ Code: 1, Name: "Retail in VAT" }, { Code: 2, Name: "Wholesale" }],
    });

    await expect(priceTierExists(creds, "Retail in VAT", new Map())).resolves.toBe(true);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe(REF_PRICE_TIER_PATH);
    expect(options).toBeUndefined();
  });

  it("priceTierExists returns false for a tier name that isn't in the list", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ PriceTiers: [{ Code: 1, Name: "Retail in VAT" }] });
    await expect(priceTierExists(creds, "Retail in VAT wrong", new Map())).resolves.toBe(false);
  });

  it("paymentTermExists checks /ref/paymentterm by Name", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ PaymentTermList: [{ ID: "p-1", Name: "Cash", IsActive: true }] });

    await expect(paymentTermExists(creds, "Cash", new Map())).resolves.toBe(true);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe(REF_PAYMENT_TERM_PATH);
    expect(options).toMatchObject({ query: { Name: "Cash" } });
  });

  it("paymentTermExists returns false for a payment term that isn't in the list", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ PaymentTermList: [] });
    await expect(paymentTermExists(creds, "cashe", new Map())).resolves.toBe(false);
  });

  it("paymentTermExists returns false for a same-named payment term that's been deactivated — confirmed live: Cin7's own error text is \"Active payment term with name X was not found\", not just \"payment term\"", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ PaymentTermList: [{ ID: "p-1", Name: "cash", IsActive: false }] });
    await expect(paymentTermExists(creds, "cash", new Map())).resolves.toBe(false);
  });

  it("paymentTermExists treats a missing IsActive as active — Cin7's own docs say True is the default", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ PaymentTermList: [{ ID: "p-1", Name: "cash" }] });
    await expect(paymentTermExists(creds, "cash", new Map())).resolves.toBe(true);
  });
});
