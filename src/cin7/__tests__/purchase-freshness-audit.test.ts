import { describe, expect, it, vi, beforeEach } from "vitest";
import { auditListEntries, auditOnePurchase, compareTotals, emptyCounters, fetchPurchaseListPages, mergeCounters, parseSourceDate, type CachedHeader, type ListEntry } from "@/cin7/purchase-freshness-audit";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});
const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

const cachedHeader = (over: Partial<CachedHeader> = {}): CachedHeader => ({
  cin7_purchase_id: "p1",
  status: "RECEIVING",
  combined_receiving_status: "PARTIALLY RECEIVED",
  updated_at: "2026-08-01T10:00:00Z",
  detail_synced_at: "2026-08-01T10:00:00Z",
  latest_received_date: "2026-07-30",
  ...over,
});
const entry = (over: Partial<ListEntry> = {}): ListEntry => ({ ID: "p1", OrderNumber: "PO-1", Status: "RECEIVING", CombinedReceivingStatus: "PARTIALLY RECEIVED", LastUpdatedDate: "2026-08-01T09:00:00", ...over });
const byId = (...h: CachedHeader[]) => new Map(h.map((x) => [x.cin7_purchase_id, x]));

describe("compareTotals", () => {
  it("reports what differs and ignores float noise", () => {
    const base = { orderLines: 1, orderQty: 10, receiptRows: 1, receiptQty: 0.3 };
    expect(compareTotals(base, { ...base })).toEqual({ differs: false, what: [] });
    expect(compareTotals(base, { ...base, receiptQty: 0.1 + 0.2 })).toEqual({ differs: false, what: [] });
    expect(compareTotals(base, { ...base, receiptRows: 2, receiptQty: 5 })).toEqual({ differs: true, what: ["receipts"] });
    expect(compareTotals(base, { ...base, orderQty: 12 })).toEqual({ differs: true, what: ["orders"] });
  });
});

describe("auditOnePurchase (live GET vs cache)", () => {
  const cached = { orderLines: 1, orderQty: 10, receiptRows: 1, receiptQty: 4 };
  const header = { purchaseId: "p1", orderNumber: "PO-1", source: "purchase", receivingStatus: "PARTIALLY RECEIVED", detailSyncedAt: "2026-08-01T00:00:00Z" };

  it("flags a PO whose receipts changed at the source (and computes the detail age)", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({
      ID: "p1",
      Order: { Lines: [{ SKU: "A", Quantity: 10 }] },
      StockReceived: { Lines: [{ CardID: "c1", SKU: "A", Quantity: 4, Date: "2026-07-30T00:00:00" }, { CardID: "c2", SKU: "A", Quantity: 3, Date: "2026-08-05T00:00:00" }] },
    });
    const row = await auditOnePurchase(creds, header, cached, new Date("2026-08-11T00:00:00Z"));
    expect(row).toMatchObject({ differs: true, what: ["receipts"], detailAgeDays: 10, live: { receiptQty: 7, receiptRows: 2 } });
  });

  it("reports an unchanged PO and counts (never persists) CardID-less lines", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "p1", Order: { Lines: [{ SKU: "A", Quantity: 10 }] }, StockReceived: { Lines: [{ CardID: "c1", SKU: "A", Quantity: 4 }, { SKU: "A", Quantity: 6 }] } });
    const row = await auditOnePurchase(creds, header, cached);
    expect(row).toMatchObject({ differs: false, live: { droppedNoCardIdLines: 1, droppedNoCardIdQty: 6 } });
  });

  it("a FAILED GET is reported as an error, never as 'no change'", async () => {
    vi.mocked(cin7Request).mockRejectedValueOnce(new Cin7ApiError(503, "Rate limited", true));
    const row = await auditOnePurchase(creds, header, cached);
    expect(row.error).toMatch(/Rate limited/);
    expect(row.differs).toBe(false);
  });

  it("is GET-only and uses the cached source as the endpoint hint", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "p1", Order: { Lines: [] }, PutAway: [] });
    await auditOnePurchase(creds, { ...header, source: "advanced-purchase" }, { orderLines: 0, orderQty: 0, receiptRows: 0, receiptQty: 0 });
    const call = vi.mocked(cin7Request).mock.calls[0];
    expect(call[1]).toBe("/advanced-purchase");
    expect((call[2] as { method?: string } | undefined)?.method ?? "GET").toBe("GET");
  });
});

