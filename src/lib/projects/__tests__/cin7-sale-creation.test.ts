import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { createProjectFromBaseline } from "../project-store";
import { createSaleForProject, loadCreation, reconcileSaleCreation, type SaleCreateOutcome, type SaleCreationPort } from "../cin7-sale-creation-store";
import { CREATE_CONFIRMATION_TEXT, buildCreationPlan, externalIdFor, verifyCreatedSale, type CreationPlan, type SaleReadBack } from "../cin7-sale-creation";
import type { WriteGates } from "../cin7-posting-store";

const ORG = "org-a";
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };
const R = (n: number) => n * 100;

const inputs = (over: Partial<Parameters<typeof buildCreationPlan>[0]> = {}) => ({
  projectRef: "PRJ-NQ-Q-0001", role: "BASE" as const, customerName: "Test Customer", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200",
  contractCents: R(10_000_000), stages: [{ name: "Deposit", valueCents: R(1_000_000) }, { name: "Manufacturing", valueCents: R(3_000_000) }, { name: "Delivery", valueCents: R(6_000_000) }],
  physicalLines: [{ sku: "NQ2886", name: "Bracket", quantity: 2 }], saleOrderDate: "2026-10-28", ...over,
});

describe("creation plan (pure)", () => {
  it("carries the contract as one charge per stage, VAT as per-charge amounts, physical lines as quantity only", () => {
    const r = buildCreationPlan(inputs());
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.charges.map((c) => [c.amountCents, c.taxCents])).toEqual([[R(1_000_000), R(150_000)], [R(3_000_000), R(450_000)], [R(6_000_000), R(900_000)]]);
    expect(r.plan).toMatchObject({ contractCents: R(10_000_000), taxCents: R(1_500_000), totalCents: R(11_500_000), externalId: "NEWQUIP-PROJECTS-SALE:PRJ-NQ-Q-0001" });
    expect(r.plan.lines).toEqual([{ sku: "NQ2886", name: "Bracket", quantity: 2 }]);
    expect(buildCreationPlan(inputs())).toEqual(r); // deterministic, including the fingerprint
  });
  it("uses the same per-line VAT rounding as claims; omits zero-value stages", () => {
    const r = buildCreationPlan(inputs({ contractCents: 1_000_001, stages: [{ name: "A", valueCents: 333_300 }, { name: "B", valueCents: 0 }, { name: "C", valueCents: 666_701 }] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.charges.map((c) => c.taxCents)).toEqual([49_995, 100_005]); // round(333300*.15)=49995, round(666701*.15)=100005.15
    expect(r.plan.charges).toHaveLength(2);
  });
  it("fails closed on bad money, stages that do not total the contract, bad lines and bad references", () => {
    const bad = (o: Partial<Parameters<typeof buildCreationPlan>[0]>) => { const r = buildCreationPlan(inputs(o)); return r.ok ? null : r.error; };
    expect(bad({ contractCents: R(10_000_000) + 1 })).toMatch(/total/);
    expect(bad({ contractCents: 0, stages: [] })).toBeTruthy();
    expect(bad({ contractCents: Number.NaN })).toMatch(/positive/);
    expect(bad({ stages: [{ name: "A", valueCents: R(5_000_000) }, { name: "A", valueCents: R(5_000_000) }] })).toMatch(/twice/);
    expect(bad({ physicalLines: [{ sku: "A", name: "a", quantity: 0 }] })).toMatch(/positive/);
    expect(bad({ physicalLines: [{ sku: "A", name: "a", quantity: 1 }, { sku: "A", name: "a", quantity: 1 }] })).toMatch(/twice/);
    expect(bad({ customerName: " " })).toMatch(/customer/);
    expect(bad({ taxRateBps: 20_000 })).toMatch(/tax rate/);
    expect(bad({ saleOrderDate: "28/10/2026" })).toMatch(/date/);
    expect(bad({ revenueAccount: "" })).toMatch(/revenue account/);
  });
  it("a commercial-only Sale (no physical lines) is allowed", () => {
    expect(buildCreationPlan(inputs({ physicalLines: [] })).ok).toBe(true);
  });
});

const goodReadBack = (plan: CreationPlan, over: Partial<SaleReadBack> = {}): SaleReadBack => ({
  id: "sale-1", type: "Advanced Sale", orderStatus: "AUTHORISED", customer: plan.customer, externalId: plan.externalId, taxRule: plan.taxRule,
  lines: plan.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })),
  charges: plan.charges.map((c) => ({ description: c.description, priceCents: c.amountCents, taxCents: c.taxCents })),
  invoiceCount: 0, fulfilmentCount: 0, ...over,
});

