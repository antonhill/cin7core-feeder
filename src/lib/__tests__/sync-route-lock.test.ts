import { describe, it, expect, vi, beforeEach } from "vitest";
import { acquireSyncRouteLock, releaseSyncRouteLock, SYNC_ROUTE_LOCK_TTL_SECONDS } from "@/lib/sync-route-lock";

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("acquireSyncRouteLock", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("passes the route, org, and TTL, and parses a granted, fresh lock", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-08-15T00:00:00Z" }], error: null });
    const res = await acquireSyncRouteLock(makeDb(rpc), "sync-sales", "org-1");
    expect(res).toEqual({ acquired: true, lockedAt: "2026-08-15T00:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("try_acquire_sync_route_lock", {
      p_route: "sync-sales",
      p_org: "org-1",
      p_ttl_seconds: SYNC_ROUTE_LOCK_TTL_SECONDS,
    });
  });

  it("parses a blocked acquire (another run holds a live lock for this org+route)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: false, locked_at: "2026-08-15T00:00:00Z" }], error: null });
    const res = await acquireSyncRouteLock(makeDb(rpc), "sync-sales", "org-1");
    expect(res).toEqual({ acquired: false });
  });

  it("FAILS OPEN (acquired=true) on a guard error — never blocks a sync", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await acquireSyncRouteLock(makeDb(rpc), "sync-sales", "org-1");
    expect(res.acquired).toBe(true);
  });

  it("FAILS OPEN when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect((await acquireSyncRouteLock(makeDb(rpc), "sync-sales", "org-1")).acquired).toBe(true);
  });
});

describe("releaseSyncRouteLock", () => {
  it("deletes only the row matching route, org, and our exact lockedAt", async () => {
    const del = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { delete: del, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    del.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await releaseSyncRouteLock(db, "sync-sales", "org-1", "2026-08-15T00:00:00Z");
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("sync_route", "sync-sales");
    expect(eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(eq).toHaveBeenCalledWith("locked_at", "2026-08-15T00:00:00Z");
  });

  it("is a no-op when lockedAt is empty (the guard failed open — nothing to release)", async () => {
    const del = vi.fn();
    const db = makeDb(vi.fn(), { delete: del });
    await releaseSyncRouteLock(db, "sync-sales", "org-1", "");
    expect(del).not.toHaveBeenCalled();
  });
});
