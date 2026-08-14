import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  transferIdempotencyKey,
  claimTransferCreation,
  settleTransferCreation,
  releaseTransferCreation,
  TRANSFER_CLAIM_TTL_SECONDS,
} from "@/lib/transfer-idempotency";

describe("transferIdempotencyKey", () => {
  const lines = [
    { productSku: "SKU-B", quantity: 2 },
    { productSku: "SKU-A", quantity: 5 },
  ];

  it("is deterministic and independent of line order", () => {
    expect(transferIdempotencyKey("loc-from", "loc-to", lines)).toBe(transferIdempotencyKey("loc-from", "loc-to", [...lines].reverse()));
  });

  it("changes with from, to, sku, or quantity", () => {
    const base = transferIdempotencyKey("loc-from", "loc-to", lines);
    expect(transferIdempotencyKey("loc-X", "loc-to", lines)).not.toBe(base);
    expect(transferIdempotencyKey("loc-from", "loc-Y", lines)).not.toBe(base);
    expect(transferIdempotencyKey("loc-from", "loc-to", [{ productSku: "SKU-A", quantity: 5 }])).not.toBe(base);
    expect(
      transferIdempotencyKey("loc-from", "loc-to", [
        { productSku: "SKU-B", quantity: 9 },
        { productSku: "SKU-A", quantity: 5 },
      ])
    ).not.toBe(base);
  });
});

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("claimTransferCreation", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("passes the TTL and parses a granted claim", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: true, existing_status: "pending" }], error: null });
    const res = await claimTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: true, existingStatus: "pending", cin7TaskId: null, transferNumber: null });
    expect(rpc).toHaveBeenCalledWith("transfer_creation_claim", {
      p_org: "org",
      p_instance: "inst",
      p_key: "key",
      p_ttl_seconds: TRANSFER_CLAIM_TTL_SECONDS,
    });
  });

  it("parses a blocked+completed claim (returns the existing transfer)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ claimed: false, existing_status: "completed", cin7_task_id: "T-1", transfer_number: "TR-0001" }],
      error: null,
    });
    const res = await claimTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "completed", cin7TaskId: "T-1", transferNumber: "TR-0001" });
  });

  it("FAILS OPEN on a guard error and on an empty result", async () => {
    const err = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await claimTransferCreation(makeDb(err), "org", "inst", "key")).claimed).toBe(true);
    const empty = vi.fn().mockResolvedValue({ data: [], error: null });
    expect((await claimTransferCreation(makeDb(empty), "org", "inst", "key")).claimed).toBe(true);
  });
});

describe("settle / release", () => {
  it("settleTransferCreation marks the claim completed with the transfer identity", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    await settleTransferCreation(makeDb(vi.fn(), chain), "org", "inst", "key", "T-1", "TR-0001");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", cin7_task_id: "T-1", transfer_number: "TR-0001" }));
  });

  it("releaseTransferCreation deletes only a pending claim", async () => {
    const del = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { delete: del, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    del.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    await releaseTransferCreation(makeDb(vi.fn(), chain), "org", "inst", "key");
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });
});
