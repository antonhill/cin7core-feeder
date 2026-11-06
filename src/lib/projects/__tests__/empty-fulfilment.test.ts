import { describe, expect, it } from "vitest";
import { buildCreationPlan, verifyCreatedSale, type CreationPlan, type SaleReadBack } from "../cin7-sale-creation";
import { fulfilmentActivity, readBackFulfilments } from "../cin7-fulfilment-readback";

// UAT-027: SO-00028 (a commercial-only variation Sale) as the owner's diagnostic read it back from Cin7: AUTHORISED, no product lines, one
// Additional Charge of R500,000 + R75,000 VAT, no invoices, and ONE fulfilment whose status is FULFILLED but whose Pick, Pack and Ship are each
// AUTHORISED with zero lines, zero quantity, nothing shipped and no shipment date.
const observedFulfilment = () => ({
  FulfillmentNumber: 1, FulFilmentStatus: "FULFILLED", LinkedInvoiceNumber: "",
  Pick: { Status: "AUTHORISED", Lines: [] }, Pack: { Status: "AUTHORISED", Lines: [] }, Ship: { Status: "AUTHORISED", Lines: [] },
});
type Raw = ReturnType<typeof observedFulfilment>;

const plan: CreationPlan = (() => {
  const r = buildCreationPlan({
    projectRef: "PRJ-NQ-Q-0017-V001", role: "VARIATION", customerName: "Spark", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200",
    contractCents: 50_000_000, stages: [{ name: "Variation", valueCents: 50_000_000 }], physicalLines: [], saleOrderDate: "2026-11-01",
  });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
})();

const sale = (rawFulfilments: unknown, over: Partial<SaleReadBack> = {}): SaleReadBack => {
  const fulfilments = readBackFulfilments(rawFulfilments);
  return {
    id: "ab919729-36e5-44c4-ae7b-f7a4797e8b75", type: "Advanced Sale", orderStatus: "AUTHORISED", customer: "Spark", externalId: plan.externalId, taxRule: "Standard Rate Sales",
    lines: [], charges: [{ description: "PRJ-NQ-Q-0017-V001 - Variation", priceCents: 50_000_000, taxCents: 7_500_000 }], invoiceCount: 0,
    fulfilmentCount: fulfilments.length, fulfilments, ...over,
  };
};
const verify = (raw: unknown, over: Partial<SaleReadBack> = {}) => verifyCreatedSale(plan, sale(raw, over));
const withFulfilment = (patch: (f: Raw) => unknown) => { const f = observedFulfilment(); return [patch(f) ?? f]; };

describe("UAT-027: the observed empty fulfilment container", () => {
  it("1. passes: SO-00028 as read back verifies with no differences", () => {
    expect(verify([observedFulfilment()])).toEqual([]);
  });
  it("does not depend on the fulfilment's own status (FULFILLED here; any status with no activity reads the same)", () => {
    for (const status of ["FULFILLED", "NOT FULFILLED", "DRAFT"]) expect(verify(withFulfilment((f) => ({ ...f, FulFilmentStatus: status })))).toEqual([]);
  });
  it("a Sale with no fulfilment at all still passes", () => expect(verify([])).toEqual([]));
  it("tolerates Cin7 omitting an empty Lines list, but only when Pick, Pack and Ship themselves are present", () => {
    expect(verify([{ FulfillmentNumber: 1, LinkedInvoiceNumber: "", Pick: { Status: "AUTHORISED" }, Pack: { Status: "AUTHORISED" }, Ship: { Status: "AUTHORISED" } }])).toEqual([]);
  });
});

