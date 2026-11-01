// POC SCENARIO FIXTURES (demo proof). Scenarios 1, 4, 5 and 6 of docs/newquip-poc-demo-proof.md, driven end to end through the REAL claim engine, posting store,
// reconciliation, physical-status and Sale-creation verification, with Cin7 modelled by in-memory fakes. This is LOCAL evidence of what the Toolbox does with the
// Cin7 responses it is given. It is NOT proof of Cin7's own behaviour (picking after invoicing, populate vs Additional Charges, ...): those stay BLOCKED until the
// owner-authorised disposable-Sale steps run. Nothing here can reach the network.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, submitClaimForApproval } from "../project-store";
import { linkCin7Sale, postClaimToCin7, reconcileClaimPosting, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT, type ReadInvoice } from "../cin7-posting";
import { buildPhysicalStatus } from "../physical-status";
import { createSaleForProject, type SaleCreationPort } from "../cin7-sale-creation-store";
import { CREATE_CONFIRMATION_TEXT, type SaleReadBack } from "../cin7-sale-creation";
import { readBackFulfilments } from "../cin7-fulfilment-readback";
import { approveVariation, raiseVariation } from "../variation-store";
import { createVariationBillingProject, loadConsolidatedProject } from "../variation-billing-store";

const ORG = "org-a";
const SALE_ID = "4fe3d99c-241d-4404-8795-4c448842108b";
const R = (n: number) => n * 100;
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

class Port implements Cin7Port {
  sale: Cin7SaleView = { id: SALE_ID, saleNumber: "SO-1", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [], orderLines: [{ productId: "p1", sku: "A", name: "A", quantity: 10 }], shipped: { A: 0 } };
  created: InvoiceRequest[] = [];
  async fetchSale() { return structuredClone(this.sale); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.created.push(req);
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
    const n = this.sale.invoices.length + 1;
    const invoiceNumber = `INV-${100 + n}`; const taskId = `t${n}`;
    const inv: ReadInvoice = { invoiceNumber, taskId, memo: req.memo, status: "DRAFT", subtotalCents: Math.round(sub * 100), taxCents: Math.round(tax * 100), totalCents: Math.round((sub + tax) * 100), lines: (req.lines ?? []).map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })) } as ReadInvoice;
    this.sale.invoices.push(inv);
    return { kind: "created", invoiceNumber, taskId, status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
}

let db: FakeDb; let projectId: string; let port: Port;
const stageOf = async (prefix: string) => (await loadProjectView(db as never, ORG, projectId))!.stages.find((s) => s.name.startsWith(prefix))!;
const progress = async (prefix: string, pct: string) => recordProgress(db as never, ORG, "x@x", { projectId, stageId: (await stageOf(prefix)).id, reportedPct: pct, approvedPct: pct, comment: "c" });
async function claimAndApprove(): Promise<string> {
  const { claimId } = await createClaimDraft(db as never, ORG, "x@x", projectId);
  await submitClaimForApproval(db as never, ORG, projectId, claimId);
  await approveClaim(db as never, ORG, "mgr@x", projectId, claimId);
  return claimId;
}
const post = (claimId: string, physicalLines?: Array<{ sku: string; quantity: number }>) => postClaimToCin7(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, claimId, confirmation: POST_CONFIRMATION_TEXT, physicalLines });
const reconcile = (claimId: string) => reconcileClaimPosting(db as never, port, { isManager: true }, { orgId: ORG, projectId, claimId });

beforeEach(async () => {
  db = new FakeDb(); port = new Port();
  projectId = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  await linkCin7Sale(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, instanceId: "i", saleId: SALE_ID, revenueAccount: "200" });
});

