import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({ rpc }) }));

import { acquireCin7Slot, __resetDistributedLimiterForTests } from "@/cin7/rate-limit";

beforeEach(() => {
  vi.clearAllMocks();
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

  it("proceeds (true) after exhausting the attempt budget under heavy contention", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue({ data: 500, error: null }); // never grants a token
    const p = acquireCin7Slot("acct-1");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(40); // MAX_ACQUIRE_ATTEMPTS
  });
});
