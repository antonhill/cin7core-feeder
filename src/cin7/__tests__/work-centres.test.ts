import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveWorkCentreId } from "@/cin7/work-centres";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("resolveWorkCentreId", () => {
  it("returns the ID of an existing work centre without creating one", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Workcenters: [{ WorkCenterID: "wc-1", Code: "MIXING" }] });
    const cache = new Map<string, string | null | undefined>();

    const id = await resolveWorkCentreId(creds, "MIXING", cache);

    expect(id).toBe("wc-1");
    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(cache.get("MIXING")).toBe("wc-1");
  });

  it("auto-creates a work centre that doesn't exist yet (safe per Cin7's docs)", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ Workcenters: [] }) // not found
      .mockResolvedValueOnce({ Workcenters: [{ WorkCenterID: "wc-new", Code: "BLENDING" }] }); // create
    const cache = new Map<string, string | null | undefined>();

    const id = await resolveWorkCentreId(creds, "BLENDING", cache);

    expect(id).toBe("wc-new");
    const [, , options] = vi.mocked(cin7Request).mock.calls[1];
    expect(options).toMatchObject({ method: "POST" });
    const body = options?.body as { Workcenters: { Code: string; IsCoMan: boolean }[] };
    expect(body.Workcenters[0]).toMatchObject({ Code: "BLENDING", IsCoMan: false });
  });

  it("skips a cached code (no extra API call)", async () => {
    const cache = new Map<string, string | null | undefined>([["MIXING", "cached-id"]]);
    const id = await resolveWorkCentreId(creds, "MIXING", cache);
    expect(id).toBe("cached-id");
    expect(cin7Request).not.toHaveBeenCalled();
  });
});