describe("Scenario 1: deposit before fulfilment", () => {
  it("posts a charge-only invoice (no product lines), preserves the Additional Charge exactly, and leaves the Sale's products and stock untouched", async () => {
    await progress("Deposit", "100");
    const orderBefore = structuredClone(port.sale.orderLines); const shippedBefore = structuredClone(port.sale.shipped);
    const deposit = await stageOf("Deposit");
    const claimId = await claimAndApprove();
    const r = await post(claimId); // no physical lines: a deposit claim is not a fulfilment event
    expect(r.state).toBe("CREATED");
    expect(port.created).toHaveLength(1);
    expect(port.created[0].lines ?? []).toEqual([]); // R0 physical lines are never added to a deposit invoice
    expect(port.created[0].charges.reduce((n, c) => n + Math.round(c.priceExVat * 100), 0)).toBe(deposit.valueCents);
    expect(port.created[0].charges.reduce((n, c) => n + Math.round(c.taxAmount * 100), 0)).toBe(Math.round(deposit.valueCents * 0.15)); // VAT is an amount, not a rate (INV-00021)
    expect(port.sale.orderLines).toEqual(orderBefore); // the products stay available for later fulfilment
    expect(port.sale.shipped).toEqual(shippedBefore);
    expect((await reconcile(claimId)).state).toBe("RECONCILED");
  });
});

describe("Scenario 4: further progress claim on the same Advanced Sale", () => {
  it("posts a second invoice against the SAME Sale without touching the first or repeating the deposit, and a replayed post is idempotent", async () => {
    await progress("Deposit", "100");
    const c1 = await claimAndApprove(); await post(c1); await reconcile(c1);
    const firstInvoice = structuredClone(port.sale.invoices[0]);
    await progress("Manufacturing", "50");
    const c2 = await claimAndApprove();
    await post(c2);
    expect(port.created).toHaveLength(2);
    expect(new Set(port.created.map((i) => i.saleId)).size).toBe(1); // one Advanced Sale
    expect(new Set(port.created.map((i) => i.memo)).size).toBe(2); // two distinct claims
    expect(port.sale.invoices[0]).toEqual(firstInvoice); // the earlier invoice is unchanged
    const manufacturing = await stageOf("Manufacturing");
    expect(port.created[1].charges.reduce((n, c) => n + Math.round(c.priceExVat * 100), 0)).toBe(Math.round(manufacturing.valueCents * 0.5)); // only the new progress, no deposit
    const again = await post(c1); // a replay / double click of an already-posted claim
    expect(again).toMatchObject({ alreadyPosted: true, message: "This claim is already in Cin7. Nothing was sent." });
    expect(again.posting.cin7_invoice_number).toBe("INV-101"); // the original invoice, not a new one
    expect(port.created).toHaveLength(2); // never a second invoice for the same claim
  });
});

describe("Scenario 5: fully billed, not fully shipped", () => {
  it("once 100% is billed no further claim exists, nothing more is written to Cin7, and the physical position still shows what is outstanding", async () => {
    const view = (await loadProjectView(db as never, ORG, projectId))!;
    for (const s of view.stages) await progress(s.name, "100");
    const c1 = await claimAndApprove(); await post(c1); await reconcile(c1);
    const billed = port.created.flatMap((i) => i.charges).reduce((n, c) => n + Math.round(c.priceExVat * 100), 0);
    expect(billed).toBe(view.project.original_contract_cents); // 100% commercial value billed
    const invoicesBefore = port.created.length;

    // nothing left to claim: no claim can be created merely to process physical stock
    const refusal = await err(createClaimDraft(db as never, ORG, "x@x", projectId));
    expect(refusal).toMatch(/nothing new to claim/i);
    expect(port.created).toHaveLength(invoicesBefore);

    // physical fulfilment is independent: 6 of 10 shipped, 4 outstanding, regardless of billing
    const physical = buildPhysicalStatus({
      ordered: [{ sku: "A", name: "A", quantity: 10 }], invoices: [], saleLinked: true, assemblies: [], stock: { A: { onHand: 3, allocated: 0, available: 3 } },
      fulfilments: [{ number: 1, packLines: [{ sku: "A", quantity: 6 }], shipped: true }],
    });
    expect(physical.rows[0]).toMatchObject({ ordered: 10, shipped: 6, remainingToDeliver: 4, available: 3, shortfall: 1 }); // the shortage stays visible
    // the Toolbox has no fulfilment-writing capability: the REAL Cin7Port interface can only read a Sale and create an invoice.
    // This is a compile-time check: adding any method to Cin7Port makes this object literal fail `tsc`, forcing a conscious review.
    const realPortMethods: Record<keyof Cin7Port, true> = { fetchSale: true, createInvoice: true };
    expect(Object.keys(realPortMethods).sort()).toEqual(["createInvoice", "fetchSale"]);
  });
  it("an unknown stock read is shown as unknown, never as zero", () => {
    const physical = buildPhysicalStatus({
      ordered: [{ sku: "A", name: "A", quantity: 10 }], invoices: [], saleLinked: true, assemblies: [], stock: {},
      fulfilments: [{ number: 1, packLines: [{ sku: "A", quantity: 6 }], shipped: true }],
    });
    expect(physical.rows[0].available).toBeNull();
    expect(physical.rows[0].shortfall).toBeNull();
  });
});

