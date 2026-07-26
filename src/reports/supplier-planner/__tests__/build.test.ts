import { describe, expect, it } from "vitest";
import {
  buildSupplierPlanLines,
  groupLinesBySupplier,
  groupLinesForPurchaseOrders,
  type PendingPurchaseOrderLookup,
  type SupplierPlanDemandData,
  type SupplierPlanLine,
  type SupplierPlanLocationDemand,
  type SupplierPlanProductInput,
} from "@/reports/supplier-planner/build";

function product(overrides: Partial<SupplierPlanProductInput> = {}): SupplierPlanProductInput {
  return {
    productId: "prod-1",
    sku: "SKU1",
    name: "Product One",
    suppliers: [
      {
        supplierId: "sup-1",
        supplierName: "3 Diamonds Transport (Pty) Ltd",
        cost: 600,
        currency: "USD",
        options: [{ locationId: null, locationName: null, reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: 500 }],
      },
    ],
    ...overrides,
  };
}

/** Builds a SupplierPlanDemandData from plain object literals, defaulting any unspecified figure to 0 — keeps each test's demand data terse. */
function demandData(opts: {
  byLocation?: Record<string, Record<string, Partial<SupplierPlanLocationDemand>>>;
  fallbackBySku?: Record<string, Partial<SupplierPlanLocationDemand>>;
  locationIdByName?: Record<string, string>;
} = {}): SupplierPlanDemandData {
  const zero: SupplierPlanLocationDemand = { onHand: 0, onOrder: 0, totalOut: 0 };
  const byLocation = new Map<string, Map<string, SupplierPlanLocationDemand>>();
  for (const [sku, locs] of Object.entries(opts.byLocation ?? {})) {
    byLocation.set(sku, new Map(Object.entries(locs).map(([loc, figures]) => [loc, { ...zero, ...figures }])));
  }
  const fallbackBySku = new Map<string, SupplierPlanLocationDemand>(
    Object.entries(opts.fallbackBySku ?? {}).map(([sku, figures]) => [sku, { ...zero, ...figures }])
  );
  const locationIdByName = new Map(Object.entries(opts.locationIdByName ?? {}));
  return { byLocation, fallbackBySku, locationIdByName };
}