describe("read-back verification", () => {
  const plan = (() => { const r = buildCreationPlan(inputs()); if (!r.ok) throw new Error(r.error); return r.plan; })();
  it("accepts a Sale that reads back exactly as planned", () => expect(verifyCreatedSale(plan, goodReadBack(plan))).toEqual([]));
  it.each([
    ["a Simple Sale", { type: "Simple Sale" }, /not an Advanced Sale/],
    ["a missing type", { type: null }, /not an Advanced Sale/],
    ["not AUTHORISED", { orderStatus: "DRAFT" }, /not AUTHORISED/],
    ["the wrong customer", { customer: "AGRICO" }, /customer/],
    ["a missing ExternalID", { externalId: null }, /ExternalID/],
    ["the wrong tax rule", { taxRule: "Zero Rated" }, /tax rule/],
    ["an existing invoice", { invoiceCount: 1 }, /invoice/],
    ["an existing fulfilment", { fulfilmentCount: 1 }, /fulfilment/],
    ["a priced physical line (double revenue)", { lines: [{ sku: "NQ2886", quantity: 2, priceCents: 50_000 }] }, /must be R0/],
    ["an unreadable line price", { lines: [{ sku: "NQ2886", quantity: 2, priceCents: null }] }, /must be R0/],
    ["a wrong quantity", { lines: [{ sku: "NQ2886", quantity: 3, priceCents: 0 }] }, /quantity 3 vs planned 2/],
    ["a missing line", { lines: [] }, /missing from the order/],
    ["an unplanned line", { lines: [{ sku: "NQ2886", quantity: 2, priceCents: 0 }, { sku: "X", quantity: 1, priceCents: 0 }] }, /unplanned/],
    ["a missing charge", { charges: [] }, /contract charge/],
    ["unreadable charge amounts", { charges: [{ description: "d", priceCents: null, taxCents: null }, { description: "e", priceCents: null, taxCents: null }, { description: "f", priceCents: null, taxCents: null }] }, /not returned/],
  ] as Array<[string, Partial<SaleReadBack>, RegExp]>)("rejects %s", (_n, over, re) => {
    expect(verifyCreatedSale(plan, goodReadBack(plan, over)).join("|")).toMatch(re);
  });
  it("rejects wrong VAT (the INV-00021 shape: R30 instead of R142,500)", () => {
    const r = goodReadBack(plan, { charges: plan.charges.map((c) => ({ description: c.description, priceCents: c.amountCents, taxCents: 15 })) });
    expect(verifyCreatedSale(plan, r).join("|")).toMatch(/contract VAT/);
  });
});

