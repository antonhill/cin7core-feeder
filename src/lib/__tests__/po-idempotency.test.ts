import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  poIdempotencyKey,
  claimPoCreation,
  settlePoCreation,
  releasePoCreation,
  markPoCreationAmbiguous,
  findLikelyCreatedPurchaseOrder,
  PO_CLAIM_TTL_SECONDS,
} from "@/lib/po-idempotency";
import { fetchAllPurchasesList } from "@/cin7/purchases";

vi.mock("@/cin7/purchases", () => ({ fetchAllPurchasesList: vi.fn() }));

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

  it("FAILS CLOSED (claimed=false, guard_unavailable) on a guard error — round 3 P1-5", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await claimPoCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "guard_unavailable", cin7PurchaseId: null, orderNumber: null });
  });

  it("FAILS CLOSED when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const res = await claimPoCreation(makeDb(rpc), "org", "inst", "key");
    expect(res).toEqual({ claimed: false, existingStatus: "guard_unavailable", cin7PurchaseId: null, orderNumber: null });
  });
});

describe("settle / release", () => {
  it("settlePoCreation marks the claim completed with the PO identity, and returns true on success", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    const result = await settlePoCreation(db, "org", "inst", "key", "PO-1", "PO-0001");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", cin7_purchase_id: "PO-1", order_number: "PO-0001" })
    );
    expect(result).toBe(true);
  });

  it("security re-audit closure Blocker 5 (Scenario D): settlePoCreation returns false when the write itself fails, instead of throwing or silently succeeding", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: { message: string } }) => void) => r({ error: { message: "connection reset" } }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    const result = await settlePoCreation(db, "org", "inst", "key", "PO-1", "PO-0001");
    expect(result).toBe(false);
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

  it("markPoCreationAmbiguous updates (not deletes) a pending claim to ambiguous — security re-audit P0-2", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const chain = { update, eq, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    update.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    const db = makeDb(vi.fn(), chain);
    await markPoCreationAmbiguous(db, "org", "inst", "key");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "ambiguous" }));
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });
});

describe("findLikelyCreatedPurchaseOrder — security re-audit P0-2 reconciliation", () => {
  const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

  beforeEach(() => vi.mocked(fetchAllPurchasesList).mockReset());

  it("returns the newest matching DRAFT PO for the supplier", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([
      { ID: "po-old", SupplierID: "sup-1", Status: "DRAFT", OrderDate: "2026-08-17T09:00:00Z" },
      { ID: "po-new", SupplierID: "sup-1", Status: "DRAFT", OrderDate: "2026-08-17T09:05:00Z", OrderNumber: "PO-0099" },
      { ID: "po-other-supplier", SupplierID: "sup-2", Status: "DRAFT", OrderDate: "2026-08-17T09:06:00Z" },
    ]);

    const found = await findLikelyCreatedPurchaseOrder(creds, "sup-1", "2026-08-17T08:55:00Z");

    expect(found).toEqual({ cin7PurchaseId: "po-new", orderNumber: "PO-0099" });
    expect(fetchAllPurchasesList).toHaveBeenCalledWith(creds, "2026-08-17T08:55:00Z");
  });

  it("ignores a non-DRAFT PO for the same supplier (already authorized/voided, not our ambiguous create)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([
      { ID: "po-authorized", SupplierID: "sup-1", Status: "AUTHORISED", OrderDate: "2026-08-17T09:05:00Z" },
    ]);
    expect(await findLikelyCreatedPurchaseOrder(creds, "sup-1", "2026-08-17T08:55:00Z")).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([]);
    expect(await findLikelyCreatedPurchaseOrder(creds, "sup-1", "2026-08-17T08:55:00Z")).toBeNull();
  });
});
