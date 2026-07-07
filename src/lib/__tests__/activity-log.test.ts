import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logActivity, fetchActivityLog } from "@/lib/activity-log";

function createFakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
  return { db, insert };
}

describe("logActivity", () => {
  it("inserts a row with the actor's userId/email when given a real actor", async () => {
    const { db, insert } = createFakeDb();
    await logActivity(db, {
      orgId: "org1",
      instanceId: "inst1",
      actor: { userId: "u1", email: "anton@sparkconsulting.co.za" },
      action: "audit.apply_fixes",
      summary: "Set Brand on 3 products",
      detail: { productIds: ["p1", "p2", "p3"] },
    });

    expect(insert).toHaveBeenCalledWith({
      org_id: "org1",
      instance_id: "inst1",
      actor_user_id: "u1",
      actor_email: "anton@sparkconsulting.co.za",
      action: "audit.apply_fixes",
      summary: "Set Brand on 3 products",
      detail: { productIds: ["p1", "p2", "p3"] },
    });
  });

  it("records a null actor_user_id and a descriptive actor_email for a 'system' actor", async () => {
    const { db, insert } = createFakeDb();
    await logActivity(db, { orgId: "org1", actor: "system", action: "sync.push", summary: "Pushed 1 product" });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: null, actor_email: "System (scheduled sync)" })
    );
  });

  it("falls back to 'Unknown' when a real actor has no email on file", async () => {
    const { db, insert } = createFakeDb();
    await logActivity(db, { orgId: "org1", actor: { userId: "u1", email: null }, action: "sync.push", summary: "x" });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ actor_email: "Unknown" }));
  });

  it("swallows an insert failure rather than throwing — a logging failure must never break the real operation", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;

    await expect(
      logActivity(db, { orgId: "org1", actor: "system", action: "sync.push", summary: "x" })
    ).resolves.toBeUndefined();
  });
});

describe("fetchActivityLog", () => {
  it("maps snake_case columns to the camelCase ActivityLogEntry shape, newest first", async () => {
    const row = {
      id: "log1",
      instance_id: "inst1",
      actor_email: "anton@sparkconsulting.co.za",
      action: "sync.push",
      summary: "Pushed 1 product",
      detail: { productsCreated: 1 },
      created_at: "2026-07-07T00:00:00.000Z",
    };
    const limit = vi.fn().mockResolvedValue({ data: [row], error: null });
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const db = { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient;

    const result = await fetchActivityLog(db, "org1");

    expect(result).toEqual([
      {
        id: "log1",
        instanceId: "inst1",
        actorEmail: "anton@sparkconsulting.co.za",
        action: "sync.push",
        summary: "Pushed 1 product",
        detail: { productsCreated: 1 },
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ]);
    expect(eq).toHaveBeenCalledWith("org_id", "org1");
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("throws with the underlying error message when the query fails", async () => {
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const db = { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient;

    await expect(fetchActivityLog(db, "org1")).rejects.toThrow("boom");
  });
});