// ── store ──────────────────────────────────────────────────────────────────
class FakePort implements SaleCreationPort {
  customers = new Set(["Test Customer"]);
  skus = new Map([["NQ2886", "pid-1"]]);
  sales = new Map<string, SaleReadBack>();
  creates: Array<Parameters<SaleCreationPort["createSale"]>[0]> = [];
  next: SaleCreateOutcome | "throw" | null = null;
  tamper: ((r: SaleReadBack) => SaleReadBack) | null = null;
  failRead = false;
  found: Array<{ saleId: string; saleNumber: string | null }> = [];
  onCreate: (() => Promise<void>) | null = null;
  async customerExists(n: string) { return this.customers.has(n); }
  async resolveProducts(skus: string[]) { const ids = new Map<string, string>(); const missing: string[] = []; for (const s of skus) { const id = this.skus.get(s); if (id) ids.set(s, id); else missing.push(s); } return { ids, missing }; }
  async createSale(req: Parameters<SaleCreationPort["createSale"]>[0]): Promise<SaleCreateOutcome> {
    this.creates.push(req);
    await this.onCreate?.();
    if (this.next === "throw") throw new Error("boom");
    if (this.next) return this.next;
    const id = `sale-${this.creates.length}`;
    const rb: SaleReadBack = {
      id, type: "Advanced Sale", orderStatus: "AUTHORISED", customer: req.header.customer, externalId: req.header.externalId, taxRule: req.header.taxRule,
      lines: req.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })),
      charges: req.charges.map((c) => ({ description: c.description, priceCents: Math.round(c.priceExVat * 100), taxCents: Math.round(c.taxAmount * 100) })),
      invoiceCount: 0, fulfilmentCount: 0,
    };
    this.sales.set(id, this.tamper ? this.tamper(rb) : rb);
    return { kind: "created", saleId: id, saleNumber: "SO-00100" };
  }
  assemblies = new Set<string>();
  async customerDefaults(n: string) { return this.customers.has(n) ? { taxRule: "Standard Rate Sales", revenueAccount: "200", location: null } : null; }
  async stockAt() { return []; }
  async assemblySkus(skus: string[]) { return skus.filter((s) => this.assemblies.has(s)); }
  async readSale(id: string) { if (this.failRead) throw new Error("read failed"); const s = this.sales.get(id); if (!s) throw new Error("no such sale"); return structuredClone(s); }
  async findByExternalId() { return this.found; }
}

let db: FakeDb; let projectId: string; let port: FakePort;
const baseInput = () => ({ orgId: ORG, projectId, instanceId: "inst-1", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "Test Customer", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales", now: new Date("2026-10-28T10:00:00Z") });
const create = (over: Partial<WriteGates> = {}, o: Partial<ReturnType<typeof baseInput>> = {}) => createSaleForProject(db as never, port, { ...ON, ...over }, "mgr@x", { ...baseInput(), ...o });
const row = () => db.rows("project_cin7_sale_creations")[0] as Record<string, unknown> | undefined;

beforeEach(async () => {
  db = new FakeDb(); port = new FakePort();
  projectId = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), taxRule: "Standard Rate Sales", lines: [{ lineRef: "L1", sku: "NQ2886", description: "Bracket", quantity: 2, salesValueCents: 0, estimatedCostCents: null, suggestedStageName: null }] }, { reference: "PRJ-NQ-Q-0001", name: "n" });
});

