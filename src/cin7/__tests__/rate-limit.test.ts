import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createServiceRoleClient = vi.fn(() => ({ rpc }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => createServiceRoleClient() }));

import { acquireCin7Slot, __resetDistributedLimiterForTests } from "@/cin7/rate-limit";

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
  it("returns true and consumes a token when one is granted immediately", async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("cin7_rate_limit_acquire", {
      p_account_id: "acct-1",
      p_capacity: 5,
      p_refill_per_sec: 0.8,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("sleeps the returned wait, then retries until a token is granted", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce({ data: 1250, error: null }).mockResolvedValueOnce({ data: 0, error: null });
    const p = acquireCin7Slot("acct-1");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("falls back (false) on a transient DB error, and stays available for later calls", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection lost" } });
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(false);
    // Not latched off — a later call still tries the RPC and can succeed.
    rpc.mockResolvedValue({ data: 0, error: null });
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(true);
  });

  it("latches off when the function is missing (42883 — migration not applied), skipping the RPC thereafter", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);

    rpc.mockClear();
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("falls back (false) rather than throwing when client creation itself throws", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("missing SUPABASE_SERVICE_ROLE_KEY");
    });
    await expect(acquireCin7Slot("acct-1")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proceeds (true) after exhausting the attempt budget under heavy contention", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: 500, error: null }); // never grants a token
    const p = acquireCin7Slot("acct-1");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(40); // MAX_ACQUIRE_ATTEMPTS
  });

  it("security re-audit P0-3: gives up on the wall-clock deadline, not just the attempt count — a degraded refill rate can't consume the whole invocation one 30s sleep at a time", async () => {
    vi.useFakeTimers();
    // Every attempt reports a full MAX_SLEEP_MS-sized wait (never grants a
    // token) — at 30s/attempt, 40 attempts would be 20 minutes; the 45s
    // total-wait deadline must cut this off after just 2 attempts instead.
    rpc.mockResolvedValue({ data: 30_000, error: null });
    const p = acquireCin7Slot("acct-1");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