describe("Scenario 6: approved variation with its own Advanced Sale", () => {
  it("a commercial-only variation Sale with Cin7's empty fulfilment container verifies and links; the original Sale and its link are unchanged", async () => {
    const baseLinkBefore = structuredClone(db.rows("project_cin7_sale_links").find((l) => l.project_id === projectId));
    const v = await raiseVariation(db as never, ORG, "e@x", { projectId, title: "Additional ventilation", description: "", amountCents: R(500_000) });
    await approveVariation(db as never, ORG, "m@x", projectId, v.variationId);
    const { billingProjectId } = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId, variationId: v.variationId, products: [] });

    const EMPTY_CONTAINER = [{ FulfillmentNumber: 1, FulFilmentStatus: "FULFILLED", LinkedInvoiceNumber: "", Pick: { Status: "AUTHORISED", Lines: [] }, Pack: { Status: "AUTHORISED", Lines: [] },
      Ship: { Status: "AUTHORISED", RequireBy: null, ShippingAddress: { City: "Brits" }, ShippingNotes: "", Lines: [] } }];
    const sales = new Map<string, SaleReadBack>(); let creates = 0;
    const salePort: SaleCreationPort = {
      customerExists: async () => true, customerDefaults: async () => ({ taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }),
      resolveProducts: async (s) => ({ ids: new Map(s.map((k) => [k, `id-${k}`])), missing: [] }), assemblySkus: async () => [], stockAt: async () => [],
      createSale: async (req) => {
        creates++;
        const f = readBackFulfilments(EMPTY_CONTAINER);
        sales.set("var-sale", { id: "var-sale", type: "Advanced Sale", orderStatus: "AUTHORISED", customer: req.header.customer, externalId: req.header.externalId, taxRule: req.header.taxRule,
          lines: req.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })), charges: req.charges.map((c) => ({ description: c.description, priceCents: Math.round(c.priceExVat * 100), taxCents: Math.round(c.taxAmount * 100) })),
          invoiceCount: 0, fulfilmentCount: f.length, fulfilments: f });
        return { kind: "created", saleId: "var-sale", saleNumber: "SO-2" };
      },
      readSale: async (id) => structuredClone(sales.get(id)!), findByExternalId: async () => [],
    };
    const res = await createSaleForProject(db as never, salePort, ON, "mgr@x", { orgId: ORG, projectId: billingProjectId, instanceId: "i", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "NQ Test Customer", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" });
    expect(res).toMatchObject({ state: "RECONCILED", linked: true });
    expect(creates).toBe(1);

    const links = db.rows("project_cin7_sale_links");
    expect(links).toHaveLength(2); // one Sale for the original Project, one for the approved variation
    expect(links.find((l) => l.project_id === projectId)).toEqual(baseLinkBefore); // the original Sale link is unchanged
    expect(links.find((l) => l.project_id === billingProjectId)).toMatchObject({ cin7_sale_id: "var-sale", sale_role: "VARIATION" });
    const consolidated = (await loadConsolidatedProject(db as never, ORG, projectId))!;
    expect(consolidated.scopes.map((s) => s.scope)).toEqual(["BASE", "VARIATION"]); // revenue stays separately traceable
    expect(consolidated.totals.contractCents).toBe(goldenFixtureBaseline().contractCents + R(500_000));

    // duplicate-Sale protection: the variation cannot get a second Sale, and the original project still has exactly one
    const again = await createSaleForProject(db as never, salePort, ON, "mgr@x", { orgId: ORG, projectId: billingProjectId, instanceId: "i", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "NQ Test Customer", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" });
    expect(again.alreadyCreated).toBe(true);
    expect(creates).toBe(1);
  });
});
