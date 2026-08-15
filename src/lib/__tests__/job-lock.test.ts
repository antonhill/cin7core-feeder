import { describe, it, expect, vi, beforeEach } from "vitest";
import { claimJobLock, releaseJobLock, JOB_LOCK_TTL_SECONDS } from "@/lib/job-lock";

function makeDb(chain: Record<string, unknown>) {
  return { from: () => chain } as never;
}

describe("claimJobLock", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("issues an UPDATE ... WHERE locked_at is null OR expired, and claims when a row comes back", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const or = vi.fn().mockReturnThis();
    const select = vi.fn().mockResolvedValue({ data: [{ id: "job-1" }], error: null });
    const chain = { update, eq, or, select };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    or.mockReturnValue(chain);

    const res = await claimJobLock(makeDb(chain), "push_jobs", "job-1");

    expect(res.claimed).toBe(true);
    expect(eq).toHaveBeenCalledWith("id", "job-1");
    expect(or).toHaveBeenCalledWith(expect.stringContaining("locked_at.is.null,locked_at.lt."));
    if (res.claimed) expect(res.lockedAt).toBeTruthy();
  });

  it("is not claimed when the UPDATE affects no rows (a live claim already held by another chunk)", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const or = vi.fn().mockReturnThis();
    const select = vi.fn().mockResolvedValue({ data: [], error: null });
    const chain = { update, eq, or, select };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    or.mockReturnValue(chain);

    const res = await claimJobLock(makeDb(chain), "push_jobs", "job-1");
    expect(res.claimed).toBe(false);
  });

  it("FAILS OPEN (claimed=true) on a guard error — never blocks a chunk", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const or = vi.fn().mockReturnThis();
    const select = vi.fn().mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    const chain = { update, eq, or, select };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    or.mockReturnValue(chain);

    const res = await claimJobLock(makeDb(chain), "pull_jobs", "job-2");
    expect(res.claimed).toBe(true);
  });
});

describe("releaseJobLock", () => {
  it("clears locked_at only for the row matching id AND our exact lockedAt", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);

    await releaseJobLock(makeDb(chain), "push_jobs", "job-1", "2026-08-15T00:00:00Z");

    expect(update).toHaveBeenCalledWith({ locked_at: null });
    expect(eq).toHaveBeenCalledWith("id", "job-1");
    expect(eq).toHaveBeenCalledWith("locked_at", "2026-08-15T00:00:00Z");
  });
});

it("TTL is 6 minutes, comfortably past the 300s Vercel hard function timeout", () => {
  expect(JOB_LOCK_TTL_SECONDS).toBe(360);
});
