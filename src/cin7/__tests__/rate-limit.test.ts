import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createServiceRoleClient = vi.fn(() => ({ rpc }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => createServiceRoleClient() }));

import { acquireCin7Slot, reportCin7RateLimitCooldown, __resetDistributedLimiterForTests } from "@/cin7/rate-limit";

const READ = { allowDegrade: true };
const WRITE = { allowDegrade: false };

beforeEach(() => {
  vi.clearAllMocks();
  createServiceRoleClient.mockImplementation(() => ({ rpc }));
  __resetDistributedLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.RATE_LIMIT_RPS = "0.8";
  process.env.CIN7_RATE_LIMIT_BURST = "5";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireCin7Slot", () => {
  it("returns granted and consumes a token when one is available immediately", async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    await expect(acquireCin7Slot("acct-1", "key-1", READ)).resolves.toBe("granted");
    expect(rpc).toHaveBeenCalledWith("cin7_rate_limit_acquire", {
      p_bucket_key: expect.any(String),
      p_capacity: 5,
      p_refill_per_sec: 0.8,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("security re-audit P0-3: fingerprints the bucket key from BOTH accountId and applicationKey — never the raw applicationKey itself", async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    await acquireCin7Slot("acct-1", "super-secret-key", READ);
    const key = rpc.mock.calls[0][1].p_bucket_key as string;
    expect(key).not.toBe("acct-1");
    expect(key).not.toContain("super-secret-key");
    expect(key).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest

    rpc.mockClear();
    await acquireCin7Slot("acct-1", "a-different-key", READ);
    const key2 = rpc.mock.calls[0][1].p_bucket_key as string;
    expect(key2).not.toBe(key); // different applicationKey -> different bucket, same account
  });

  it("sleeps the returned wait, then retries until a token is granted", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce({ data: 1250, error: null }).mockResolvedValueOnce({ data: 0, error: null });
    const p = acquireCin7Slot("acct-1", "key-1", READ);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("granted");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("degrades (a read) on a transient DB error, and stays available for later calls", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection lost" } });
    await expect(acquireCin7Slot("acct-1", "key-1", READ)).resolves.toBe("degrade");
    // Not latched off — a later call still tries the RPC and can succeed.
    rpc.mockResolvedValue({ data: 0, error: null });
    await expect(acquireCin7Slot("acct-1", "key-1", READ)).resolves.toBe("granted");
  });

  it("security re-audit P0-3: a write gets blocked (not degrade) on the exact same transient DB error a read would degrade on", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection lost" } });
    await expect(acquireCin7Slot("acct-1", "key-1", WRITE)).resolves.toBe("blocked");
  });

  it("latches off when the function is missing (42883 — migration not applied), skipping the RPC thereafter", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    await expect(acquireCin7Slot("acct-1", "key-1", READ)).resolves.toBe("degrade");
    expect(rpc).toHaveBeenCalledTimes(1);

    rpc.mockClear();
    await expect(acquireCin7Slot("acct-1", "key-1", WRITE)).resolves.toBe("blocked");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns degrade (read) / blocked (write) rather than throwing when client creation itself throws", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(acquireCin7Slot("acct-1", "key-1", READ)).resolves.toBe("degrade");
    await expect(acquireCin7Slot("acct-1", "key-1", WRITE)).resolves.toBe("blocked");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("degrades (read) after exhausting its own short internal budget under heavy contention", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: 500, error: null }); // never grants a token
    const p = acquireCin7Slot("acct-1", "key-1", READ);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("degrade");
  });

  it("security re-audit P0-3: blocks (write) rather than proceeding anyway after exhausting the same internal budget — the old 'proceed anyway' escape hatch is gone", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: 500, error: null }); // never grants a token
    const p = acquireCin7Slot("acct-1", "key-1", WRITE);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("blocked");
  });

  it("security re-audit P0-3: gives up on the wall-clock deadline, not just the attempt count — a degraded refill rate can't consume the whole invocation one sleep at a time", async () => {
    vi.useFakeTimers();
    // Every attempt reports a full MAX_SLEEP_MS-sized wait (never grants a
    // token) — the internal wall-clock deadline must cut this off well
    // before the attempt-count ceiling would.
    rpc.mockResolvedValue({ data: 15_000, error: null });
    const p = acquireCin7Slot("acct-1", "key-1", READ);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("degrade");
    expect(rpc.mock.calls.length).toBeLessThan(10); // MAX_ACQUIRE_ATTEMPTS
  });
});

