import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureCategoryExists } from "@/cin7/categories";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("ensureCategoryExists", () => {
  it("does nothing when the category already exists", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ CategoryList: [{ ID: "cat-1", Name: "Widgets" }] });
    const cache = new Set<string>();

    await ensureCategoryExists(creds, "Widgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cache.has("Widgets")).toBe(true);
  });

  it("creates the category when it doesn't exist yet — confirmed live: POST/PUT /Product rejects an unrecognized Category", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CategoryList: [] }) // not found
      .mockResolvedValueOnce({ ID: "cat-new", Name: "Gadgets" }); // create
    const cache = new Set<string>();

    await ensureCategoryExists(creds, "Gadgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[1];
    expect(path).toBe("/ref/category");
    expect(options).toMatchObject({ method: "POST", body: { Name: "Gadgets" } });
    expect(cache.has("Gadgets")).toBe(true);
  });

  it("skips a cached name (no extra API call)", async () => {
    const cache = new Set<string>(["Widgets"]);
    await ensureCategoryExists(creds, "Widgets", cache);
    expect(cin7Request).not.toHaveBeenCalled();
  });

  it("only treats an exact name match as existing", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CategoryList: [{ ID: "cat-1", Name: "Widgets Old" }] }) // no exact match
      .mockResolvedValueOnce({ ID: "cat-new", Name: "Widgets" });
    const cache = new Set<string>();

    await ensureCategoryExists(creds, "Widgets", cache);

    expect(cin7Request).toHaveBeenCalledTimes(2);
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "POST" });
  });
});
