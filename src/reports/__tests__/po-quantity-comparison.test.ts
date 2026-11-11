import { describe, expect, it } from "vitest";
import {
  buildPoQuantityRows,
  computeTrustedTotals,
  qualityGroup,
  classifyLine,
  isDetailPossiblyStale,
  summariseInstanceSync,
  type PurchaseHeader,
} from "@/reports/po-quantity-comparison";
import { buildPoQuantitySheet } from "@/reports/po-quantity-export";

const names = { i1: "Inst One", i2: "Inst Two" };
/** Fixed clock: the default fixtures were detail-synced 2h before this, so the open-PO age rule does not fire unless a test says so. */
const NOW = new Date("2026-06-01T12:00:00Z");

function po(over: Partial<PurchaseHeader> = {}): PurchaseHeader {
  return {
    instance_id: "i1",
    cin7_purchase_id: "p1",
    order_number: "PO-1",
    supplier_name: "Acme",
    status: "AUTHORISED",
    combined_receiving_status: "PARTIALLY RECEIVED",
    order_date: "2026-05-01",
    is_drop_ship: false,
    detail_synced_at: "2026-06-01T10:00:00Z",
    created_at: "2026-05-02T00:00:00Z",
    updated_at: "2026-06-01T09:59:59Z",
    ...over,
  };
}
const ol = (sku: string, q: number, id = "p1", inst = "i1") => ({ instance_id: inst, cin7_purchase_id: id, product_sku: sku, product_name: `N-${sku}`, quantity: q });
const rl = ol;

describe("classifyLine", () => {
  it("covers all four states", () => {
    expect(classifyLine(10, 10)).toBe("fully_received");
    expect(classifyLine(10, 4)).toBe("partially_received");
    expect(classifyLine(10, 0)).toBe("not_received");
    expect(classifyLine(10, 12)).toBe("over_received");
  });
});