describe("reportCin7RateLimitCooldown", () => {
  it("reports a cooldown for the fingerprinted bucket key, swallowing its own errors", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await reportCin7RateLimitCooldown("acct-1", "key-1", 10_000);
    expect(rpc).toHaveBeenCalledWith("cin7_rate_limit_report_cooldown", {
      p_bucket_key: expect.any(String),
      p_cooldown_ms: 10_000,
    });
  });

  it("never throws, even when the RPC itself errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "db exploded" } });
    await expect(reportCin7RateLimitCooldown("acct-1", "key-1", 10_000)).resolves.toBeUndefined();
  });

  it("never throws when client creation itself throws", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(reportCin7RateLimitCooldown("acct-1", "key-1", 10_000)).resolves.toBeUndefined();
  });
});

/**
 * Security re-audit P0-3: "add multi-worker tests proving aggregate traffic
 * stays under the configured quota." This simulates N concurrent callers
 * (Promise.all, no await between them — the same shape a burst of
 * concurrent serverless invocations would produce) against a mock RPC that
 * faithfully reproduces the real Postgres function's serialization (an
 * internal async mutex standing in for cin7_rate_limit_acquire's `FOR
 * UPDATE` row lock — see migration 0075) and asserts the aggregate granted
 * count never exceeds capacity, regardless of arrival order.
 *
 * This is the client-side complement to a live proof already run directly
 * against the real Postgres function (10 genuinely concurrent connections
 * against one capacity-5 bucket, via 10 parallel Supabase MCP execute_sql
 * calls): exactly 5 were granted (wait_ms: 0), the other 5 correctly
 * computed increasing queued wait times — confirming the row lock itself
 * serializes real concurrent transactions correctly. This test instead
 * proves acquireCin7Slot's OWN handling of a concurrent Promise.all burst
 * has no client-side race (e.g. no locally cached token, no bucket-key
 * mismatch across concurrent calls).
 */
describe("acquireCin7Slot under concurrent load (multi-worker)", () => {
  function makeSerializedBucket(capacity: number, refillPerSec: number) {
    let tokens = capacity;
    let updatedAt = Date.now();
    let queue: Promise<unknown> = Promise.resolve();

    // Mimics FOR UPDATE: every call serializes onto the same queue, so two
    // "concurrent" callers can never interleave their read-modify-write.
    return () =>
      (queue = queue.then(() => {
        const now = Date.now();
        const elapsed = (now - updatedAt) / 1000;
        tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
        updatedAt = now;
        if (tokens >= 1) {
          tokens -= 1;
          return { data: 0, error: null };
        }
        return { data: Math.ceil(((1 - tokens) / refillPerSec) * 1000), error: null };
      }));
  }

  it("grants at most `capacity` tokens out of a burst of concurrent callers sharing one bucket, regardless of arrival order", async () => {
    vi.useFakeTimers();
    const capacity = 5;
    const acquire = makeSerializedBucket(capacity, 0.01); // negligible refill during the test
    rpc.mockImplementation(() => acquire());

    const WORKER_COUNT = 20;
    const p = Promise.all(Array.from({ length: WORKER_COUNT }, () => acquireCin7Slot("acct-1", "key-1", READ)));
    await vi.runAllTimersAsync();
    const outcomes = await p;

    const granted = outcomes.filter((o) => o === "granted").length;
    const notGranted = outcomes.filter((o) => o !== "granted").length;
    expect(granted).toBe(capacity); // exactly the bucket's capacity, never more
    expect(notGranted).toBe(WORKER_COUNT - capacity);
  });

  it("independent (accountId, applicationKey) pairs get independent budgets even under the same concurrent burst", async () => {
    vi.useFakeTimers();
    const buckets = new Map<string, ReturnType<typeof makeSerializedBucket>>();
    rpc.mockImplementation((_fn: string, args: { p_bucket_key: string }) => {
      if (!buckets.has(args.p_bucket_key)) buckets.set(args.p_bucket_key, makeSerializedBucket(3, 0.01));
      return buckets.get(args.p_bucket_key)!();
    });

    const p = Promise.all([
      Promise.all(Array.from({ length: 5 }, () => acquireCin7Slot("acct-1", "app-A-key", READ))),
      Promise.all(Array.from({ length: 5 }, () => acquireCin7Slot("acct-1", "app-B-key", READ))),
    ]);
    await vi.runAllTimersAsync();
    const [appA, appB] = await p;

    // Same accountId, different applicationKey (different Cin7 Application)
    // -> each burst grants up to its OWN capacity (3), not a shared one.
    expect(appA.filter((o) => o === "granted").length).toBe(3);
    expect(appB.filter((o) => o === "granted").length).toBe(3);
  });
});
