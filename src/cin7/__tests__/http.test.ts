import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cin7ApiError, cin7Request, __resetRateLimiterForTests } from "@/cin7/http";

const creds = { accountId: "acct-1", applicationKey: "key-1", baseUrl: "https://example.test/v2" };

beforeEach(() => {
  process.env.RATE_LIMIT_RPS = "1000"; // avoid throttling slowing down these tests
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockFetchSequence(responses: Array<() => Response>) {
  let call = 0;
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    responses[Math.min(call++, responses.length - 1)]()
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("cin7Request", () => {
  it("sends the correct auth headers, method, and URL", async () => {
    const fn = mockFetchSequence([() => new Response(JSON.stringify({ ID: "abc" }), { status: 200 })]);

    const result = await cin7Request(creds, "/Product", { method: "POST", body: { SKU: "X" }, query: { page: 1 } });

    expect(result).toEqual({ ID: "abc" });
    const [url, init] = fn.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe("https://example.test/v2/Product?page=1");
    expect(init?.method).toBe("POST");
    expect(headers["api-auth-accountid"]).toBe("acct-1");
    expect(headers["api-auth-applicationkey"]).toBe("key-1");
    expect(init?.body).toBe(JSON.stringify({ SKU: "X" }));
  });

  it("throws a non-retryable Cin7ApiError on 400", async () => {
    mockFetchSequence([() => new Response("SKU is required", { status: 400 })]);
    await expect(cin7Request(creds, "/Product")).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("retries on 503 with backoff and eventually succeeds", async () => {
    vi.useFakeTimers();
    const fn = mockFetchSequence([
      () => new Response("", { status: 503 }),
      () => new Response("", { status: 503 }),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const promise = cin7Request(creds, "/Product");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting retries on persistent 503", async () => {
    vi.useFakeTimers();
    mockFetchSequence([() => new Response("", { status: 503 })]);

    const promise = cin7Request(creds, "/Product");
    const assertion = expect(promise).rejects.toBeInstanceOf(Cin7ApiError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("returns undefined for a 204 response", async () => {
    mockFetchSequence([() => new Response(null, { status: 204 })]);
    await expect(cin7Request(creds, "/Product/123", { method: "DELETE" })).resolves.toBeUndefined();
  });
});