describe("Advanced Sale creation", () => {
  it("creates ONCE, reads the Sale back, links it, and marks the intent RECONCILED", async () => {
    const r = await create();
    expect(r).toMatchObject({ state: "RECONCILED", linked: true });
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0].lines).toEqual([{ productId: "pid-1", sku: "NQ2886", name: "Bracket", quantity: 2, taxRule: "Standard Rate Sales" }]);
    expect(port.creates[0].charges.reduce((n, c) => n + c.priceExVat, 0)).toBe(10_000_000);
    expect(port.creates[0].charges.reduce((n, c) => n + c.taxAmount, 0)).toBe(1_500_000); // a monetary amount, not a rate
    expect(row()).toMatchObject({ creation_state: "RECONCILED", progress: "DONE", cin7_sale_id: "sale-1", external_id: externalIdFor("PRJ-NQ-Q-0001") });
    expect(db.rows("project_cin7_sale_links")).toHaveLength(1);
    expect(db.rows("project_cin7_sale_links")[0]).toMatchObject({ cin7_sale_id: "sale-1", project_id: projectId, revenue_account: "200" });
  });
  it("fails closed on every gate and never stores an intent or calls Cin7", async () => {
    for (const g of [{ writesEnabled: false }, { orgEnabled: false }, { isManager: false }]) expect(await err(create(g))).toBeDefined();
    expect(await err(create({}, { confirmation: "yes" }))).toMatch(/confirmation/);
    expect(port.creates).toHaveLength(0); expect(row()).toBeUndefined();
  });
  it("validates against Cin7 read-only BEFORE any intent: unknown customer or SKU stores nothing and sends nothing", async () => {
    expect(await err(create({}, { customerName: "Nobody" }))).toMatch(/does not exist in Cin7/);
    (db.rows("projects")[0].baseline_snapshot as { lines: Array<{ sku: string }> }).lines[0].sku = "NOPE";
    expect(await err(create())).toMatch(/NOPE/);
    expect(port.creates).toHaveLength(0); expect(row()).toBeUndefined();
  });
  it("a replay or double click cannot create a second Sale", async () => {
    await create();
    const again = await create();
    expect(again).toMatchObject({ alreadyCreated: true, state: "RECONCILED", linked: true });
    db.tables["project_cin7_sale_creations"] = []; // a link with no creation intent (a manually linked Sale) also blocks creation
    expect(await err(create())).toMatch(/already has a linked/);
    expect(port.creates).toHaveLength(1);
  });
  it("a concurrent second request while the first is in flight is refused (the intent is the lock)", async () => {
    let second: string | undefined;
    port.onCreate = async () => { second = await err(create()); };
    await create();
    expect(second).toMatch(/already in progress/);
    expect(port.creates).toHaveLength(1);
  });
  it("a definite rejection is a confirmed no-write; only then may the SAME row be retried, with attempt_count incremented", async () => {
    port.next = { kind: "rejected", httpStatus: 400, message: "bad" };
    expect(await create()).toMatchObject({ state: "FAILED_CONFIRMED_NO_WRITE" });
    expect(row()).toMatchObject({ progress: "NONE", attempt_count: 1 });
    port.next = null;
    expect(await create()).toMatchObject({ state: "RECONCILED" });
    expect(db.rows("project_cin7_sale_creations")).toHaveLength(1);
    expect(row()).toMatchObject({ attempt_count: 2 });
  });
  it("an uncertain outcome is never retried blindly", async () => {
    port.next = { kind: "uncertain", reason: "timeout", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
    expect(await create()).toMatchObject({ state: "FAILED_UNCERTAIN" });
    port.next = null;
    expect(await err(create())).toMatch(/uncertain/);
    expect(port.creates).toHaveLength(1);
    expect(db.rows("project_cin7_sale_links")).toHaveLength(0);
  });
  it("an unexpected exception from the port is recorded as uncertain, not as safe", async () => {
    port.next = "throw";
    expect(await create()).toMatchObject({ state: "FAILED_UNCERTAIN" });
  });
  it("a Sale that does not read back as planned is NOT linked and is never resent", async () => {
    port.tamper = (r) => ({ ...r, lines: r.lines.map((l) => ({ ...l, priceCents: 50_000 })) });
    const r = await create();
    expect(r).toMatchObject({ state: "CREATED", linked: false });
    expect(r.message).toMatch(/must be R0/);
    expect(row()).toMatchObject({ creation_state: "CREATED", last_error_code: "VERIFICATION_FAILED" });
    expect(db.rows("project_cin7_sale_links")).toHaveLength(0);
    expect((await create()).alreadyCreated).toBe(true);
    expect(port.creates).toHaveLength(1);
  });
  it("a read-back that fails leaves the Sale unlinked and reconcilable", async () => {
    port.failRead = true;
    const r = await create();
    expect(r).toMatchObject({ state: "CREATED", linked: false });
    expect(row()).toMatchObject({ last_error_code: "READBACK_FAILED" });
    port.failRead = false;
    expect(await reconcileSaleCreation(db as never, port, { isManager: true }, "mgr@x", { orgId: ORG, projectId })).toMatchObject({ state: "RECONCILED", linked: true });
    expect(port.creates).toHaveLength(1);
  });
  it("refuses a non-ACTIVE project, a project that already has a link, and a changed plan on retry", async () => {
    port.next = { kind: "rejected", httpStatus: 400, message: "bad" };
    await create();
    port.next = null;
    expect(await err(create({}, { revenueAccount: "999" }))).toMatch(/no longer matches/);
    db.rows("projects")[0].status = "COMPLETED";
    expect(await err(create())).toMatch(/ACTIVE/);
  });
});