describe("UAT-027: real physical activity is still rejected", () => {
  it("2. any picked quantity fails (and the FULFILLED status does not save it)", () => {
    const r = verify(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: [{ SKU: "NQ2886", Quantity: 3 }] } })));
    expect(r.join("|")).toMatch(/fulfilment 1 has picked stock \(1 line\(s\), quantity 3\)/);
  });
  it("3. any packed quantity fails", () => {
    const r = verify(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [{ SKU: "NQ2886", Quantity: 2, Box: "B1" }] } })));
    expect(r.join("|")).toMatch(/fulfilment 1 has packed stock/);
  });
  it("a pick or pack line of quantity zero is still a physical line and fails", () => {
    expect(verify(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: [{ SKU: "X", Quantity: 0 }] } }))).join("|")).toMatch(/picked stock/);
    expect(verify(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [{ SKU: "X", Quantity: 0 }] } }))).join("|")).toMatch(/packed stock/);
  });
  it("4. a shipped unit, a shipment date or any shipment line fails", () => {
    expect(verify(withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", Lines: [{ IsShipped: true }] } }))).join("|")).toMatch(/shipped units/);
    expect(verify(withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", Lines: [{ IsShipped: false, ShipmentDate: "2026-11-01T00:00:00Z" }] } }))).join("|")).toMatch(/shipment date/);
    expect(verify(withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", Lines: [{ IsShipped: false }] } }))).join("|")).toMatch(/1 shipment line/);
  });
  it("a fulfilment linked to an invoice fails", () => {
    expect(verify(withFulfilment((f) => ({ ...f, LinkedInvoiceNumber: "INV-00099" }))).join("|")).toMatch(/linked to invoice INV-00099/);
  });
  it("5. unexpected physical product lines fail", () => {
    const r = verify([observedFulfilment()], { lines: [{ sku: "NQ2886", quantity: 1, priceCents: 0 }] });
    expect(r.join("|")).toMatch(/unplanned order line NQ2886/);
    expect(r.join("|")).toMatch(/1 fulfilment\(s\) already exist/); // the empty-container allowance does not apply to a Sale that holds stock lines
  });
  it("an empty container is NOT accepted when the plan expects physical lines", () => {
    const withLines = buildCreationPlan({
      projectRef: "PRJ-NQ-Q-0001", role: "BASE", customerName: "Spark", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200",
      contractCents: 50_000_000, stages: [{ name: "Deposit", valueCents: 50_000_000 }], physicalLines: [{ sku: "NQ2886", name: "Bracket", quantity: 2 }], saleOrderDate: "2026-11-01",
    });
    if (!withLines.ok) throw new Error(withLines.error);
    const rb: SaleReadBack = { ...sale([observedFulfilment()]), externalId: withLines.plan.externalId, lines: [{ sku: "NQ2886", quantity: 2, priceCents: 0 }],
      charges: withLines.plan.charges.map((c) => ({ description: c.description, priceCents: c.amountCents, taxCents: c.taxCents })) };
    expect(verifyCreatedSale(withLines.plan, rb).join("|")).toMatch(/1 fulfilment\(s\) already exist/);
  });
  it("an empty container is not treated as acceptable for a plan that expects stock, even if the order came back with no lines", () => {
    const withLines = buildCreationPlan({
      projectRef: "PRJ-NQ-Q-0001", role: "BASE", customerName: "Spark", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200",
      contractCents: 50_000_000, stages: [{ name: "Deposit", valueCents: 50_000_000 }], physicalLines: [{ sku: "NQ2886", name: "Bracket", quantity: 2 }], saleOrderDate: "2026-11-01",
    });
    if (!withLines.ok) throw new Error(withLines.error);
    const rb: SaleReadBack = { ...sale([observedFulfilment()]), externalId: withLines.plan.externalId, lines: [],
      charges: withLines.plan.charges.map((c) => ({ description: c.description, priceCents: c.amountCents, taxCents: c.taxCents })) };
    const r = verifyCreatedSale(withLines.plan, rb).join("|");
    expect(r).toMatch(/NQ2886 is missing from the order/);
    expect(r).toMatch(/1 fulfilment\(s\) already exist/);
  });
  it("6. unexpected invoices fail even with an empty container", () => {
    expect(verify([observedFulfilment()], { invoiceCount: 1 }).join("|")).toMatch(/1 invoice\(s\) already exist/);
  });
  it("the Sale checks still apply alongside the container allowance (ExternalID, status, charges)", () => {
    expect(verify([observedFulfilment()], { externalId: "NEWQUIP-PROJECTS-SALE:SOMETHING-ELSE" }).join("|")).toMatch(/ExternalID/);
    expect(verify([observedFulfilment()], { orderStatus: "DRAFT" }).join("|")).toMatch(/not AUTHORISED/);
    expect(verify([observedFulfilment()], { charges: [{ description: "PRJ-NQ-Q-0017-V001 - Variation", priceCents: 40_000_000, taxCents: 6_000_000 }] }).join("|")).toMatch(/contract value/);
  });
});

describe("UAT-027: ambiguous or unreadable fulfilment data fails closed", () => {
  const bad = (raw: unknown) => verify(raw).join("|");
  it("Fulfilments that is not a list", () => expect(bad({ Pick: {} })).toMatch(/cannot be read: Fulfilments is not a list/));
  it("a fulfilment that is not an object", () => expect(bad(["x"])).toMatch(/cannot be read/));
  it("a missing Pick, Pack or Ship", () => {
    for (const k of ["Pick", "Pack", "Ship"] as const) {
      const f: Record<string, unknown> = { ...observedFulfilment() }; delete f[k];
      expect(bad([f])).toMatch(new RegExp(`${k} is missing`));
    }
  });
  it("lines that are not a list, or a line with no readable quantity", () => {
    expect(bad(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: "none" } })))).toMatch(/Pick lines are not a list/);
    expect(bad(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [{ SKU: "X", Quantity: "lots" }] } })))).toMatch(/no readable quantity/);
  });
  it("an unexpected field on Pick, Pack or Ship (stock could be carried somewhere we do not read) is unreadable", () => {
    expect(bad(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: [], PickLines: [{ Quantity: 5 }] } })))).toMatch(/Pick has an unexpected field "PickLines"/);
    expect(bad(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [], Quantity: 5 } })))).toMatch(/Pack has an unexpected field "Quantity"/);
    expect(bad(withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", Lines: [], TrackingNumber: "T1" } })))).toMatch(/Ship has an unexpected field "TrackingNumber"/);
  });
  it("Ship's documented RequireBy is allowed", () => {
    expect(verify(withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", RequireBy: null, Lines: [] } })))).toEqual([]);
  });
  it("an unnumbered fulfilment is labelled as such, not as fulfilment 0", () => {
    expect(bad(withFulfilment((f) => ({ ...f, FulfillmentNumber: undefined, Ship: { Lines: [{}] } })))).toMatch(/fulfilment \(unnumbered\) has 1 shipment line/);
  });
  it("an unreadable linked invoice", () => expect(bad(withFulfilment((f) => ({ ...f, LinkedInvoiceNumber: 12345 })))).toMatch(/linked invoice cannot be read/));
  it("a count with no facts (an older read-back shape) is rejected, never assumed empty", () => {
    const rb: SaleReadBack = { ...sale([]), fulfilmentCount: 1, fulfilments: undefined };
    expect(verifyCreatedSale(plan, rb).join("|")).toMatch(/1 fulfilment\(s\) already exist/);
    expect(verifyCreatedSale(plan, { ...rb, fulfilments: [] }).join("|")).toMatch(/1 fulfilment\(s\) already exist/); // count and facts disagree
  });
  it("reports every problem, not just the first", () => {
    const r = fulfilmentActivity(readBackFulfilments(withFulfilment((f) => ({ ...f, Pick: { Lines: [{ Quantity: 1 }] }, Ship: { Lines: [{ IsShipped: true, ShipmentDate: "2026-11-01" }] } })))[0]);
    expect(r.length).toBeGreaterThanOrEqual(4);
  });
});

