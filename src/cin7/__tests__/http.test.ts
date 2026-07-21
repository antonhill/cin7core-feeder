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

  it("retries a non-503 rate-limit response ('...60 calls per 60 seconds...') and eventually succeeds", async () => {
    vi.useFakeTimers();
    const fn = mockFetchSequence([
      () => new Response('[{"ErrorCode":400,"Exception":"You have reached 60 calls per 60 seconds API limit."}]', { status: 400 }),
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const promise = cin7Request(creds, "/purchase");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on a persistent non-503 rate-limit response, marking it retryable", async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      () => new Response('[{"ErrorCode":400,"Exception":"You have reached 60 calls per 60 seconds API limit."}]', { status: 400 }),
    ]);

    const promise = cin7Request(creds, "/purchase");
    const assertion = expect(promise).rejects.toMatchObject({ status: 400, retryable: true });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("returns undefined for a 204 response", async () => {
    mockFetchSequence([() => new Response(null, { status: 204 })]);
    await expect(cin7Request(creds, "/Product/123", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("retries a raw network error (like 503) and eventually succeeds", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fn = vi.fn(async () => {
      if (call++ < 2) throw new Error("fetch failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);

    const promise = cin7Request(creds, "/BillOfMaterials", { method: "PUT" });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("surfaces the underlying cause, method, and path after exhausting retries on a network error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error("fetch failed", { cause: new Error("ECONNRESET") });
    });
    vi.stubGlobal("fetch", fn);

    const promise = cin7Request(creds, "/BillOfMaterials", { method: "PUT" });
    const assertion = expect(promise).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("PUT /BillOfMaterials"),
    });
    await vi.runAllTimersAsync();
    await assertion;
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("ECONNRESET") });
  });

  it("names the method/path when a 200 response isn't valid JSON (usually a wrong path)", async () => {
    mockFetchSequence([() => new Response("<!DOCTYPE html><html>...</html>", { status: 200 })]);

    await expect(cin7Request(creds, "/production/workcenters", { method: "GET" })).rejects.toMatchObject({
      message: expect.stringContaining("GET /production/workcenters"),
    });
  });

  describe("per-account rate limiting", () => {
    const credsB = { accountId: "acct-2", applicationKey: "key-2", baseUrl: "https://example.test/v2" };

    it("does not block a different account's call behind another account's pacing", async () => {
      process.env.RATE_LIMIT_RPS = "1";
      vi.useFakeTimers();
      const fn = mockFetchSequence([
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);

      const promiseA = cin7Request(creds, "/Product");
      const promiseB = cin7Request(credsB, "/Product");
      await vi.advanceTimersByTimeAsync(0);

      // Both went through without either waiting on the other's pacing —
      // under the old shared-global limiter, the second call here would
      // still be asleep at this point.
      expect(fn).toHaveBeenCalledTimes(2);
      await Promise.all([promiseA, promiseB]);
    });

    it("still paces two calls for the same account at least one interval apart", async () => {
      process.env.RATE_LIMIT_RPS = "1";
      vi.useFakeTimers();
      const fn = mockFetchSequence([
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);

      const promiseA = cin7Request(creds, "/Product");
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      const promiseB = cin7Request(creds, "/Product");
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1); // still paced behind the first call

      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);

      await Promise.all([promiseA, promiseB]);
    });

    it("still paces N calls one interval apart when they're all launched in the same tick — pull-instance.ts's Promise.all over products/customers/suppliers for one account is exactly this shape", async () => {
      process.env.RATE_LIMIT_RPS = "1";
      vi.useFakeTimers();
      const fn = mockFetchSequence([
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);

      // No await between these — mirrors Promise.all([a(), b(), c()]) launching
      // all three before any of them has had a chance to sleep-then-write back
      // its own call timestamp. Under the old racy throttle(), b and c would
      // both read the same stale lastCallAt and fire together.
      const promises = [cin7Request(creds, "/Product"), cin7Request(creds, "/customer"), cin7Request(creds, "/supplier")];

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(3);

      await Promise.all(promises);
    });
  });
});
