import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  poIdempotencyKey,
  claimPoCreation,
  settlePoCreation,
  releasePoCreation,
  PO_CLAIM_TTL_SECONDS,
} from "@/lib/po-idempotency";

describe("poIdempotencyKey", () => {
  const lines = [
    { productSku: "SKU-B", quantity: 2 },
    { productSku: "SKU-A", quantity: 5 },
  ];

  it("is deterministic for the same inputs", () => {
    expect(poIdempotencyKey("sup-1", "loc-1", lines)).toBe(poIdempotencyKey("sup-1", "loc-1", lines));
  });

  it("is independent of line order (same selection → same key)", () => {
    const reversed = [...lines].reverse();
    expect(poIdempotencyKey("sup-1", "loc-1", lines)).toBe(poIdempotencyKey("sup-1", "loc-1", reversed));
  });

  it("changes with supplier, location, sku, or quantity", () => {
    const base = poIdempotencyKey("sup-1", "loc-1", lines);
    expect(poIdempotencyKey("sup-2", "loc-1", lines)).not.toBe(base);
    expect(poIdempotencyKey("sup-1", "loc-2", lines)).not.toBe(base);
    expect(poIdempotencyKey("sup-1", "loc-1", [{ productSku: "SKU-A", quantity: 5 }])).not.toBe(base);
    expect(
      poIdempotencyKey("sup-1", "loc-1", [
        { productSku: "SKU-B", quantity: 3 }, // qty changed
        { productSku: "SKU-A", quantity: 5 },
      ])
    ).not.toBe(base);
  });
});

function makeDb(rpc: ReturnType<typeof vi.fn>, tableOps?: Record<string, unknown>) {
  return { rpc, from: () => tableOps } as never;
}

describe("claimPoCreation", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("passes the TTL and parses a granted claim", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ claimed: true, existing_status: "pending" }], error: null });
    const res = await claimPoCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: true, existingStatus: "pending", cin7PurchaseId: null, orderNumber: null });
    expect(rpc).toHaveBeenCalledWith("po_creation_claim", {
      p_org: "org",
      p_instance: "inst",
      p_key: "key",
      p_ttl_seconds: PO_CLAIM_TTL_SECONDS,
    });
  });

  it("parses a blocked+completed claim (returns the existing PO)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ claimed: false, existing_status: "completed", cin7_purchase_id: "PO-1", order_number: "PO-0001" }],
      error: null,
    });
    const res = await claimPoCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "completed", cin7PurchaseId: "PO-1", orderNumber: "PO-0001" });
  });

  it("FAILS OPEN (claimed=true) on a guard error — never blocks PO creation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await claimPoCreation(makeDb(rpc), "org", "inst", "key");
    expect(res.claimed).toBe(true);
  });

  it("FAILS OPEN when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect((await claimPoCreation(makeDb(rpc), "org", "inst", "key")).claimed).toBe(true);
  });
});

describe("settle / release", () => {
  it("settlePoCreation marks the claim completed with the PO identity", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await settlePoCreation(db, "org", "inst", "key", "PO-1", "PO-0001");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", cin7_purchase_id: "PO-1", order_number: "PO-0001" })
    );
  });

  it("releasePoCreation deletes only a pending claim", async () => {
    const del = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { delete: del, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    del.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await releasePoCreation(db, "org", "inst", "key");
    expect(del).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });
});