describe("buildPoQuantityRows", () => {
  it("sums multiple partial receipts and never multiplies the ordered quantity", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [po()],
      orderLines: [ol("A", 10)],
      receiptLines: [rl("A", 3), rl("A", 3), rl("A", 2)],
      instanceNames: names,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ordered: 10, received: 8, outstanding: 2, lineStatus: "partially_received", orderLineCount: 1 });
  });

  it("merges duplicate-SKU order lines per PO and reports how many were merged", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [po()],
      orderLines: [ol("A", 5), ol("A", 7)],
      receiptLines: [rl("A", 12)],
      instanceNames: names,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ordered: 12, received: 12, outstanding: 0, lineStatus: "fully_received", orderLineCount: 2 });
  });

  it("shows over-receipt as a negative outstanding, not zero", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [po()], orderLines: [ol("A", 10)], receiptLines: [rl("A", 13)], instanceNames: names });
    expect(r.outstanding).toBe(-3);
    expect(r.lineStatus).toBe("over_received");
  });

  it("reports not received when there are order lines and no receipts (detail synced)", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [po({ combined_receiving_status: "NOT RECEIVED" })], orderLines: [ol("A", 4)], receiptLines: [], instanceNames: names });
    expect(r).toMatchObject({ ordered: 4, received: 0, outstanding: 4, lineStatus: "not_received", dataQuality: "ok" });
  });

  it("flags a receipt for a SKU that is not on the PO (blind receipt) as over-received + notOnOrder", () => {
    const rows = buildPoQuantityRows({ now: NOW, purchases: [po()], orderLines: [ol("A", 4)], receiptLines: [rl("B", 2)], instanceNames: names });
    const b = rows.find((r) => r.sku === "B")!;
    expect(b).toMatchObject({ ordered: 0, received: 2, outstanding: -2, lineStatus: "over_received", notOnOrder: true });
  });

  it("treats a PO with unsynced detail as incomplete: null quantities, leftover lines ignored", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [po({ detail_synced_at: null })],
      orderLines: [ol("A", 10)],
      receiptLines: [rl("A", 10)],
      instanceNames: names,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dataQuality: "detail_not_synced", ordered: null, received: null, outstanding: null, lineStatus: null, sku: null });
  });

  it("treats a synced PO with no cached lines as incomplete, not zero", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [po()], orderLines: [], receiptLines: [], instanceNames: names });
    expect(r).toMatchObject({ dataQuality: "no_lines_cached", ordered: null, received: null });
  });

  it("flags a PO re-listed after its detail was fetched as possibly stale but still shows quantities", () => {
    const [r] = buildPoQuantityRows({ now: NOW,
      purchases: [po({ updated_at: "2026-06-02T00:00:00Z" })],
      orderLines: [ol("A", 10)],
      receiptLines: [rl("A", 5)],
      instanceNames: names,
    });
    expect(r).toMatchObject({ dataQuality: "possibly_stale", received: 5 });
  });

  it("does not flag same-run ordering within 1s as stale", () => {
    expect(isDetailPossiblyStale({ detail_synced_at: "2026-06-01T10:00:00Z", updated_at: "2026-06-01T10:00:00.500Z", combined_receiving_status: "FULLY RECEIVED" }, NOW)).toBe(false);
  });

  it("keeps instances and POs separate even when ids and SKUs collide across instances", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [po(), po({ instance_id: "i2" })],
      orderLines: [ol("A", 10, "p1", "i1"), ol("A", 99, "p1", "i2")],
      receiptLines: [rl("A", 1, "p1", "i1"), rl("A", 50, "p1", "i2")],
      instanceNames: names,
    });
    const i1 = rows.find((r) => r.instanceId === "i1")!;
    const i2 = rows.find((r) => r.instanceId === "i2")!;
    expect([i1.ordered, i1.received]).toEqual([10, 1]);
    expect([i2.ordered, i2.received]).toEqual([99, 50]);
  });

  it("groups blank SKUs under an explicit label and avoids float noise", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [po()], orderLines: [ol(" ", 0.3)], receiptLines: [rl("", 0.1), rl("", 0.2)], instanceNames: names });
    expect(r.sku).toBe("(no SKU)");
    expect(r.received).toBe(0.3);
    expect(r.lineStatus).toBe("fully_received");
  });
});

