import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { probeWorkCentrePaths } from "@/cin7/debug";
import { cin7RawRequest } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7RawRequest: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7RawRequest).mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Security re-audit P0-1: probeWorkCentrePaths used to build its own URL
 * from creds.baseUrl and call fetch() directly — a second, independent
 * credential-bearing network path outside the gateway. Now routes through
 * cin7RawRequest (see http.test.ts for that primitive's own coverage); this
 * confirms the wiring itself — every candidate path is actually probed via
 * cin7RawRequest with no path silently skipped, and its raw status/text is
 * correctly classified as JSON or not.
 */
describe("probeWorkCentrePaths — security re-audit P0-1", () => {
  it("probes every candidate path via cin7RawRequest and classifies JSON vs HTML responses", async () => {
    vi.mocked(cin7RawRequest).mockImplementation(async (_creds, path) => {
      if (path === "/production/WorkCenters") return { status: 200, text: JSON.stringify({ WorkCentres: [] }) };
      return { status: 200, text: "<html>Page not found</html>" };
    });

    const promise = probeWorkCentrePaths(creds);
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(results).toHaveLength(8);
    expect(cin7RawRequest).toHaveBeenCalledTimes(8);
    expect(cin7RawRequest).toHaveBeenCalledWith(creds, "/production/workcenters", { Page: "1", Limit: "100", Name: "" });

    const hit = results.find((r) => r.path === "/production/WorkCenters");
    expect(hit).toMatchObject({ status: 200, looksLikeJson: true });

    const miss = results.find((r) => r.path === "/production/workcenters");
    expect(miss).toMatchObject({ status: 200, looksLikeJson: false });
  });

  it("records a per-path network failure without aborting the remaining candidates", async () => {
    vi.mocked(cin7RawRequest).mockRejectedValueOnce(new Error("network blip")).mockResolvedValue({ status: 200, text: "<html></html>" });

    const promise = probeWorkCentrePaths(creds);
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(results).toHaveLength(8);
    expect(results[0]).toMatchObject({ status: 0, looksLikeJson: false, snippet: "network blip" });
    expect(cin7RawRequest).toHaveBeenCalledTimes(8);
  });
});
