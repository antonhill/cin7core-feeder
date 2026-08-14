import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stockTransferIdempotencyKey,
  claimStockTransferCreation,
  settleStockTransferCreation,
  releaseStockTransferCreation,
  STOCK_TRANSFER_CLAIM_TTL_SECONDS,
} from "@/lib/stock-transfer-idempotency";

describe("stockTransferIdempotencyKey", () => {
  const lines = [
    { productSku: "SKU-B", transferQuantity: 2 },
    { productSku: "SKU-A", transferQuantity: 5 },
  ];

  it("is deterministic for the same inputs", () => {
    expect(stockTransferIdempotencyKey("loc-from", "loc-to", lines)).toBe(stockTransferIdempotencyKey("loc-from", "loc-to", lines));
  });

  it("is independent of line order (same selection → same key)", () => {
    const reversed = [...lines].reverse();
    expect(stockTransferIdempotencyKey("loc-from", "loc-to", lines)).toBe(stockTransferIdempotencyKey("loc-from", "loc-to", reversed));
  });

  it("changes with from location, to location, sku, or quantity", () => {
    const base = stockTransferIdempotencyKey("loc-from", "loc-to", lines);
    expect(stockTransferIdempotencyKey("loc-other", "loc-to", lines)).not.toBe(base);
    expect(stockTransferIdempotencyKey("loc-from", "loc-other", lines)).not.toBe(base);
    expect(stockTransferIdempotencyKey("loc-from", "loc-to", [{ productSku: "SKU-A", transferQuantity: 5 }])).not.toBe(base);
    expect(
      stockTransferIdempotencyKey("loc-from", "loc-to", [
        { productSku: "SKU-B", transferQuantity: 3 }, // qty changed
        { productSku: "SKU-A", transferQuantity: 5 },
      ])
    ).not.toBe(base);
  });
});

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("claimStockTransferCreation", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("passes the TTL and parses a granted claim", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: true, existing_status: "pending" }], error: null });
    const res = await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: true, existingStatus: "pending", cin7TransferId: null, transferNumber: null });
    expect(rpc).toHaveBeenCalledWith("stock_transfer_creation_claim", {
      p_org: "org",
      p_instance: "inst",
      p_key: "key",
      p_ttl_seconds: STOCK_TRANSFER_CLAIM_TTL_SECONDS,
    });
  });

  it("parses a blocked+completed claim (returns the existing transfer)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ claimed: false, existing_status: "completed", cin7_transfer_id: "ST-1", transfer_number: "ST-0001" }],
      error: null,
    });
    const res = await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "completed", cin7TransferId: "ST-1", transferNumber: "ST-0001" });
  });

  it("FAILS OPEN (claimed=true) on a guard error — never blocks transfer creation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res.claimed).toBe(true);
  });

  it("FAILS OPEN when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect((await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key")).claimed).toBe(true);
  });
});

describe("settle / release", () => {
  it("settleStockTransferCreation marks the claim completed with the transfer identity", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await settleStockTransferCreation(db, "org", "inst", "key", "ST-1", "ST-0001");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", cin7_transfer_id: "ST-1", transfer_number: "ST-0001" })
    );
  });

  it("releaseStockTransferCreation deletes only a pending claim", async () => {
    const del = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { delete: del, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    del.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await releaseStockTransferCreation(db, "org", "inst", "key");
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });
});