describe("receiving-status mismatch detection and trusted totals", () => {
  it("marks FULLY RECEIVED POs whose cached receipts are below ordered as needs-review", () => {
    const [r] = buildPoQuantityRows({ now: NOW,
      purchases: [po({ combined_receiving_status: "FULLY RECEIVED" })],
      orderLines: [ol("A", 10)],
      receiptLines: [rl("A", 6)],
      instanceNames: names,
    });
    expect(r.dataQuality).toBe("status_mismatch");
    expect(r.dataQualityNote).toMatch(/FULLY RECEIVED/);
    expect(r.dataQualityNote).not.toMatch(/missing|defect/i);
  });

  it("marks FULLY RECEIVED with zero cached receipts, PARTIALLY with none, and NOT RECEIVED with receipts as needs-review", () => {
    const mk = (crs: string, recv: number) =>
      buildPoQuantityRows({ now: NOW, purchases: [po({ combined_receiving_status: crs })], orderLines: [ol("A", 10)], receiptLines: recv ? [rl("A", recv)] : [], instanceNames: names })[0].dataQuality;
    expect(mk("FULLY RECEIVED", 0)).toBe("status_mismatch");
    expect(mk("PARTIALLY RECEIVED", 0)).toBe("status_mismatch");
    expect(mk("NOT RECEIVED", 3)).toBe("status_mismatch");
  });

  it("does not flag consistent POs, drop-ships, or POs already flagged stale", () => {
    const ok = buildPoQuantityRows({ now: NOW, purchases: [po({ combined_receiving_status: "FULLY RECEIVED" })], orderLines: [ol("A", 10)], receiptLines: [rl("A", 10)], instanceNames: names })[0];
    const drop = buildPoQuantityRows({ now: NOW, purchases: [po({ combined_receiving_status: "FULLY RECEIVED", is_drop_ship: true })], orderLines: [ol("A", 10)], receiptLines: [], instanceNames: names })[0];
    const stale = buildPoQuantityRows({ now: NOW, purchases: [po({ combined_receiving_status: "FULLY RECEIVED", updated_at: "2026-07-01T00:00:00Z" })], orderLines: [ol("A", 10)], receiptLines: [rl("A", 1)], instanceNames: names })[0];
    expect([ok.dataQuality, drop.dataQuality, stale.dataQuality]).toEqual(["ok", "ok", "possibly_stale"]);
  });

  it("trusted totals sum Complete rows only and count excluded POs by group", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [
        po({ cin7_purchase_id: "good", combined_receiving_status: "PARTIALLY RECEIVED" }),
        po({ cin7_purchase_id: "sus", combined_receiving_status: "FULLY RECEIVED" }),
        po({ cin7_purchase_id: "stale", updated_at: "2026-07-01T00:00:00Z" }),
        po({ cin7_purchase_id: "inc", detail_synced_at: null }),
      ],
      orderLines: [ol("A", 10, "good"), ol("A", 10, "sus"), ol("A", 10, "stale")],
      receiptLines: [rl("A", 4, "good"), rl("A", 2, "sus"), rl("A", 3, "stale")],
      instanceNames: names,
    });
    expect(computeTrustedTotals(rows)).toEqual({
      trustedPoCount: 1,
      trustedRowCount: 1,
      ordered: 10,
      received: 4,
      outstanding: 6,
      excludedPoCount: { incomplete: 1, stale: 1, review: 1 },
      notApplicablePoCount: 0,
    });
    expect(qualityGroup("no_lines_cached")).toBe("incomplete");
  });
});

describe("no product lines vs genuinely incomplete detail", () => {
  const svc = (over: Partial<PurchaseHeader> = {}) => po({ source: "advanced-purchase", combined_receiving_status: "NOT AVAILABLE", status: "COMPLETED", ...over });

  it("a synced ADVANCED PO with no lines, receiving NOT AVAILABLE and a finished status (Service Purchase with charges) is 'No product lines', not Incomplete", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [svc()], orderLines: [], receiptLines: [], instanceNames: names });
    expect(r.dataQuality).toBe("no_product_lines");
    expect(qualityGroup(r.dataQuality)).toBe("not_applicable");
    expect(r).toMatchObject({ ordered: null, received: null, outstanding: null });
    expect(r.dataQualityNote).toMatch(/Service Purchase/);
  });

  it.each([
    ["a CLASSIC PO", { source: "purchase" }],
    ["a PO with no recorded source", { source: null }],
    ["an unfinished DRAFT advanced PO", { status: "DRAFT" }],
    ["an unfinished ORDERING advanced PO", { status: "ORDERING" }],
    ["an advanced PO with a normal receiving status", { combined_receiving_status: "NOT RECEIVED" }],
  ])("%s with no lines stays Incomplete (no_lines_cached)", (_label, over) => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [svc(over as Partial<PurchaseHeader>)], orderLines: [], receiptLines: [], instanceNames: names });
    expect(r.dataQuality).toBe("no_lines_cached");
  });

  it("an advanced PO that HAS product lines is never 'No product lines'", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [svc()], orderLines: [ol("A", 2)], receiptLines: [], instanceNames: names });
    expect(r.dataQuality).not.toBe("no_product_lines");
    expect(r.sku).toBe("A");
  });

  it("an UNSYNCED PO is Incomplete even when it looks like a service purchase (never assumed)", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [svc({ detail_synced_at: null })], orderLines: [], receiptLines: [], instanceNames: names });
    expect(r.dataQuality).toBe("detail_not_synced");
  });

  it("an unsynced PO shows the recorded sync-failure reason; without one it says no reason was recorded", () => {
    const withFailure = buildPoQuantityRows({ now: NOW,
      purchases: [po({ detail_synced_at: null })],
      orderLines: [],
      receiptLines: [],
      instanceNames: names,
      syncFailures: { "i1|p1": { at: "2026-11-10T10:00:00Z", message: "Duplicate key on purchase_receipt_lines_pkey" } },
    })[0];
    expect(withFailure.dataQualityNote).toContain("2026-11-10");
    expect(withFailure.dataQualityNote).toContain("Duplicate key on purchase_receipt_lines_pkey");
    const without = buildPoQuantityRows({ now: NOW, purchases: [po({ detail_synced_at: null })], orderLines: [], receiptLines: [], instanceNames: names })[0];
    expect(without.dataQualityNote).toMatch(/without a recorded reason/);
  });

  it("no-product-line POs are counted separately and never as incomplete or trusted", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [svc({ cin7_purchase_id: "svc" }), po({ cin7_purchase_id: "inc", detail_synced_at: null })],
      orderLines: [],
      receiptLines: [],
      instanceNames: names,
    });
    expect(computeTrustedTotals(rows)).toMatchObject({ trustedPoCount: 0, notApplicablePoCount: 1, excludedPoCount: { incomplete: 1, stale: 0, review: 0 } });
  });
});

