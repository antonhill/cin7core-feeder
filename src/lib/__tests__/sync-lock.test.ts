import { describe, it, expect, vi } from "vitest";
import { acquireSyncLock, releaseSyncLock, SYNC_LOCK_TTL_SECONDS } from "@/lib/sync-lock";

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("acquireSyncLock", () => {
  it("passes the TTL and parses a granted, fresh lock", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-08-14T00:00:00Z" }], error: null });
    const res = await acquireSyncLock(makeDb(rpc), "org", "inst");
    expect(res).toEqual({ acquired: true, lockedAt: "2026-08-14T00:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("try_acquire_sync_lock", {
      p_org: "org",
      p_instance: "inst",
      p_ttl_seconds: SYNC_LOCK_TTL_SECONDS,
    });
  });

  it("parses a blocked acquire (another run holds a live lock)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: false, locked_at: "2026-08-14T00:00:00Z" }], error: null });
    const res = await acquireSyncLock(makeDb(rpc), "org", "inst");
    expect(res).toEqual({ acquired: false });
  });

  it("FAILS CLOSED (throws) on a guard error — round 3 P1-5", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    await expect(acquireSyncLock(makeDb(rpc), "org", "inst")).rejects.toThrow(/guard unavailable/);
  });

  it("FAILS CLOSED (throws) when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(acquireSyncLock(makeDb(rpc), "org", "inst")).rejects.toThrow(/guard unavailable/);
  });
});

describe("releaseSyncLock", () => {
  it("deletes only the row matching our exact lockedAt", async () => {
    const del = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { delete: del, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    del.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await releaseSyncLock(db, "org", "inst", "2026-08-14T00:00:00Z");
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("locked_at", "2026-08-14T00:00:00Z");
  });

  it("is a no-op when lockedAt is empty (the guard failed open — nothing to release)", async () => {
    const del = vi.fn();
    const db = makeDb(vi.fn(), { delete: del });
    await releaseSyncLock(db, "org", "inst", "");
    expect(del).not.toHaveBeenCalled();
  });
});