// UAT-027 live finding: on the owner's Reconcile the real Ship object also carried ShippingAddress and ShippingNotes (Cin7's documented ship-to
// metadata). They describe where a shipment WOULD go; they are not movement. Movement evidence stays in Ship.Lines (and Pick/Pack lines).
describe("UAT-027 live: Ship carries ShippingAddress and ShippingNotes", () => {
  const address = { DisplayAddressLine1: "Test Farm 1", DisplayAddressLine2: "R512", City: "Brits", State: "NW", Postcode: "0250", Country: "South Africa", Company: "Spark", Contact: "Anton" };
  const shipWith = (extra: Record<string, unknown>, lines: unknown[] = []) => withFulfilment((f) => ({ ...f, Ship: { Status: "AUTHORISED", RequireBy: null, ShippingAddress: address, ShippingNotes: "Leave at gate", Lines: lines, ...extra } }));

  it("an empty container whose Ship has non-empty ShippingAddress and ShippingNotes passes", () => {
    expect(verify(shipWith({}))).toEqual([]);
  });
  it("passes with the fields empty, null or absent too, and with the address as a plain string", () => {
    for (const extra of [{ ShippingAddress: null, ShippingNotes: null }, { ShippingAddress: {}, ShippingNotes: "" }, { ShippingAddress: "1 Farm Rd", ShippingNotes: undefined }]) expect(verify(shipWith(extra))).toEqual([]);
  });
  it("the metadata cannot hide movement: shipment lines, shipped units and shipment dates still fail", () => {
    expect(verify(shipWith({}, [{ IsShipped: true }])).join("|")).toMatch(/shipped units/);
    expect(verify(shipWith({}, [{ IsShipped: false, ShipmentDate: "2026-11-01T08:00:00Z" }])).join("|")).toMatch(/shipment date/);
    expect(verify(shipWith({}, [{ IsShipped: false }])).join("|")).toMatch(/1 shipment line/);
    expect(verify(shipWith({ ShippingNotes: "SHIPPED - tracking TRK-1" }, [{ TrackingNumber: "TRK-1", Carrier: "DHL" }])).join("|")).toMatch(/shipment line/);
  });
  it("the metadata cannot hide picked or packed stock either", () => {
    expect(verify(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: [{ SKU: "NQ2886", Quantity: 2 }] }, Ship: { Status: "AUTHORISED", ShippingAddress: address, ShippingNotes: "x", Lines: [] } }))).join("|")).toMatch(/picked stock/);
    expect(verify(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [{ SKU: "NQ2886", Quantity: 2 }] }, Ship: { Status: "AUTHORISED", ShippingAddress: address, ShippingNotes: "x", Lines: [] } }))).join("|")).toMatch(/packed stock/);
  });
  it("the allowance is for Ship only: the same fields on Pick or Pack are still unexpected", () => {
    expect(verify(withFulfilment((f) => ({ ...f, Pick: { Status: "AUTHORISED", Lines: [], ShippingNotes: "x" } }))).join("|")).toMatch(/Pick has an unexpected field "ShippingNotes"/);
    expect(verify(withFulfilment((f) => ({ ...f, Pack: { Status: "AUTHORISED", Lines: [], ShippingAddress: address } }))).join("|")).toMatch(/Pack has an unexpected field "ShippingAddress"/);
  });
  it("any other unknown Ship field is still unreadable (the allowlist did not become a free-for-all)", () => {
    expect(verify(shipWith({ TrackingNumber: "T1" })).join("|")).toMatch(/Ship has an unexpected field "TrackingNumber"/);
    expect(verify(shipWith({ ShippedQuantity: 3 })).join("|")).toMatch(/Ship has an unexpected field "ShippedQuantity"/);
  });
  it("the Sale checks still apply around it (invoice, plan with stock, ExternalID)", () => {
    expect(verify(shipWith({}), { invoiceCount: 1 }).join("|")).toMatch(/invoice/);
    expect(verify(shipWith({}), { externalId: "NEWQUIP-PROJECTS-SALE:OTHER" }).join("|")).toMatch(/ExternalID/);
    expect(verify(shipWith({}), { lines: [{ sku: "NQ2886", quantity: 1, priceCents: 0 }] }).join("|")).toMatch(/1 fulfilment\(s\) already exist/);
  });
});
