import { describe, expect, it, vi, beforeEach } from "vitest";
import { testConnection } from "@/cin7/client";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("testConnection", () => {
  it("goes through the cin7Request gateway (not a standalone fetch) with maxRetries: 0 — security re-audit P0-1", async () => {
    vi.mocked(cin7Request).mockResolvedValue({});
    const result = await testConnection(creds);
    expect(result).toEqual({ ok: true, status: 200, message: "Connected successfully." });
    expect(cin7Request).toHaveBeenCalledWith(creds, "/Product", { query: { page: 1, limit: 1 }, maxRetries: 0 });
  });

  it("reports a 503 as rate-limited", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(503, "Rate limited (60 calls/min) and retries exhausted", true));
    const result = await testConnection(creds);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("reports a 403 as an authentication failure", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(403, "Forbidden", false));
    const result = await testConnection(creds);
    expect(result).toEqual({ ok: false, status: 403, message: "Authentication failed — check the account ID and application key." });
  });

  it("reports a network error (status 0)", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(0, "Network error on GET /Product after 1 attempt(s): fetch failed", true));
    const result = await testConnection(creds);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toContain("fetch failed");
  });

  it("handles a thrown non-Cin7ApiError gracefully", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Error("boom"));
    const result = await testConnection(creds);
    expect(result).toEqual({ ok: false, status: 0, message: "Network error: boom" });
  });
});
