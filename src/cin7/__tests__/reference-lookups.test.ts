import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureReferenceExists, REF_BRAND_PATH, REF_CATEGORY_PATH, REF_UOM_PATH } from "@/cin7/reference-lookups";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

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

  it("only treats an exact name match as existing", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CategoryList: [{ ID: "cat-1", Name: "Widgets Old" }] })
      .mockResolvedValueOnce({ ID: "cat-new", Name: "Widgets" });
    const cache = new Set<string>();

    await ensureReferenceExists(creds, REF_CATEGORY_PATH, "Widgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "POST" });
  });
});
