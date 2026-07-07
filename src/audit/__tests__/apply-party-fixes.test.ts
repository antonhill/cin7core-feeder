import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyPartyFixes } from "@/audit/apply-party-fixes";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("applyPartyFixes", () => {
  it("PUTs to /customer for kind customer, only ID plus the changed fields", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "c1" });
    await applyPartyFixes(creds, "customer", [{ partyId: "c1", fields: { Tags: "vip" } }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/customer", { method: "PUT", body: { ID: "c1", Tags: "vip" } });
  });

  it("PUTs to /supplier for kind supplier", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "s1" });
    await applyPartyFixes(creds, "supplier", [{ partyId: "s1", fields: { TaxNumber: "123" } }]);
    expect(cin7Request).toHaveBeenCalledWith(creds, "/supplier", { method: "PUT", body: { ID: "s1", TaxNumber: "123" } });
  });

  it("counts successes and continues past a failure instead of aborting the batch", async () => {
    vi.mocked(cin7Request).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ID: "c2" });

    const result = await applyPartyFixes(creds, "customer", [
      { partyId: "c1", fields: { Tags: "vip" } },
      { partyId: "c2", fields: { Tags: "vip" } },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toEqual([{ partyId: "c1", error: "boom" }]);
  });
});