describe("auditListEntries — LastUpdatedDate against ACTUAL receiving dates only", () => {
  it("counts LastUpdatedDate that reaches the latest cached receiving date, and the ones that do not", () => {
    const ok = auditListEntries([entry({ LastUpdatedDate: "2026-07-30T01:00:00" })], byId(cachedHeader()));
    expect(ok).toMatchObject({ withCachedReceipts: 1, lastUpdatedCoversLatestReceipt: 1, lastUpdatedBeforeLatestReceipt: 0 });
    const bad = auditListEntries([entry({ LastUpdatedDate: "2026-07-20T01:00:00" })], byId(cachedHeader()));
    expect(bad).toMatchObject({ lastUpdatedCoversLatestReceipt: 0, lastUpdatedBeforeLatestReceipt: 1 });
    expect(bad.examples[0]).toMatchObject({ kind: "last_updated_before_latest_receipt", cached: "2026-07-30" });
  });

  it("a PO with no cached receipts is not part of the receiving comparison", () => {
    expect(auditListEntries([entry()], byId(cachedHeader({ latest_received_date: null })))).toMatchObject({ withCachedReceipts: 0 });
  });

  it("finds POs changed at the SOURCE after our detail fetch that Toolbox never relisted (12h timezone tolerance)", () => {
    const c = byId(cachedHeader({ detail_synced_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-01T10:00:00Z" }));
    expect(auditListEntries([entry({ LastUpdatedDate: "2026-08-03T10:00:00" })], c).changedAtSourceNotRelisted).toBe(1);
    expect(auditListEntries([entry({ LastUpdatedDate: "2026-08-01T15:00:00" })], c).changedAtSourceNotRelisted).toBe(0); // within tolerance
  });

  it("a PO that Toolbox DID relist is not counted as missed", () => {
    const c = byId(cachedHeader({ detail_synced_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-04T10:00:00Z" }));
    expect(auditListEntries([entry({ LastUpdatedDate: "2026-08-03T10:00:00" })], c).changedAtSourceNotRelisted).toBe(0);
  });

  it("tracks a missing LastUpdatedDate separately", () => {
    expect(auditListEntries([entry({ LastUpdatedDate: null })], byId(cachedHeader())).missingLastUpdated).toBe(1);
  });
});

describe("auditListEntries — voided / missing / drift (investigation of the void filter)", () => {
  it("separates voided-in-source cached as ACTIVE (still visible to consumers) from voided not cached (the intended state)", () => {
    const c = auditListEntries(
      [entry({ ID: "v1", Status: "VOIDED" }), entry({ ID: "v2", Status: "VOIDED" }), entry({ ID: "v3", Status: "VOIDED" })],
      byId(cachedHeader({ cin7_purchase_id: "v1", status: "ORDERED" }), cachedHeader({ cin7_purchase_id: "v2", status: "VOIDED" }))
    );
    expect(c).toMatchObject({ voidedInSource: 3, voidedButCachedAsActive: 1, voidedAndNotCached: 1 });
    expect(c.examples[0]).toMatchObject({ kind: "voided_in_source_cached_as_active", cached: "ORDERED" });
  });

  it("counts active entries missing from the cache and status drift, and ignores entries that are never cached by design", () => {
    const c = auditListEntries(
      [entry({ ID: "new" }), entry({ ID: "p1", Status: "COMPLETED", CombinedReceivingStatus: "FULLY RECEIVED" }), entry({ ID: "nostatus", CombinedReceivingStatus: undefined })],
      byId(cachedHeader())
    );
    expect(c).toMatchObject({ listed: 3, notInCacheActive: 1, statusDrift: 1, receivingStatusDrift: 1 });
  });

  it("mergeCounters adds counters across page windows", () => {
    const a = { ...emptyCounters(), listed: 100, voidedInSource: 2 };
    const b = { ...emptyCounters(), listed: 50, voidedInSource: 1 };
    expect(mergeCounters(a, b)).toMatchObject({ listed: 150, voidedInSource: 3 });
  });
});

describe("parseSourceDate / fetchPurchaseListPages", () => {
  it("parses timezone-less Cin7 dates as UTC and rejects garbage", () => {
    expect(parseSourceDate("2026-07-02T10:00:00")).toBe(Date.parse("2026-07-02T10:00:00Z"));
    expect(parseSourceDate("2026-07-02T10:00:00+02:00")).toBe(Date.parse("2026-07-02T08:00:00Z"));
    expect(parseSourceDate("nope")).toBeNull();
    expect(parseSourceDate(null)).toBeNull();
  });

  it("pages /purchaseList (GET, no UpdatedSince) and stops at a short page; otherwise returns the next page", async () => {
    const page = (n: number) => ({ PurchaseList: Array.from({ length: n }, (_, i) => ({ ID: `p${i}` })) });
    vi.mocked(cin7Request).mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(40));
    const done = await fetchPurchaseListPages(creds, 1, 5);
    expect(done).toMatchObject({ nextPage: null });
    expect(done.entries).toHaveLength(140);
    expect(vi.mocked(cin7Request).mock.calls.map((c) => (c[2] as { query: Record<string, unknown> }).query)).toEqual([{ Page: 1, Limit: 100 }, { Page: 2, Limit: 100 }]);

    vi.mocked(cin7Request).mockReset();
    vi.mocked(cin7Request).mockResolvedValue(page(100));
    const more = await fetchPurchaseListPages(creds, 3, 2);
    expect(more.nextPage).toBe(5);
    for (const call of vi.mocked(cin7Request).mock.calls) {
      expect((call[2] as { method?: string; query: Record<string, unknown> }).method ?? "GET").toBe("GET");
      expect(call[2]).not.toHaveProperty("query.UpdatedSince");
    }
  });
});