describe("open-PO freshness (not relisted, but not re-verified)", () => {
  const aged = (crs: string, hoursOld: number, over: Partial<PurchaseHeader> = {}) => {
    const synced = new Date(NOW.getTime() - hoursOld * 3600 * 1000).toISOString();
    return po({ combined_receiving_status: crs, detail_synced_at: synced, updated_at: synced, ...over });
  };

  it("an OPEN PO not re-verified for over 72h is Potentially stale even though Cin7 never relisted it", () => {
    for (const crs of ["NOT RECEIVED", "PARTIALLY RECEIVED"]) {
      const [r] = buildPoQuantityRows({ now: NOW, purchases: [aged(crs, 100)], orderLines: [ol("A", 10)], receiptLines: crs === "PARTIALLY RECEIVED" ? [rl("A", 4)] : [], instanceNames: names });
      expect(r.dataQuality).toBe("possibly_stale");
      expect(r.dataQualityNote).toMatch(/not been re-verified/);
    }
  });

  it("an open PO verified within 72h stays Complete, and the boundary is exactly 72h", () => {
    const build = (h: number) => buildPoQuantityRows({ now: NOW, purchases: [aged("NOT RECEIVED", h)], orderLines: [ol("A", 10)], receiptLines: [], instanceNames: names })[0].dataQuality;
    expect(build(71)).toBe("ok");
    expect(build(72)).toBe("ok");
    expect(build(73)).toBe("possibly_stale");
  });

  it("a CLOSED (fully received) PO is never aged into stale — only a relist makes it stale", () => {
    const [r] = buildPoQuantityRows({ now: NOW, purchases: [aged("FULLY RECEIVED", 24 * 90)], orderLines: [ol("A", 10)], receiptLines: [rl("A", 10)], instanceNames: names });
    expect(r.dataQuality).toBe("ok");
    const [relisted] = buildPoQuantityRows({ now: NOW, purchases: [aged("FULLY RECEIVED", 24 * 90, { updated_at: NOW.toISOString() })], orderLines: [ol("A", 10)], receiptLines: [rl("A", 10)], instanceNames: names });
    expect(relisted.dataQuality).toBe("possibly_stale");
    expect(relisted.dataQualityNote).toMatch(/changed in Cin7/);
  });

  it("the Excel export agrees with the screen: an aged-open PO exports as Potentially stale with its note, and the Complete rows sum to the trusted totals", () => {
    const purchases = [aged("NOT RECEIVED", 100, { cin7_purchase_id: "old" }), aged("PARTIALLY RECEIVED", 1, { cin7_purchase_id: "fresh" })];
    const rows = buildPoQuantityRows({ now: NOW, purchases, orderLines: [ol("A", 10, "old"), ol("A", 10, "fresh")], receiptLines: [rl("A", 4, "fresh")], instanceNames: names });
    const { data } = buildPoQuantitySheet(rows);
    const h = data[0];
    const get = (r: (string | number)[], col: string) => r[h.indexOf(col)];
    const body = data.slice(1);
    const oldRow = body.find((r) => get(r, "Qty Ordered") === 10 && get(r, "Data Quality") === "Potentially stale")!;
    expect(String(get(oldRow, "Data Quality Note"))).toMatch(/not been re-verified/);
    const complete = body.filter((r) => get(r, "Data Quality") === "Complete");
    const totals = computeTrustedTotals(rows);
    expect(complete.reduce((n, r) => n + Number(get(r, "Qty Ordered")), 0)).toBe(totals.ordered);
    expect(complete.reduce((n, r) => n + Number(get(r, "Qty Received")), 0)).toBe(totals.received);
  });

  it("aged-open POs are excluded from trusted totals and counted as stale in the instance summary", () => {
    const purchases = [aged("NOT RECEIVED", 100, { cin7_purchase_id: "old" }), aged("NOT RECEIVED", 1, { cin7_purchase_id: "fresh" })];
    const rows = buildPoQuantityRows({ now: NOW, purchases, orderLines: [ol("A", 10, "old"), ol("A", 10, "fresh")], receiptLines: [], instanceNames: names });
    expect(computeTrustedTotals(rows)).toMatchObject({ trustedPoCount: 1, ordered: 10, excludedPoCount: { stale: 1 } });
    expect(summariseInstanceSync({ purchases, listSyncedAt: {}, instanceNames: names, instanceIds: ["i1"], now: NOW })[0].possiblyStale).toBe(1);
  });
});

