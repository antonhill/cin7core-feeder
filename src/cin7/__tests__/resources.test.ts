import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveResourceId } from "@/cin7/resources";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("resolveResourceId", () => {
  it("returns the ID of an existing resource", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Resources: [{ ResourceID: "res-1", Code: "MACH001" }] });
    const cache = new Map<string, string | null | undefined>();

    const id = await resolveResourceId(creds, "MACH001", cache);

    expect(id).toBe("res-1");
    expect(cache.get("MACH001")).toBe("res-1");
  });

  it("always sends Page and Limit — same 'page not found' issue as Work Centres otherwise", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Resources: [{ ResourceID: "res-1", Code: "MACH001" }] });
    await resolveResourceId(creds, "MACH001", new Map());

    const [, , options] = vi.mocked(cin7Request).mock.calls[0];
    expect(options?.query).toMatchObject({ Page: 1, Limit: 100, Name: "MACH001" });
  });

  it("throws a clear, actionable error instead of auto-creating a missing resource", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Resources: [] });
    const cache = new Map<string, string | null | undefined>();

    await expect(resolveResourceId(creds, "LAB1", cache)).rejects.toThrow(
      /Resource "LAB1" not found[\s\S]*create it manually/
    );
  });

  it("skips a cached code (no extra API call)", async () => {
    const cache = new Map<string, string | null | undefined>([["MACH001", "cached-id"]]);
    const id = await resolveResourceId(creds, "MACH001", cache);
    expect(id).toBe("cached-id");
    expect(cin7Request).not.toHaveBeenCalled();
  });
});
