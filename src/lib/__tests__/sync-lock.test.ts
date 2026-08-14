import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireSyncLock, releaseSyncLock, SYNC_LOCK_TTL_SECONDS } from "@/lib/sync-lock";

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("acquireSyncLock", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

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

  it("FAILS OPEN (acquired=true) on a guard error — never blocks a sync", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await acquireSyncLock(makeDb(rpc), "org", "inst");
    expect(res.acquired).toBe(true);
  });

  it("FAILS OPEN when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect((await acquireSyncLock(makeDb(rpc), "org", "inst")).acquired).toBe(true);
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