describe("summariseInstanceSync", () => {
  it("counts pending/stale per instance and derives approximate coverage", () => {
    const s = summariseInstanceSync({
      purchases: [po({ detail_synced_at: null }), po({ cin7_purchase_id: "p2", updated_at: "2026-07-01T00:00:00Z" }), po({ instance_id: "i2" })],
      listSyncedAt: { i1: "2026-07-02T00:00:00Z" },
      instanceNames: names,
      instanceIds: ["i1", "i2"],
    });
    expect(s[0]).toMatchObject({ poCount: 2, detailPending: 1, possiblyStale: 1, lastListSyncedAt: "2026-07-02T00:00:00Z", approxCoverageFrom: "2025-05-02" });
    expect(s[1]).toMatchObject({ poCount: 1, lastListSyncedAt: null });
  });
});

describe("buildPoQuantitySheet (export agrees with displayed rows)", () => {
  it("exports the same quantities, blanks for incomplete POs, and negative outstanding unchanged", () => {
    const rows = buildPoQuantityRows({ now: NOW,
      purchases: [po(), po({ cin7_purchase_id: "p2", detail_synced_at: null })],
      orderLines: [ol("A", 10)],
      receiptLines: [rl("A", 13)],
      instanceNames: names,
    });
    const { data } = buildPoQuantitySheet(rows);
    expect(data).toHaveLength(rows.length + 1);
    const hdr = data[0];
    const ix = (h: string) => hdr.indexOf(h);
    const complete = data.find((d) => d[ix("SKU")] === "A")!;
    expect([complete[ix("Qty Ordered")], complete[ix("Qty Received")], complete[ix("Outstanding")]]).toEqual([10, 13, -3]);
    const incomplete = data.find((d) => String(d[ix("Data Quality")]).startsWith("Incomplete"))!;
    expect([incomplete[ix("Qty Ordered")], incomplete[ix("Qty Received")], incomplete[ix("Outstanding")]]).toEqual(["", "", ""]);
  });
});
