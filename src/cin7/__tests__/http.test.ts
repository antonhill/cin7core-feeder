import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cin7ApiError, cin7Request, cin7RawRequest } from "@/cin7/http";

import { CIN7_API_ORIGIN } from "@/cin7/api-origin";
import { acquireCin7Slot, reportCin7RateLimitCooldown } from "@/cin7/rate-limit";

// Security re-audit round 3, item 3.1: the distributed coordinator is now
// the ONLY pacing mechanism (the old in-memory per-invocation throttle
// fallback for "degrade" reads was removed — it let real HTTP requests
// through completely unaccounted by the shared bucket). Default the mock to
// "granted" so most tests here (which aren't specifically exercising the
// coordinator's own unavailable/contended handling) proceed immediately,
// same shape as the real common case. The distributed limiter's own
// behaviour (including the read/write "degrade" vs "blocked" split) is
// covered in cin7/__tests__/rate-limit.test.ts.
vi.mock("@/cin7/rate-limit", () => ({
  acquireCin7Slot: vi.fn(async () => "granted"),
  reportCin7RateLimitCooldown: vi.fn(async () => {}),
  __resetDistributedLimiterForTests: vi.fn(),
}));

// baseUrl here is deliberately a bogus host — the request must still go to the canonical
// Cin7 origin, proving a member-editable / DB-stored base_url can never redirect credentials.
const creds = { accountId: "acct-1", applicationKey: "key-1", baseUrl: "https://example.test/v2" };

