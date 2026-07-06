import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyProductFixes, mergeCategoryNames, mergeUOMNames, mergeTagNames } from "@/audit/apply-fixes";
import { cin7Request } from "@/cin7/http";
import { fetchAllProductsWithBom } from "@/cin7/products";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});
vi.mock("@/cin7/products", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/products")>();
  return { ...actual, fetchAllProductsWithBom: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
  vi.mocked(fetchAllProductsWithBom).mockReset();
});

describe("applyProductFixes", () => {
  it("PUTs only the ID plus the changed fields — not a full product payload", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "p1" });
    await applyProductFixes(creds, [{ productId: "p1", fields: { Brand: "Acme" } }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { method: "PUT", body: { ID: "p1", Brand: "Acme" } });
  });

  it("counts successes and continues past a failure instead of aborting the batch", async () => {
    vi.mocked(cin7Request)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ID: "p2" });

    const result = await applyProductFixes(creds, [
      { productId: "p1", fields: { Brand: "Acme" } },
      { productId: "p2", fields: { Brand: "Acme" } },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toEqual([{ productId: "p1", error: "boom" }]);
  });

  it("returns an empty result for an empty fix list without calling Cin7", async () => {
    const result = await applyProductFixes(creds, []);
    expect(result).toEqual({ succeeded: 0, failed: [] });
    expect(cin7Request).not.toHaveBeenCalled();
  });
});

describe("mergeCategoryNames", () => {
  it("re-tags only products currently under one of the from-names, skipping ones already on the target name", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([
      { ID: "p1", SKU: "A", Category: "Home Decor" },
      { ID: "p2", SKU: "B", Category: "Home Decore" },
      { ID: "p3", SKU: "C", Category: "Home Decor" }, // already the target — no fix needed
      { ID: "p4", SKU: "D", Category: "Kitchen" }, // unrelated category — untouched
    ]);
    vi.mocked(cin7Request).mockResolvedValue({});

    const result = await mergeCategoryNames(creds, ["Home Decore"], "Home Decor");

    expect(result.succeeded).toBe(1);
    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { method: "PUT", body: { ID: "p2", Category: "Home Decor" } });
  });

  it("re-fetches live data rather than trusting stale IDs from an earlier scan", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([]);
    await mergeCategoryNames(creds, ["Old Name"], "New Name");
    expect(fetchAllProductsWithBom).toHaveBeenCalledWith(creds);
  });

  it("falls back to SKU as the failure identifier when a product has no ID", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([{ SKU: "NO-ID", Category: "Old" }]);
    vi.mocked(cin7Request).mockRejectedValueOnce(new Error("rejected"));

    const result = await mergeCategoryNames(creds, ["Old"], "New");
    expect(result.failed).toEqual([{ productId: "NO-ID", error: "rejected" }]);
  });
});

describe("mergeUOMNames", () => {
  it("re-tags only products currently under one of the from-names, skipping ones already on the target name", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([
      { ID: "p1", SKU: "A", UOM: "Item" },
      { ID: "p2", SKU: "B", UOM: "item" },
      { ID: "p3", SKU: "C", UOM: "Item" }, // already the target — no fix needed
      { ID: "p4", SKU: "D", UOM: "Box" }, // unrelated value — untouched
    ]);
    vi.mocked(cin7Request).mockResolvedValue({});

    const result = await mergeUOMNames(creds, ["item"], "Item");

    expect(result.succeeded).toBe(1);
    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { method: "PUT", body: { ID: "p2", UOM: "Item" } });
  });
});

describe("mergeTagNames", () => {
  it("rewrites only the matching token within each product's comma-delimited Tags, leaving other tags on the product untouched", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([
      { ID: "p1", SKU: "A", Tags: "GIFTSET,fragile" },
      { ID: "p2", SKU: "B", Tags: "giftset" },
      { ID: "p3", SKU: "C", Tags: "fragile" }, // no matching tag — untouched
    ]);
    vi.mocked(cin7Request).mockResolvedValue({});

    const result = await mergeTagNames(creds, ["GIFTSET"], "giftset");

    expect(result.succeeded).toBe(1);
    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { method: "PUT", body: { ID: "p1", Tags: "giftset,fragile" } });
  });

  it("dedupes if rewriting a token would produce the same tag twice on one product", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([{ ID: "p1", SKU: "A", Tags: "GIFTSET,giftset" }]);
    vi.mocked(cin7Request).mockResolvedValue({});

    await mergeTagNames(creds, ["GIFTSET"], "giftset");
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { method: "PUT", body: { ID: "p1", Tags: "giftset" } });
  });

  it("skips products whose Tags don't contain any of the from-names", async () => {
    vi.mocked(fetchAllProductsWithBom).mockResolvedValueOnce([{ ID: "p1", SKU: "A", Tags: "fragile" }]);
    const result = await mergeTagNames(creds, ["GIFTSET"], "giftset");
    expect(result).toEqual({ succeeded: 0, failed: [] });
    expect(cin7Request).not.toHaveBeenCalled();
  });
});