describe("buildSupplierPlanLines", () => {
  it("computes threshold from velocity × (lead + safety) × buffer, and flags needsReorder when on-hand is at or below it", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300 } } });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });

    expect(lines).toHaveLength(1);
    // dailyRate = 300/30 = 10; leadTimeDemand = 10 * (10+20) * 1.0 = 300; MinimumToReorder=500 wins as the floor
    expect(lines[0].threshold).toBe(500);
    expect(lines[0].needsReorder).toBe(true);
    expect(lines[0].locationName).toBeNull(); // no per-location demand supplied — org-wide fallback line
  });

  it("applies buffer % on top of the velocity-based lead-time demand", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 1000, totalOut: 300 } } }); // plenty of stock, so MinimumToReorder floor isn't the binding constraint here
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: 10, safety: 20, minimumToReorder: 0 }] }] })],
      demand,
      { bufferPercent: 20, periodDays: 30 }
    );
    // dailyRate = 10; leadTimeDemand = 10 * 30 * 1.2 = 360
    expect(lines[0].threshold).toBe(360);
  });

  it("uses the supplier's own MinimumToReorder as a floor under the velocity-based number — never overridden by it", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 100, totalOut: 0 } } }); // zero velocity — leadTimeDemand would be 0
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: 5, safety: 5, minimumToReorder: 200 }] }] })],
      demand,
      { bufferPercent: 10, periodDays: 30 }
    );
    expect(lines[0].threshold).toBe(200);
    expect(lines[0].needsReorder).toBe(true);
  });

  it("skips an entry with no Lead configured — nothing to plan a lead time around", () => {
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: null, safety: null, minimumToReorder: null }] }] })],
      demandData(),
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines).toHaveLength(0);
  });

  it("suggestedQty is the greater of the supplier's own ReorderQuantity and the actual shortfall to threshold", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300 } } });
    // threshold=500 (MinimumToReorder floor), onHand=50 -> shortfall=450, ReorderQuantity=500 -> suggestedQty=max(500,450)=500
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].suggestedQty).toBe(500);
  });

  it("falls back to a single org-wide line only when a SKU has zero per-location demand rows at all", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300 } } });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines).toHaveLength(1);
    expect(lines[0].locationName).toBeNull();
  });

  it("emits one line per real location with actual demand, each computed off that location's OWN on-hand/velocity — not an instance-wide aggregate reused under every location", () => {
    // product()'s default option has MinimumToReorder: 500, which acts as a
    // floor under every location's own threshold — Main Warehouse needs
    // more than that floor on hand to read as healthy.
    const demand = demandData({
      byLocation: {
        SKU1: {
          "Main Warehouse": { onHand: 600, totalOut: 30 }, // plenty of stock here
          "Cape Town": { onHand: 5, totalOut: 300 }, // this location is nearly out
        },
      },
    });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });

    expect(lines).toHaveLength(2);
    const mainWarehouse = lines.find((l) => l.locationName === "Main Warehouse")!;
    const capeTown = lines.find((l) => l.locationName === "Cape Town")!;
    expect(mainWarehouse.needsReorder).toBe(false); // 600 on hand comfortably covers this location's own low velocity + the floor
    expect(capeTown.needsReorder).toBe(true); // 5 on hand can't cover this location's own high velocity
    expect(mainWarehouse.onHand).toBe(600);
    expect(capeTown.onHand).toBe(5);
  });

  it("resolves a location's own supplier-option (lead/safety/reorderQuantity) when one exists for that location, falling back to the default option otherwise", () => {
    const demand = demandData({
      byLocation: {
        SKU1: {
          "Main Warehouse": { onHand: 0, totalOut: 0 }, // no option of its own for this location
          "Cape Town": { onHand: 0, totalOut: 0 }, // has its own diverging option below
        },
      },
    });
    const lines = buildSupplierPlanLines(
      [
        product({
          suppliers: [
            {
              supplierId: "sup-1",
              supplierName: "S",
              cost: null,
              currency: null,
              options: [
                { locationId: null, locationName: null, reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: 0 },
                { locationId: "loc-ct", locationName: "Cape Town", reorderQuantity: 200, lead: 3, safety: 2, minimumToReorder: null },
              ],
            },
          ],
        }),
      ],
      demand,
      { bufferPercent: 0, periodDays: 30 }
    );

    const mainWarehouse = lines.find((l) => l.locationName === "Main Warehouse")!;
    const capeTown = lines.find((l) => l.locationName === "Cape Town")!;
    expect(mainWarehouse.lead).toBe(10); // fell back to the default option
    expect(capeTown.lead).toBe(3); // used its own option
    expect(capeTown.safety).toBe(2);
  });

  it("always sources the MinimumToReorder floor from the default option, even for a location using its own diverging option — Cin7 only lets that field be configured centrally", () => {
    const demand = demandData({ byLocation: { SKU1: { "Cape Town": { onHand: 50, totalOut: 0 } } } });
    const lines = buildSupplierPlanLines(
      [
        product({
          suppliers: [
            {
              supplierId: "sup-1",
              supplierName: "S",
              cost: null,
              currency: null,
              options: [
                { locationId: null, locationName: null, reorderQuantity: 0, lead: 10, safety: 0, minimumToReorder: 400 },
                // Cape Town's own option, like every real Cin7 per-location entry, has minimumToReorder: null
                { locationId: "loc-ct", locationName: "Cape Town", reorderQuantity: 0, lead: 3, safety: 0, minimumToReorder: null },
              ],
            },
          ],
        }),
      ],
      demand,
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines[0].threshold).toBe(400); // the default's floor still applies, not 0
  });

  it("attaches the real Cin7 LocationID from locationIdByName, not whatever locationId the supplier option itself happened to carry", () => {
    const demand = demandData({
      byLocation: { SKU1: { "Cape Town": { onHand: 0, totalOut: 0 } } },
      locationIdByName: { "Cape Town": "real-cin7-location-id" },
    });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].locationId).toBe("real-cin7-location-id");
  });

  it("defaults moverCategory/status when no extra data is supplied for a SKU, and takes onOrder from the demand data itself", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300, onOrder: 15 } } });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].onOrder).toBe(15);
    expect(lines[0].moverCategory).toBe("No movement");
    expect(lines[0].status).toBe("Healthy");
  });

  it("passes through moverCategory/status from the same per-SKU data the Reorder Report already computes", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300 } } });
    const extraBySku = new Map([["SKU1", { moverCategory: "Fast" as const, status: "Stockout risk" as const }]]);
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 }, extraBySku);
    expect(lines[0].moverCategory).toBe("Fast");
    expect(lines[0].status).toBe("Stockout risk");
  });

  it("flags an all-zero Lead/Safety/ReorderQuantity/MinimumToReorder entry as unconfigured — Cin7's placeholder shape for a link that's never had Product Supplier Options set up, confirmed live 2026-07-24", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 0, totalOut: 100 } } });
    const lines = buildSupplierPlanLines(
      [
        product({
          suppliers: [
            {
              supplierId: "sup-1",
              supplierName: "S",
              cost: null,
              currency: null,
              options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: 0, safety: 0, minimumToReorder: null }],
            },
          ],
        }),
      ],
      demand,
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines[0].isUnconfigured).toBe(true);
  });

  it("does not flag a deliberately zero-lead entry as unconfigured when it has a real ReorderQuantity or MinimumToReorder", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 0, totalOut: 100 } } });
    const lines = buildSupplierPlanLines(
      [
        product({
          suppliers: [
            {
              supplierId: "sup-1",
              supplierName: "S",
              cost: null,
              currency: null,
              options: [{ locationId: null, locationName: null, reorderQuantity: 250, lead: 0, safety: 0, minimumToReorder: null }],
            },
          ],
        }),
      ],
      demand,
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines[0].isUnconfigured).toBe(false);
  });

  it("does not flag the default product() fixture (real Lead/Safety/MinimumToReorder) as unconfigured", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 50, totalOut: 300 } } });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].isUnconfigured).toBe(false);
  });

  it("groups lines by supplier name", () => {
    const products: SupplierPlanProductInput[] = [
      product({ sku: "SKU1" }),
      product({
        sku: "SKU2",
        suppliers: [{ supplierId: "sup-2", supplierName: "ABC Suppliers", cost: 500, currency: "ZAR", options: [{ locationId: null, locationName: null, reorderQuantity: 100, lead: 5, safety: 5, minimumToReorder: 100 }] }],
      }),
    ];
    const lines = buildSupplierPlanLines(products, demandData(), { bufferPercent: 0, periodDays: 30 });
    const grouped = groupLinesBySupplier(lines);
    expect([...grouped.keys()]).toEqual(["3 Diamonds Transport (Pty) Ltd", "ABC Suppliers"]);
    expect(grouped.get("3 Diamonds Transport (Pty) Ltd")).toHaveLength(1);
  });

  it("attaches a pending PO when this exact (sku, supplier, location) has one outstanding — the precise byFullKey match", () => {
    const demand = demandData({
      byLocation: { SKU1: { "Cape Town": { onHand: 0, totalOut: 0 } } },
      locationIdByName: { "Cape Town": "loc-ct" },
    });
    const pending: PendingPurchaseOrderLookup = {
      byFullKey: new Map([["SKU1::sup-1::loc-ct", { orderNumber: "PO-00312", createdAt: "2026-07-26T10:00:00Z" }]]),
      bySkuSupplier: new Map(),
    };
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 }, new Map(), pending);
    expect(lines[0].pendingPurchaseOrder).toEqual({ orderNumber: "PO-00312", createdAt: "2026-07-26T10:00:00Z" });
  });

  it("falls back to a (sku, supplier) match when the line has no location of its own — the org-wide fallback-line case", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 0, totalOut: 0 } } });
    const pending: PendingPurchaseOrderLookup = {
      byFullKey: new Map(),
      bySkuSupplier: new Map([["SKU1::sup-1", { orderNumber: "PO-00313", createdAt: "2026-07-26T10:00:00Z" }]]),
    };
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 }, new Map(), pending);
    expect(lines[0].locationName).toBeNull();
    expect(lines[0].pendingPurchaseOrder).toEqual({ orderNumber: "PO-00313", createdAt: "2026-07-26T10:00:00Z" });
  });

  it("is null when no pending PO matches this line at all", () => {
    const demand = demandData({ fallbackBySku: { SKU1: { onHand: 0, totalOut: 0 } } });
    const lines = buildSupplierPlanLines([product()], demand, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].pendingPurchaseOrder).toBeNull();
  });
});