describe("reconciliation (read-only)", () => {
  const uncertain = async (o: Partial<Extract<SaleCreateOutcome, { kind: "uncertain" }>> = {}) => {
    port.next = { kind: "uncertain", reason: "timeout", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN", ...o };
    await create(); port.next = null;
  };
  const rec = (g = { isManager: true }) => reconcileSaleCreation(db as never, port, g, "mgr@x", { orgId: ORG, projectId });

  it("requires a manager and an existing attempt", async () => {
    expect(await err(rec({ isManager: false }))).toMatch(/manager/);
    expect(await err(rec())).toMatch(/nothing to reconcile/);
  });
  it("finds no Sale -> confirmed no-write, which permits one controlled retry", async () => {
    await uncertain();
    expect(await rec()).toMatchObject({ state: "FAILED_CONFIRMED_NO_WRITE" });
    expect(await create()).toMatchObject({ state: "RECONCILED" });
    expect(port.creates).toHaveLength(2);
  });
  it("finds exactly one matching Sale -> verifies, links, reconciles (no resend)", async () => {
    await uncertain();
    const plan = (row()!.plan as CreationPlan);
    port.sales.set("sale-found", goodReadBack(plan, { id: "sale-found" }));
    port.found = [{ saleId: "sale-found", saleNumber: "SO-00200" }];
    expect(await rec()).toMatchObject({ state: "RECONCILED", linked: true });
    expect(db.rows("project_cin7_sale_links")[0]).toMatchObject({ cin7_sale_id: "sale-found" });
    expect(port.creates).toHaveLength(1);
  });
  it("finds an incomplete/different Sale -> stays uncertain, unlinked, with a manual-action message; never auto-completed or resent", async () => {
    await uncertain();
    const plan = (row()!.plan as CreationPlan);
    port.sales.set("sale-half", goodReadBack(plan, { id: "sale-half", orderStatus: "ESTIMATING", lines: [], charges: [] }));
    port.found = [{ saleId: "sale-half", saleNumber: "SO-00201" }];
    const r = await rec();
    expect(r).toMatchObject({ state: "FAILED_UNCERTAIN", linked: false });
    expect(r.message).toMatch(/not as planned/);
    expect(row()).toMatchObject({ cin7_sale_id: "sale-half", progress: "HEADER", last_error_code: "INCOMPLETE_SALE_FOUND" });
    expect(await err(create())).toMatch(/uncertain/);
    expect(port.creates).toHaveLength(1);
  });
  it("two Sales with our ExternalID -> refuses to guess", async () => {
    await uncertain();
    port.found = [{ saleId: "a", saleNumber: null }, { saleId: "b", saleNumber: null }];
    expect(await err(rec())).toMatch(/refusing to guess/);
  });
  it("an orphan header (header created, order failed) is recorded with its Sale id and is never auto-resumed", async () => {
    await uncertain({ saleId: "sale-orphan", saleNumber: "SO-00300", stage: "HEADER_CREATED", reason: "order failed" });
    expect(row()).toMatchObject({ creation_state: "FAILED_UNCERTAIN", progress: "HEADER", cin7_sale_id: "sale-orphan", last_error_code: "ORPHAN_HEADER" });
    const plan = (row()!.plan as CreationPlan);
    port.sales.set("sale-orphan", goodReadBack(plan, { id: "sale-orphan", orderStatus: "ESTIMATING", lines: [], charges: [] }));
    const r = await rec();
    expect(r).toMatchObject({ state: "FAILED_UNCERTAIN", linked: false });
    expect(port.creates).toHaveLength(1);
    // the manager completes the Sale in Cin7; reconciliation then verifies and links it
    port.sales.set("sale-orphan", goodReadBack(plan, { id: "sale-orphan" }));
    expect(await rec()).toMatchObject({ state: "RECONCILED", linked: true });
  });
  it("a stale PENDING (process died mid-call) is treated as uncertain before reconciling", async () => {
    const plan = buildCreationPlan(inputs()); if (!plan.ok) throw new Error("x");
    await db.from("project_cin7_sale_creations").insert({ org_id: ORG, project_id: projectId, instance_id: "i", sale_role: "BASE", external_id: plan.plan.externalId, request_fingerprint: plan.fingerprint, creation_state: "PENDING", attempt_count: 1, plan: plan.plan, contract_ex_vat_cents: plan.plan.contractCents, progress: "NONE", requested_by_email: "m", requested_at: "2026-10-28T08:00:00Z" });
    expect(await rec()).toMatchObject({ state: "FAILED_CONFIRMED_NO_WRITE" });
    expect((await loadCreation(db as never, ORG, projectId))?.last_error_code).toBe("RECONCILED_NO_SALE");
  });
});

describe("Cin7 tax rule name", () => {
  it("the Sale carries the Cin7 tax rule name entered by the manager, never the project's Toolbox label", async () => {
    db.rows("projects")[0].tax_rule = "VAT 15% (NewQuip POC)"; // the label NewQuip projects actually carry
    const r = await create({}, { cin7TaxRule: "Standard Rate Sales" });
    expect(r.state).toBe("RECONCILED");
    expect(port.creates[0].header.taxRule).toBe("Standard Rate Sales");
    expect(port.creates[0].lines.every((l) => l.taxRule === "Standard Rate Sales")).toBe(true);
    expect(port.creates[0].charges.every((c) => c.taxRule === "Standard Rate Sales")).toBe(true);
    expect(JSON.stringify(port.creates)).not.toMatch(/NewQuip POC/);
    expect(db.rows("project_cin7_sale_links")[0].tax_rule).toBe("Standard Rate Sales");
  });
  it("a blank Cin7 tax rule is refused before anything is stored or sent", async () => {
    expect(await err(create({}, { cin7TaxRule: "  " }))).toMatch(/Cin7 tax rule name/);
    expect(port.creates).toHaveLength(0); expect(row()).toBeUndefined();
  });
});

describe("variation billing project", () => {
  it("creates and links a VARIATION Sale for its own billing project with its own external id", async () => {
    // a variation billing project has its own reference/contract/stages; emulate one directly
    const pid = "id-variation";
    db.rows("projects").push({ id: pid, org_id: ORG, project_reference: "PRJ-NQ-Q-0001-V001", status: "ACTIVE", tax_rule: "Standard Rate Sales", tax_rate_bps: 1500, original_contract_cents: 48_000_000, billing_scope: "VARIATION" });
    db.rows("project_stages").push({ id: "st-v", org_id: ORG, project_id: pid, sort_order: 1, name: "Variation", value_cents: 48_000_000 });
    const r = await createSaleForProject(db as never, port, ON, "mgr@x", { ...baseInput(), projectId: pid });
    expect(r).toMatchObject({ state: "RECONCILED", linked: true });
    expect(db.rows("project_cin7_sale_creations").find((c) => c.project_id === pid)).toMatchObject({ sale_role: "VARIATION", external_id: "NEWQUIP-PROJECTS-SALE:PRJ-NQ-Q-0001-V001" });
    expect(db.rows("project_cin7_sale_links").find((l) => l.project_id === pid)).toMatchObject({ sale_role: "VARIATION" });
    expect(port.creates[0].charges.reduce((n, c) => n + c.taxAmount, 0)).toBe(72_000);
  });
});
