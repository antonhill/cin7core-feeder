import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  stockTransferIdempotencyKey,
  claimStockTransferCreation,
  settleStockTransferCreation,
  releaseStockTransferCreation,
  markStockTransferCreationAmbiguous,
  findLikelyCreatedStockTransfer,
  STOCK_TRANSFER_CLAIM_TTL_SECONDS,
} from "@/lib/stock-transfer-idempotency";
import { fetchAllStockTransfersList } from "@/cin7/stock-transfers";

vi.mock("@/cin7/stock-transfers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/stock-transfers")>();
  return { ...actual, fetchAllStockTransfersList: vi.fn() };
});

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

  it("FAILS CLOSED (claimed=false, guard_unavailable) on a guard error — round 3 P1-5", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "guard_unavailable", cin7TransferId: null, transferNumber: null });
  });

  it("FAILS CLOSED when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const res = await claimStockTransferCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "guard_unavailable", cin7TransferId: null, transferNumber: null });
  });
});

describe("settle / release", () => {
  it("settleStockTransferCreation marks the claim completed with the transfer identity, and returns true on success", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    const result = await settleStockTransferCreation(db, "org", "inst", "key", "ST-1", "ST-0001");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", cin7_transfer_id: "ST-1", transfer_number: "ST-0001" })
    );
    expect(result).toBe(true);
  });

  it("security re-audit closure Blocker 5 (Scenario D): settleStockTransferCreation returns false when the write itself fails, instead of throwing or silently succeeding", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: { message: string } }) => void) => r({ error: { message: "connection reset" } }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    const result = await settleStockTransferCreation(db, "org", "inst", "key", "ST-1", "ST-0001");
    expect(result).toBe(false);
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

  it("markStockTransferCreationAmbiguous updates (not deletes) a pending claim to ambiguous — security re-audit P0-2", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await markStockTransferCreationAmbiguous(db, "org", "inst", "key");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "ambiguous" }));
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });
});

describe("findLikelyCreatedStockTransfer — security re-audit P0-2 reconciliation", () => {
  const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

  beforeEach(() => vi.mocked(fetchAllStockTransfersList).mockReset());

  it("returns the newest matching DRAFT transfer on the exact from/to pair, modified since the attempt started", async () => {
    vi.mocked(fetchAllStockTransfersList).mockResolvedValue([
      { TaskID: "st-old", FromLocation: "A", ToLocation: "B", Status: "DRAFT", LastModifiedOn: "2026-08-17T09:00:00Z" },
      { TaskID: "st-new", FromLocation: "A", ToLocation: "B", Status: "DRAFT", LastModifiedOn: "2026-08-17T09:05:00Z", Number: "ST-0099" },
      { TaskID: "st-other-route", FromLocation: "A", ToLocation: "C", Status: "DRAFT", LastModifiedOn: "2026-08-17T09:06:00Z" },
    ]);

    const found = await findLikelyCreatedStockTransfer(creds, "A", "B", "2026-08-17T08:55:00Z");

    expect(found).toEqual({ cin7TransferId: "st-new", transferNumber: "ST-0099" });
  });

  it("ignores a match modified before the ambiguous attempt started (a pre-existing, unrelated transfer)", async () => {
    vi.mocked(fetchAllStockTransfersList).mockResolvedValue([
      { TaskID: "st-stale", FromLocation: "A", ToLocation: "B", Status: "DRAFT", LastModifiedOn: "2026-08-17T08:00:00Z" },
    ]);
    expect(await findLikelyCreatedStockTransfer(creds, "A", "B", "2026-08-17T08:55:00Z")).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    vi.mocked(fetchAllStockTransfersList).mockResolvedValue([]);
    expect(await findLikelyCreatedStockTransfer(creds, "A", "B", "2026-08-17T08:55:00Z")).toBeNull();
  });
});