function line(overrides: Partial<SupplierPlanLine> = {}): SupplierPlanLine {
  return {
    productId: "prod-1",
    productSku: "SKU1",
    productName: "Product One",
    supplierId: "sup-1",
    supplierName: "3 Diamonds Transport (Pty) Ltd",
    currency: "USD",
    cost: 600,
    locationId: "loc-1",
    locationName: "Main Warehouse",
    lead: 10,
    safety: 20,
    onHand: 50,
    onOrder: 0,
    totalOut: 300,
    threshold: 500,
    suggestedQty: 450,
    needsReorder: true,
    moverCategory: "Fast",
    status: "Stockout risk",
    isUnconfigured: false,
    pendingPurchaseOrder: null,
    ...overrides,
  };
}

describe("groupLinesForPurchaseOrders", () => {
  it("groups lines by (supplier, location), not just supplier — a PO has exactly one receiving Location", () => {
    const lines = [
      line({ productSku: "SKU1", locationId: "loc-1", locationName: "Main Warehouse" }),
      line({ productSku: "SKU2", locationId: "loc-1", locationName: "Main Warehouse" }),
      line({ productSku: "SKU3", locationId: "loc-2", locationName: "Cape Town" }),
    ];
    const groups = groupLinesForPurchaseOrders(lines);
    expect(groups).toHaveLength(2);
    const mainWarehouse = groups.find((g) => g.locationName === "Main Warehouse");
    const capeTown = groups.find((g) => g.locationName === "Cape Town");
    expect(mainWarehouse?.lines).toHaveLength(2);
    expect(capeTown?.lines).toHaveLength(1);
  });

  it("keeps different suppliers at the same location in separate groups", () => {
    const lines = [
      line({ supplierId: "sup-1", supplierName: "Supplier A", locationId: "loc-1", locationName: "Main Warehouse" }),
      line({ supplierId: "sup-2", supplierName: "Supplier B", locationId: "loc-1", locationName: "Main Warehouse" }),
    ];
    const groups = groupLinesForPurchaseOrders(lines);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.supplierName).sort()).toEqual(["Supplier A", "Supplier B"]);
  });

  it("skips a line with no resolved location and no fallback — nothing for Cin7 to receive it into", () => {
    const lines = [line({ locationId: null, locationName: null })];
    expect(groupLinesForPurchaseOrders(lines)).toHaveLength(0);
  });

  it("falls back to the caller-supplied receiving location when a line has none of its own", () => {
    const lines = [line({ locationId: null, locationName: null })];
    const groups = groupLinesForPurchaseOrders(lines, { locationId: "loc-fallback", locationName: "Main Warehouse" });
    expect(groups).toHaveLength(1);
    expect(groups[0].locationId).toBe("loc-fallback");
    expect(groups[0].locationName).toBe("Main Warehouse");
  });

  it("prefers a line's own location over the fallback when it has one", () => {
    const lines = [line({ locationId: "loc-specific", locationName: "Cape Town" })];
    const groups = groupLinesForPurchaseOrders(lines, { locationId: "loc-fallback", locationName: "Main Warehouse" });
    expect(groups).toHaveLength(1);
    expect(groups[0].locationName).toBe("Cape Town");
  });
});