beforeEach(() => {
  vi.mocked(acquireCin7Slot).mockReset().mockResolvedValue("granted");
  vi.mocked(reportCin7RateLimitCooldown).mockReset().mockResolvedValue(undefined);
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
    // Canonical origin, NOT creds.baseUrl ("https://example.test/v2") — the SSRF fix.
    expect(String(url)).toBe(`${CIN7_API_ORIGIN}/Product?page=1`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual"); // never auto-follow a redirect off-origin
    expect(headers["api-auth-accountid"]).toBe("acct-1");
    expect(headers["api-auth-applicationkey"]).toBe("key-1");
    expect(init?.body).toBe(JSON.stringify({ SKU: "X" }));
  });

  it("SSRF: a malicious stored baseUrl cannot redirect credentials off the canonical Cin7 host", async () => {
    const evilCreds = { accountId: "acct-1", applicationKey: "key-1", baseUrl: "https://evil.example/steal" };
    const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

    await cin7Request(evilCreds, "/Product");

    const [url] = fn.mock.calls[0];
    // Credentials only ever go to the allowlisted Cin7 origin — never to evil.example.
    expect(new URL(String(url)).origin).toBe(new URL(CIN7_API_ORIGIN).origin);
    expect(String(url)).not.toContain("evil.example");
  });

  it("refuses to follow a redirect off-origin (does not leak credentials to the redirect target)", async () => {
    mockFetchSequence([
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } }),
    ]);
    await expect(cin7Request(creds, "/Product")).rejects.toMatchObject({
      message: expect.stringContaining("refusing to follow"),
    });
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

    // operationTimeoutMs raised so this test observes retry-COUNT exhaustion
    // specifically, not the operation-level deadline (covered separately below).
    const promise = cin7Request(creds, "/purchase", { operationTimeoutMs: Number.MAX_SAFE_INTEGER });
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

    // operationTimeoutMs raised so this test observes retry-COUNT exhaustion
    // specifically, not the operation-level deadline (covered separately below).
    const promise = cin7Request(creds, "/BillOfMaterials", { method: "PUT", operationTimeoutMs: Number.MAX_SAFE_INTEGER });
    const assertion = expect(promise).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("PUT /BillOfMaterials"),
    });
    await vi.runAllTimersAsync();
    await assertion;
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("ECONNRESET") });
  });

  describe("security re-audit P0-2: nonIdempotentCreate — no automatic resend after an ambiguous network failure", () => {
    it("throws immediately (no retry) and marks the error ambiguous, on the very first network failure", async () => {
      const fn = vi.fn(async () => {
        throw new Error("fetch failed");
      });
      vi.stubGlobal("fetch", fn);

      await expect(cin7Request(creds, "/purchase", { method: "POST", nonIdempotentCreate: true })).rejects.toMatchObject({
        ambiguous: true,
        retryable: false,
      });
      // No sleep/backoff needed to observe this — it must never have looped.
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT mark a definite rejection (Cin7 responded and declined) as ambiguous", async () => {
      mockFetchSequence([() => new Response("SKU is required", { status: 400 })]);

      await expect(cin7Request(creds, "/purchase", { method: "POST", nonIdempotentCreate: true })).rejects.toMatchObject({
        status: 400,
        ambiguous: false,
      });
    });

    it("still retries a 503 normally — a rate-limit response is a definite rejection, not an ambiguous one", async () => {
      vi.useFakeTimers();
      const fn = mockFetchSequence([
        () => new Response("", { status: 503 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);

      const promise = cin7Request(creds, "/purchase", { method: "POST", nonIdempotentCreate: true });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("a PUT/idempotent call (nonIdempotentCreate omitted) keeps retrying network errors exactly as before — markSaleShipped-style POST calls that AREN'T opted in also keep the old behavior", async () => {
      const fn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fn);
      // No nonIdempotentCreate here — default retry behavior, proven by the
      // pre-existing "retries a raw network error" test above; this just
      // confirms a POST without the flag doesn't get the ambiguous treatment.
      await expect(cin7Request(creds, "/sale/fulfilment/ship", { method: "POST" })).resolves.toEqual({ ok: true });
    });
  });

  describe("security re-audit P0-1/P0-4: maxRetries and timeoutMs overrides", () => {
    it("maxRetries: 0 gives up after a single attempt instead of the default 6 retries", async () => {
      const fn = vi.fn(async () => {
        throw new Error("fetch failed");
      });
      vi.stubGlobal("fetch", fn);

      await expect(cin7Request(creds, "/Product", { maxRetries: 0 })).rejects.toBeInstanceOf(Cin7ApiError);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("attaches an AbortSignal timeout to every fetch call", async () => {
      const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
      await cin7Request(creds, "/Product");
      const [, init] = fn.mock.calls[0];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("security re-audit P0-3: write traffic never bypasses the distributed coordinator", () => {
    it("passes allowDegrade:true for a GET (read) and allowDegrade:false for a POST (write)", async () => {
      mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
      await cin7Request(creds, "/Product");
      expect(acquireCin7Slot).toHaveBeenLastCalledWith(
        "acct-1",
        "key-1",
        expect.objectContaining({ allowDegrade: true }) // also carries maxWaitMs — round 3, item 4, covered separately below
      );

      mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
      await cin7Request(creds, "/Product", { method: "POST" });
      expect(acquireCin7Slot).toHaveBeenLastCalledWith("acct-1", "key-1", expect.objectContaining({ allowDegrade: false }));
    });

    it("never sends the real HTTP request on a 'blocked' outcome — retries the acquire itself instead", async () => {
      vi.useFakeTimers();
      vi.mocked(acquireCin7Slot).mockResolvedValueOnce("blocked").mockResolvedValueOnce("granted");
      const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

      const promise = cin7Request(creds, "/Product", { method: "POST" });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true });
      expect(fn).toHaveBeenCalledTimes(1); // the real request only fires once "granted"
      expect(acquireCin7Slot).toHaveBeenCalledTimes(2);
    });

    it("gives up with a clear error after exhausting retries while permanently 'blocked' — never proceeds unpaced (the old 'proceed anyway' escape hatch is gone)", async () => {
      vi.useFakeTimers();
      vi.mocked(acquireCin7Slot).mockResolvedValue("blocked");
      const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

      const promise = cin7Request(creds, "/Product", { method: "POST", operationTimeoutMs: Number.MAX_SAFE_INTEGER });
      const assertion = expect(promise).rejects.toMatchObject({
        status: 0,
        message: expect.stringContaining("refusing to send POST /Product unpaced"),
      });
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).not.toHaveBeenCalled(); // the real HTTP request was never sent
    });

    describe("security re-audit round 3, item 3.1: a 'degrade' read is treated the same as 'blocked' — no in-memory throttle fallback", () => {
      it("never sends the real HTTP request on a 'degrade' outcome — retries the acquire itself instead, exactly like 'blocked'", async () => {
        vi.useFakeTimers();
        vi.mocked(acquireCin7Slot).mockResolvedValueOnce("degrade").mockResolvedValueOnce("granted");
        const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

        const promise = cin7Request(creds, "/Product"); // GET → allowDegrade:true → can receive "degrade"
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual({ ok: true });
        expect(fn).toHaveBeenCalledTimes(1); // the real request only fires once "granted"
        expect(acquireCin7Slot).toHaveBeenCalledTimes(2);
      });

      it("gives up with a clear error after exhausting retries while permanently 'degrade' — never falls back to sending unpaced", async () => {
        vi.useFakeTimers();
        vi.mocked(acquireCin7Slot).mockResolvedValue("degrade");
        const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

        const promise = cin7Request(creds, "/Product", { operationTimeoutMs: Number.MAX_SAFE_INTEGER });
        const assertion = expect(promise).rejects.toMatchObject({
          status: 0,
          message: expect.stringContaining("refusing to send GET /Product unpaced"),
        });
        await vi.runAllTimersAsync();
        await assertion;
        expect(fn).not.toHaveBeenCalled(); // the real HTTP request was never sent — the old local-throttle fallback is gone
      });
    });
  });

  describe("security re-audit P0-3: Cin7 503s feed a shared cooldown", () => {
    it("reports a cooldown on a 503 before retrying", async () => {
      vi.useFakeTimers();
      const fn = mockFetchSequence([
        () => new Response("", { status: 503 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);
      const promise = cin7Request(creds, "/Product");
      await vi.runAllTimersAsync();
      await promise;

      expect(reportCin7RateLimitCooldown).toHaveBeenCalledWith("acct-1", "key-1", expect.any(Number));
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("reports a cooldown on the /purchase-family's non-standard rate-limit response too", async () => {
      vi.useFakeTimers();
      mockFetchSequence([
        () => new Response('[{"ErrorCode":400,"Exception":"You have reached 60 calls per 60 seconds API limit."}]', { status: 400 }),
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ]);
      const promise = cin7Request(creds, "/purchase");
      await vi.runAllTimersAsync();
      await promise;

      expect(reportCin7RateLimitCooldown).toHaveBeenCalledWith("acct-1", "key-1", expect.any(Number));
    });

    it("does NOT report a cooldown on a definite, non-rate-limit rejection", async () => {
      mockFetchSequence([() => new Response("SKU is required", { status: 400 })]);
      await expect(cin7Request(creds, "/Product", { method: "POST" })).rejects.toThrow();
      expect(reportCin7RateLimitCooldown).not.toHaveBeenCalled();
    });
  });

  describe("security re-audit P0-4: operation-level deadline bounds the whole call, not just one attempt", () => {
    it("fails fast once the operation deadline has passed, instead of starting another attempt", async () => {
      vi.useFakeTimers();
      const fn = vi.fn(async () => {
        throw new Error("fetch failed");
      });
      vi.stubGlobal("fetch", fn);

      const promise = cin7Request(creds, "/Product", { operationTimeoutMs: 1000 });
      const assertion = expect(promise).rejects.toMatchObject({
        message: expect.stringContaining("exceeded its 1000ms operation deadline"),
      });
      await vi.runAllTimersAsync();
      await assertion;
      // Far fewer than the default 7 attempts (maxRetries 6 + 1) — the 5s+
      // backoff between attempt 1 and 2 alone already exceeds the 1000ms budget.
      expect(fn.mock.calls.length).toBeLessThan(3);
    });

    it("always allows at least one attempt, even with a tiny operationTimeoutMs", async () => {
      const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
      await expect(cin7Request(creds, "/Product", { operationTimeoutMs: 1 })).resolves.toEqual({ ok: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    describe("security re-audit round 3, item 4: every blocking sub-operation is clamped to the REMAINING budget, not the fixed configured value", () => {
      it("clamps the fetch's AbortSignal timeout to the remaining operation budget, not the full configured timeoutMs", async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
        mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

        // timeoutMs (20s default) is far larger than the 500ms operation budget —
        // the fetch must be given ~500ms, not the full 20s, or a stalled connection
        // could run the operation deadline over before the fetch's own timeout ever fires.
        await cin7Request(creds, "/Product", { operationTimeoutMs: 500 });

        const usedTimeout = timeoutSpy.mock.calls[0][0] as number;
        expect(usedTimeout).toBeLessThanOrEqual(500);
        expect(usedTimeout).toBeGreaterThan(0);
        timeoutSpy.mockRestore();
      });

      it("passes a clamped maxWaitMs (not the coordinator's own larger default) to acquireCin7Slot", async () => {
        mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);
        await cin7Request(creds, "/Product", { operationTimeoutMs: 500 });

        const [, , opts] = vi.mocked(acquireCin7Slot).mock.calls[0];
        expect(opts.maxWaitMs).toBeLessThanOrEqual(500);
        expect(opts.maxWaitMs).toBeGreaterThan(0);
      });

      it("a retry's backoff sleep never overruns the operation deadline — the deadline error fires on the very next iteration instead of a full 5s+ sleep", async () => {
        vi.useFakeTimers();
        vi.mocked(acquireCin7Slot).mockResolvedValue("blocked"); // never grants — forces the backoff-sleep path every attempt
        const fn = mockFetchSequence([() => new Response(JSON.stringify({ ok: true }), { status: 200 })]);

        // RETRY_BASE_DELAY_MS is 5000 — attempt 0's backoff alone would be
        // 5000ms if unclamped, dwarfing this 200ms operation budget.
        const promise = cin7Request(creds, "/Product", { operationTimeoutMs: 200 });
        const assertion = expect(promise).rejects.toMatchObject({
          message: expect.stringContaining("exceeded its 200ms operation deadline"),
        });
        // If the backoff sleep were NOT clamped, this would still be pending
        // (it would need a real 5000ms of fake-timer advancement to resolve).
        await vi.advanceTimersByTimeAsync(200);
        await assertion;
        expect(fn).not.toHaveBeenCalled(); // never granted, so the real request never fired
      });
    });
  });

  it("names the method/path when a 200 response isn't valid JSON (usually a wrong path)", async () => {
    mockFetchSequence([() => new Response("<!DOCTYPE html><html>...</html>", { status: 200 })]);

    await expect(cin7Request(creds, "/production/workcenters", { method: "GET" })).rejects.toMatchObject({
      message: expect.stringContaining("GET /production/workcenters"),
    });
  });

  // "per-account rate limiting" (the old in-memory per-invocation throttle)
  // was removed here — security re-audit round 3, item 3.1 deleted that
  // fallback machinery entirely (see http.ts's top-of-module comment and the
  // "degrade is treated the same as blocked" tests above). Per-account/
  // per-application pacing is now handled exclusively by the distributed
  // Postgres coordinator, covered by cin7/__tests__/rate-limit.test.ts's own
  // "acquireCin7Slot under concurrent load (multi-worker)" suite.
});

describe("cin7RawRequest — security re-audit P0-1's one sanctioned raw-fetch escape hatch", () => {
  it("goes through the canonical origin and standard headers, returning the raw status/text instead of parsing or throwing", async () => {
    const fn = mockFetchSequence([() => new Response("<html>not found</html>", { status: 200 })]);

    const result = await cin7RawRequest(creds, "/production/workcenters", { Page: "1", Limit: "100" });

    expect(result).toEqual({ status: 200, text: "<html>not found</html>" });
    const [url, init] = fn.mock.calls[0];
    // Canonical origin, NOT creds.baseUrl — same SSRF fix as cin7Request.
    expect(String(url)).toBe(`${CIN7_API_ORIGIN}/production/workcenters?Page=1&Limit=100`);
    expect(init?.redirect).toBe("manual");
    const headers = init?.headers as Record<string, string>;
    expect(headers["api-auth-accountid"]).toBe("acct-1");
    expect(headers["api-auth-applicationkey"]).toBe("key-1");
  });

  it("returns a non-2xx status as data, not a throw — the caller decides what a 404/500 means", async () => {
    mockFetchSequence([() => new Response("server error", { status: 500 })]);
    const result = await cin7RawRequest(creds, "/some/candidate/path");
    expect(result).toEqual({ status: 500, text: "server error" });
  });

  it("reports status 0 (not the redirect status) on an unfollowed redirect — never leaks credentials off-origin", async () => {
    const fn = vi.fn(async () => {
      const r = new Response(null, { status: 302 });
      Object.defineProperty(r, "type", { value: "opaqueredirect" });
      return r;
    });
    vi.stubGlobal("fetch", fn);
    const result = await cin7RawRequest(creds, "/some/path");
    expect(result.status).toBe(0);
  });

  it("does not retry or throttle — a single bare attempt, since diagnostic probes pace themselves", async () => {
    const fn = mockFetchSequence([() => new Response("boom", { status: 503 })]);
    const result = await cin7RawRequest(creds, "/some/path");
    expect(result).toEqual({ status: 503, text: "boom" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe("security re-audit round 3, item 3.2: participates in the same distributed quota coordinator as cin7Request", () => {
    it("acquires a real quota token (allowDegrade:false) before sending the raw fetch", async () => {
      mockFetchSequence([() => new Response("ok", { status: 200 })]);
      await cin7RawRequest(creds, "/some/path");
      expect(acquireCin7Slot).toHaveBeenCalledWith("acct-1", "key-1", { allowDegrade: false });
    });

    it("throws a clear error and never sends the real fetch when the coordinator doesn't grant a token — no retry loop, matching this function's own no-retry design", async () => {
      vi.mocked(acquireCin7Slot).mockResolvedValue("blocked");
      const fn = mockFetchSequence([() => new Response("ok", { status: 200 })]);

      await expect(cin7RawRequest(creds, "/some/path")).rejects.toMatchObject({
        status: 0,
        message: expect.stringContaining("refusing to send GET /some/path unpaced"),
      });
      expect(fn).not.toHaveBeenCalled();
      expect(acquireCin7Slot).toHaveBeenCalledTimes(1); // no retry — a single acquire attempt, same no-retry design as the fetch itself
    });

    it("throws on any non-'granted' outcome, not just 'blocked' — the check is !== 'granted', not === 'blocked'", async () => {
      vi.mocked(acquireCin7Slot).mockResolvedValue("degrade");
      const fn = mockFetchSequence([() => new Response("ok", { status: 200 })]);

      await expect(cin7RawRequest(creds, "/some/path")).rejects.toMatchObject({ status: 0 });
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
