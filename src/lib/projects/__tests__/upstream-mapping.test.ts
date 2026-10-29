// Phase G workflow correction: product mappings are resolved UPSTREAM (template / Solution Builder / quotation approval), not when the Cin7 Sale is
// created, and the manual "Link Cin7 Sale" form is gone from the normal workflow. Scenarios use the demo quotation's three known packages (M75
// feed system = flex_auger x12, PP penning priced per running metre = penning_package x240, FORTIS LED lighting = led_light x456). The SKUs below are
// TEST FIXTURES labelled TEST-*: no real Cin7 SKU is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { buildAcceptedBaseline, baselineMatchesHash, commercialLinesOf } from "@/newquip/quote/baseline";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { applyMappingLibrary, effectiveScope, scopeFromSnapshot, type LibraryMapping, type ScopeItem } from "../product-scope";
import { libraryOf, listActiveMappings, saveMappingVersion } from "../package-mapping-store";
import { describeScope, quoteScopeView } from "@/lib/newquip-quotes/scope-preview";
import { recoverLinkExistingSale } from "../cin7-sale-recovery-store";
import { buildCreationPlan, externalIdFor, type SaleReadBack } from "../cin7-sale-creation";
import { createSaleForProject } from "../cin7-sale-creation-store";

vi.mock("server-only", () => ({}));

const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
const draft = applyDemoDefaults(emptyDraft()).draft;
const ev = evaluateDraft(draft, ctx(true));
const AT = "2026-10-29T08:00:00Z";
const APPROVALS = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: AT };
const seal = (mappingLibrary?: ReadonlyMap<string, LibraryMapping>) => buildAcceptedBaseline({ quoteRef: "NQ-Q-0007", revision: 1, draft, evaluation: ev, marginEvaluation: evaluateDraft(draft, ctx(false)), approvals: APPROVALS, mappingLibrary });

/** A register as an OLD baseline would hold it: one M75 item resolved by a legacy mapping that marks a BOM component. */
const describeScopeSource = (m: LibraryMapping): ScopeItem[] => [{ id: "flex_auger:UNMAPPED", sku: null, description: "M75", quantity: 1, unit: "each", productType: "FINISHED_GOOD", origin: { lineRef: "flex_auger:UNMAPPED", label: "M75", packageKey: null, section: null, source: "QUOTE" }, scope: "BASE", sellingUnitCents: null, mapping: { status: "UNMAPPED", reason: "x" },
  resolution: { kind: "MAP_LINES", itemQuantity: 1, reason: "legacy", by: "m", at: AT, lines: m.lines.map((l) => ({ sku: l.sku, factor: l.factor, quantity: l.factor, unit: l.unit, role: l.role })) } }];
const lib = (packageKey: string, version: number, lines: LibraryMapping["lines"]): LibraryMapping => ({ packageKey, version, lines });
const M75 = lib("flex_auger", 2, [{ sku: "TEST-M75-SYSTEM", factor: 1, unit: "each", role: "FINISHED_GOOD", assembly: true }, { sku: "TEST-M75-AUGER", factor: 3, unit: "each", role: "FINISHED_GOOD", assembly: true }, { sku: "TEST-M75-MOTOR", factor: 2, unit: "each", role: "FINISHED_GOOD", assembly: false }]);
const PEN = lib("penning_package", 1, [{ sku: "TEST-PEN-ROLL", factor: 0.05, unit: "20 m roll", role: "FINISHED_GOOD" }, { sku: "TEST-PEN-POST", factor: 0.5, unit: "each", role: "FINISHED_GOOD" }]);
const LED = lib("led_light", 1, [{ sku: "TEST-FORTIS-LED", factor: 1, unit: "each", role: "FINISHED_GOOD" }, { sku: "TEST-FORTIS-MOUNT", factor: 1, unit: "each", role: "FINISHED_GOOD" }, { sku: "TEST-FORTIS-CABLE", factor: 2, unit: "m", role: "FINISHED_GOOD" }]);
const FULL = new Map([M75, PEN, LED].map((m) => [m.packageKey, m]));

describe("reusable mappings are applied while the solution is configured (Solution Builder scope view)", () => {
  it("1+2+3: M75, PP penning and FORTIS each expand into several Cin7 SKUs with exact converted quantities", () => {
    const v = quoteScopeView({ finalBaseline: null, evaluation: ev, library: FULL, now: AT });
    expect(v.unresolvedCount).toBe(0);
    const qty = Object.fromEntries(v.saleLines.filter((l) => l.sku.startsWith("TEST-")).map((l) => [l.sku, l.quantity]));
    expect(qty).toEqual({ "TEST-M75-SYSTEM": 12, "TEST-M75-AUGER": 36, "TEST-M75-MOTOR": 24, "TEST-PEN-ROLL": 12, "TEST-PEN-POST": 120, "TEST-FORTIS-LED": 456, "TEST-FORTIS-MOUNT": 456, "TEST-FORTIS-CABLE": 912 });
    expect(v.items.find((i) => i.id === "penning_package:UNMAPPED")).toMatchObject({ state: "FROM_LIBRARY", mappingRef: { packageKey: "penning_package", version: 1 } });
  });
  it("4+5: a Cin7 assembly is ONE Sales Order line (never expanded); a separately supplied accessory is its own valid line; both quantities are exact", () => {
    const v = quoteScopeView({ finalBaseline: null, evaluation: ev, library: FULL, now: AT });
    expect(v.referenceOnly).toEqual([]);
    const sys = v.items.find((i) => i.id === "flex_auger:UNMAPPED")!.lines;
    expect(sys.find((l) => l.sku === "TEST-M75-AUGER")).toMatchObject({ assembly: true, quantity: 36 }); // sold as the assembly it is
    expect(sys.find((l) => l.sku === "TEST-M75-MOTOR")).toMatchObject({ assembly: false, quantity: 24 }); // a separate product the customer receives
    expect(v.saleLines.filter((l) => l.sku.startsWith("TEST-M75")).map((l) => l.sku)).toEqual(["TEST-M75-SYSTEM", "TEST-M75-AUGER", "TEST-M75-MOTOR"]);
  });
  it("10: a legacy saved mapping that marks BOM components is NOT silently converted: the package stays unresolved with an explicit review reason", () => {
    const legacy = lib("flex_auger", 1, [{ sku: "TEST-M75-SYSTEM", factor: 1, unit: "each", role: "FINISHED_GOOD" }, { sku: "TEST-M75-MOTOR", factor: 2, unit: "each", role: "BOM_COMPONENT" }]);
    const v = quoteScopeView({ finalBaseline: null, evaluation: ev, library: new Map([[legacy.packageKey, legacy]]), now: AT });
    const item = v.items.find((i) => i.id === "flex_auger:UNMAPPED")!;
    expect(item.state).toBe("UNRESOLVED");
    expect(item.reason).toMatch(/not applied.*predates the sellable-products model.*manager must review/);
    expect(v.saleLines.some((l) => l.sku.startsWith("TEST-M75"))).toBe(false);
    // an already-sealed legacy baseline still reads exactly as approved (BOM line stays reference-only)
    const sealed = effectiveScope(describeScopeSource(legacy));
    expect(sealed.referenceOnly.map((r) => r.sku)).toEqual(["TEST-M75-MOTOR"]);
    expect(sealed.lines.map((l) => l.sku)).toEqual(["TEST-M75-SYSTEM"]);
  });
  it("7: where the quantity depends on the layout (PP penning: gates, corners, pig size) the mapping is flagged for manager confirmation, never guessed", () => {
    const pen = lib("penning_package", 2, [{ sku: "TEST-PEN-PANEL", factor: 1, unit: "each", role: "FINISHED_GOOD", quantityBasis: "MANAGER_CONFIRM" }, { sku: "TEST-PEN-GATE", factor: 1, unit: "each", role: "FINISHED_GOOD", quantityBasis: "MANAGER_CONFIRM" }]);
    const v = quoteScopeView({ finalBaseline: null, evaluation: ev, library: new Map([[pen.packageKey, pen]]), now: AT });
    const item = v.items.find((i) => i.id === "penning_package:UNMAPPED")!;
    expect(item.state).toBe("UNRESOLVED");
    expect(item.reason).toMatch(/TEST-PEN-PANEL, TEST-PEN-GATE depends on the layout.*manager must confirm/);
    expect(v.saleLines.some((l) => l.sku.startsWith("TEST-PEN"))).toBe(false); // no invented panels-per-metre
    // and a quoted item with no usable quantity cannot be quantified either
    const noQty = applyMappingLibrary(buildPhysicalScope(commercialLinesOf(ev.budget!)).map((i) => (i.id === "penning_package:UNMAPPED" ? { ...i, quantity: null } : i)), new Map([[PEN.packageKey, PEN]]), AT);
    expect(noQty.find((i) => i.id === "penning_package:UNMAPPED")!.resolution).toBeUndefined();
  });
  it("11: the same SKU reached through two packages is consolidated into one Sales Order line (summed, never duplicated)", () => {
    const shared = new Map([lib("flex_auger", 3, [{ sku: "TEST-SHARED", factor: 1, unit: "each", role: "FINISHED_GOOD" }]), lib("led_light", 2, [{ sku: "TEST-SHARED", factor: 2, unit: "each", role: "FINISHED_GOOD" }])].map((m) => [m.packageKey, m]));
    const lines = quoteScopeView({ finalBaseline: null, evaluation: ev, library: shared, now: AT }).saleLines.filter((l) => l.sku === "TEST-SHARED");
    expect(lines).toEqual([{ sku: "TEST-SHARED", quantity: 12 + 456 * 2, description: expect.any(String) }]);
  });
  it("7: missing mappings are visible warnings, never silent omissions; nothing is invented", () => {
    const v = quoteScopeView({ finalBaseline: null, evaluation: ev, library: new Map([PEN].map((m) => [m.packageKey, m])), now: AT });
    expect(v.items.filter((i) => i.state === "UNRESOLVED").map((i) => i.id)).toEqual(["flex_auger:UNMAPPED", "led_light:UNMAPPED"]);
    expect(v.unresolvedCount).toBe(2);
    expect(v.items.filter((i) => i.state === "UNRESOLVED").every((i) => i.lines.length === 0 && i.reason)).toBe(true);
    expect(quoteScopeView({ finalBaseline: null, evaluation: ev, library: null, now: AT }).unresolvedCount).toBe(3); // no library at all (migration pending) = all unresolved, not hidden
  });
  it("commercial package prices and revenue are untouched by mapping", () => {
    const before = commercialLinesOf(ev.budget!).map((l) => [l.itemKey, l.revenueCents]);
    quoteScopeView({ finalBaseline: null, evaluation: ev, library: FULL, now: AT });
    expect(commercialLinesOf(ev.budget!).map((l) => [l.itemKey, l.revenueCents])).toEqual(before);
    expect(seal(FULL).baseline.contractCents).toBe(seal().baseline.contractCents);
  });
});

describe("approval freezes the physical scope and the mapping versions", () => {
  it("5+8: a quotation with unresolved mappings still seals (approval is not blocked); one with mappings seals them with their versions", () => {
    const plain = seal();
    expect(plain.baseline.physicalScope!.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution)).toHaveLength(3);
    const mapped = seal(FULL);
    const r = mapped.baseline.physicalScope!.find((i) => i.id === "flex_auger:UNMAPPED")!.resolution!;
    expect(r).toMatchObject({ kind: "MAP_LINES", by: "mapping-library", mappingRef: { packageKey: "flex_auger", version: 2 } });
    expect(baselineMatchesHash(mapped.baseline, mapped.hash)).toBe(true);
    expect(mapped.hash).not.toBe(plain.hash);
  });
  it("5+13: a later mapping version, or a mapping added after approval, never changes an already-sealed quotation", () => {
    const early = seal(new Map([lib("flex_auger", 1, [{ sku: "TEST-M75-OLD", factor: 1, unit: "each", role: "FINISHED_GOOD" }]) ].map((m) => [m.packageKey, m])));
    const frozenLines = (b: typeof early) => effectiveScope(scopeFromSnapshot(b.baseline)).lines.map((l) => [l.sku, l.quantity]);
    const before = JSON.stringify(early.baseline.physicalScope);
    // the library moves on (v2 for M75, penning mapped) - the sealed view is read from the baseline, not recomputed
    const view = quoteScopeView({ finalBaseline: early.baseline, evaluation: ev, library: FULL, now: "2027-01-01T00:00:00Z" });
    expect(view.frozen).toBe(true);
    expect(JSON.stringify(early.baseline.physicalScope)).toBe(before);
    expect(frozenLines(early).filter(([k]) => String(k).startsWith("TEST-"))).toEqual([["TEST-M75-OLD", 12]]); // v1 only: the later v2 is not retro-applied
    expect(view.items.find((i) => i.id === "penning_package:UNMAPPED")!.state).toBe("UNRESOLVED"); // the old quotation stays as approved
    expect(view.items.find((i) => i.id === "flex_auger:UNMAPPED")!.mappingRef).toEqual({ packageKey: "flex_auger", version: 1 });
  });
  it("a baseline sealed before reusable mappings existed (no mapping library) is byte-identical to today's seal without one", () => {
    expect(seal(undefined).hash).toBe(seal(new Map()).hash);
  });
});

describe("6+9: the project inherits the physical products; the Cin7 Sale fails closed until resolved", () => {
  const projectRow = (snapshot: unknown) => ({ id: "p1", org_id: "o", status: "ACTIVE", project_reference: "PRJ-NQ-Q-0007", tax_rule: "x", tax_rate_bps: 1500, original_contract_cents: 100_000_00, billing_scope: "BASE", baseline_snapshot: snapshot });
  const gates = { writesEnabled: true, orgEnabled: true, isManager: true };
  const stages = [{ org_id: "o", project_id: "p1", name: "Deposit", value_cents: 100_000_00, sort_order: 1 }];
  const port = (calls: string[]) => ({ customerExists: async () => true, resolveProducts: async (s: string[]) => ({ ids: new Map(s.map((k) => [k, `id-${k}`])), missing: [] }), createSale: async () => { calls.push("createSale"); return { kind: "rejected" as const, httpStatus: 400, message: "stop" }; } }) as never;
  const input = { orgId: "o", projectId: "p1", instanceId: "i", confirmation: "Create a Cin7 Sale for this project", customerName: "C", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" };
  it("unresolved scope: no intent stored, no Cin7 call", async () => {
    const db = new FakeDb(); db.rows("projects").push(projectRow({ physicalScope: seal().baseline.physicalScope })); stages.forEach((s) => db.rows("project_stages").push(s));
    const calls: string[] = [];
    await expect(createSaleForProject(db as never, port(calls), gates, "m@x", { ...input, confirmation: "Create a Cin7 Advanced Sale for this project" })).rejects.toThrow(/product scope is not ready/);
    expect(calls).toEqual([]); expect(db.rows("project_cin7_sale_creations")).toHaveLength(0);
  });
  it("inherited mapped scope: nothing to resolve and the Sale proceeds to the single create call with the expected R0 physical lines", async () => {
    const db = new FakeDb(); db.rows("projects").push(projectRow({ physicalScope: seal(FULL).baseline.physicalScope })); stages.forEach((s) => db.rows("project_stages").push(s));
    const calls: string[] = [];
    const r = await createSaleForProject(db as never, port(calls), gates, "m@x", { ...input, confirmation: "Create a Cin7 Advanced Sale for this project" });
    expect(calls).toEqual(["createSale"]);
    expect(r.state).toBe("FAILED_CONFIRMED_NO_WRITE"); // the fake port rejects; the point is that the plan was accepted without anyone typing a SKU
    const plan = (db.rows("project_cin7_sale_creations")[0].plan as { lines: Array<{ sku: string; quantity: number }> });
    expect(plan.lines.find((l) => l.sku === "TEST-PEN-ROLL")).toMatchObject({ quantity: 12 });
    expect(plan.lines.find((l) => l.sku === "TEST-M75-MOTOR")).toMatchObject({ quantity: 24 }); // a separately supplied product is a normal R0 line
  });
  it("an audited exclusion is the only other way to proceed (never an automatic exclusion)", () => {
    expect(effectiveScope(seal().baseline.physicalScope!).blockers).toHaveLength(3);
  });
});

describe("14: organisation isolation of the mapping library", () => {
  it("only the caller's organisation's ACTIVE mappings are loaded", async () => {
    const db = new FakeDb();
    const row = (org: string, key: string, status: string): Record<string, unknown> => ({ id: `${org}${key}${status}`, org_id: org, package_key: key, version: 1, status: status as "ACTIVE", lines: [{ sku: "TEST-A", factor: 1, unit: "each", role: "FINISHED_GOOD" }], reason: "r", created_by_email: "m", created_at: "t", superseded_at: null });
    db.rows("newquip_package_mappings").push(row("A", "flex_auger", "ACTIVE"), row("B", "penning_package", "ACTIVE"), row("A", "led_light", "SUPERSEDED"));
    const a = await listActiveMappings(db as never, "A");
    expect([...a!.keys()]).toEqual(["flex_auger"]);
    expect([...libraryOf(a!).keys()]).toEqual(["flex_auger"]);
  });
});

describe("10-12: administrative recovery of an existing Sale", () => {
  const SALE = "11111111-2222-3333-4444-555555555555";
  const OTHER = "99999999-2222-3333-4444-555555555555";
  const scopeOK = seal(FULL).baseline.physicalScope;
  const setup = (over: { snapshot?: unknown; creation?: Record<string, unknown>; link?: Record<string, unknown> } = {}) => {
    const db = new FakeDb();
    db.rows("projects").push({ id: "p1", org_id: "o", status: "ACTIVE", project_reference: "PRJ-NQ-Q-0007", tax_rate_bps: 1500, original_contract_cents: 100_000_00, billing_scope: "BASE", baseline_snapshot: over.snapshot ?? { physicalScope: scopeOK } });
    db.rows("project_stages").push({ org_id: "o", project_id: "p1", name: "Deposit", value_cents: 40_000_00, sort_order: 1 }, { org_id: "o", project_id: "p1", name: "Delivery", value_cents: 60_000_00, sort_order: 2 });
    if (over.creation) db.rows("project_cin7_sale_creations").push({ org_id: "o", ...over.creation });
    if (over.link) db.rows("project_cin7_sale_links").push({ org_id: "o", ...over.link });
    return db;
  };
  const input = { orgId: "o", projectId: "p1", instanceId: "inst", saleId: SALE, customerName: "Test Customer", location: "MSTR", cin7TaxRule: "Standard Rate Sales", revenueAccount: "200", reason: "Creation outcome stayed uncertain after a timeout" };
  const planFor = () => { const b = buildCreationPlan({ projectRef: "PRJ-NQ-Q-0007", role: "BASE", customerName: "Test Customer", location: "MSTR", taxRule: "Standard Rate Sales", taxRateBps: 1500, revenueAccount: "200", contractCents: 100_000_00, stages: [{ name: "Deposit", valueCents: 40_000_00 }, { name: "Delivery", valueCents: 60_000_00 }], physicalLines: effectiveScope(scopeOK!).lines.map((l) => ({ sku: l.sku, name: l.description, quantity: l.quantity })), saleOrderDate: "2026-10-29" }); if (!b.ok) throw new Error(b.error); return b.plan; };
  const goodSale = (patch: Partial<SaleReadBack> = {}): SaleReadBack => { const p = planFor(); return { id: SALE, type: "Advanced Sale", orderStatus: "AUTHORISED", customer: p.customer, externalId: externalIdFor("PRJ-NQ-Q-0007"), taxRule: p.taxRule, lines: p.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })), charges: p.charges.map((c) => ({ description: c.description, priceCents: c.amountCents, taxCents: c.taxCents })), invoiceCount: 0, fulfilmentCount: 0, ...patch }; };
  const run = (db: FakeDb, sale: SaleReadBack, over: Partial<typeof input> = {}, gates = { orgEnabled: true, isManager: true }) => recoverLinkExistingSale(db as never, { readSale: async () => sale }, gates, "admin@x", { ...input, ...over });
  const err = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => e.message);

  it("links a Sale that is provably this project's, with reason + verification recorded on the link; writes nothing to Cin7", async () => {
    const db = setup();
    const link = await run(db, goodSale());
    expect(link).toMatchObject({ cin7_sale_id: SALE, link_status: "LINKED", linked_by_email: "admin@x" });
    expect((db.rows("project_cin7_sale_links")[0].sale_snapshot as { recovery: unknown }).recovery).toMatchObject({ reason: input.reason, by: "admin@x", verifiedAgainstPlan: true });
  });
  it("10: a non-administrator (or a disabled organisation) is refused before anything is read", async () => {
    const db = setup(); let reads = 0;
    const r = (gates: { orgEnabled: boolean; isManager: boolean }) => err(recoverLinkExistingSale(db as never, { readSale: async () => { reads++; return goodSale(); } }, gates, "u@x", input));
    expect(await r({ orgEnabled: true, isManager: false })).toMatch(/administrator/);
    expect(await r({ orgEnabled: false, isManager: true })).toMatch(/not enabled/);
    expect(reads).toBe(0); expect(db.rows("project_cin7_sale_links")).toHaveLength(0);
  });
  it("a reason is mandatory", async () => {
    expect(await err(run(setup(), goodSale(), { reason: " short " }))).toMatch(/reason/);
    expect(await err(run(setup(), goodSale(), { saleId: "not-a-guid" }))).toMatch(/SaleID/);
  });
  it("11: identity, customer and amount mismatches are refused rather than guessed", async () => {
    expect(await err(run(setup(), goodSale({ externalId: "NEWQUIP-PROJECTS-SALE:PRJ-OTHER" })))).toMatch(/ExternalID/);
    expect(await err(run(setup(), goodSale({ externalId: null })))).toMatch(/ExternalID/);
    expect(await err(run(setup(), goodSale({ customer: "Someone Else" })))).toMatch(/customer/);
    expect(await err(run(setup(), goodSale({ charges: planFor().charges.map((c, i) => ({ description: c.description, priceCents: i ? c.amountCents + 100 : c.amountCents, taxCents: c.taxCents })) })))).toMatch(/contract value|not found as planned/);
    expect(await err(run(setup(), goodSale({ lines: [{ sku: "TEST-PEN-ROLL", quantity: 1, priceCents: 0 }] })))).toMatch(/quantity|missing|unplanned/);
    expect(await err(run(setup(), goodSale({ orderStatus: "DRAFT" })))).toMatch(/AUTHORISED/);
    expect(await err(run(setup(), goodSale({ invoiceCount: 1 })))).toMatch(/invoice/);
    expect(await err(run(setup(), { ...goodSale(), id: OTHER }))).toMatch(/different Sale/);
    for (const d of [setup()]) expect(d.rows("project_cin7_sale_links")).toHaveLength(0);
  });
  it("scope that is not resolved cannot be verified, so recovery is refused", async () => {
    expect(await err(run(setup({ snapshot: { physicalScope: seal().baseline.physicalScope } }), goodSale()))).toMatch(/not resolved/);
  });
  it("12: a Sale already linked to (or created for) another project is never attached; an already-linked project is never re-linked", async () => {
    expect(await err(run(setup({ link: { project_id: "p2", cin7_sale_id: SALE } }), goodSale()))).toMatch(/already linked to a project/);
    expect(await err(run(setup({ creation: { project_id: "p2", creation_state: "RECONCILED", cin7_sale_id: SALE } }), goodSale()))).toMatch(/different project/);
    expect(await err(run(setup({ link: { project_id: "p1", cin7_sale_id: OTHER } }), goodSale()))).toMatch(/already linked to a Cin7 Sale/);
  });
  it("12: an existing creation intent blocks recovery unless it is the uncertain one for this very Sale", async () => {
    expect(await err(run(setup({ creation: { project_id: "p1", creation_state: "RECONCILED", cin7_sale_id: SALE } }), goodSale()))).toMatch(/creation in state RECONCILED/);
    expect(await err(run(setup({ creation: { project_id: "p1", creation_state: "PENDING", cin7_sale_id: null } }), goodSale()))).toMatch(/creation in state PENDING/);
    expect(await err(run(setup({ creation: { project_id: "p1", creation_state: "FAILED_UNCERTAIN", cin7_sale_id: OTHER } }), goodSale()))).toMatch(/different Cin7 Sale/);
    expect(await err(run(setup({ creation: { project_id: "p1", creation_state: "FAILED_UNCERTAIN", cin7_sale_id: SALE } }), goodSale()))).toBe("OK");
  });
});

describe("10: the normal project interface no longer offers manual Sale linking", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const posting = src("../../../app/projects/[id]/Cin7PostingPanel.tsx");
  it("the old SaleID / revenue-account form is gone; recovery is a collapsed, admin-only, reason-requiring section", () => {
    expect(posting).not.toMatch(/Link Cin7 Sale/);
    expect(posting).not.toMatch(/from the sale&apos;s URL/);
    expect(posting).toMatch(/Administrative recovery/);
    expect(posting).toMatch(/<details[^>]*>\s*<summary[^>]*>Administrative recovery/);
    expect(posting).toMatch(/gates\.isManager/);
    expect(posting).toMatch(/Reason for recovery \(required, audited\)/);
  });
  it("the Sale panel asks for no products and no typed SKU; it shows the inherited products and charges", () => {
    const sale = src("../../../app/projects/[id]/Cin7SaleCreationPanel.tsx");
    expect(sale).not.toMatch(/label="Cin7 SKU"/);
    expect(sale).toMatch(/inherited from the approved scope - not typed/);
    expect(sale).toMatch(/Contract charges on the Sales Order/);
  });
  it("the server action requires administrator rights and a reason (UI hiding is not the control)", () => {
    const act = src("../../../app/projects/cin7-actions.ts");
    expect(act).toMatch(/Only an organisation administrator can run Sale recovery/);
    expect(act).not.toMatch(/export async function linkCin7SaleAction/);
  });
});

describe("sellable-products mapping model (no BOM classification)", () => {
  const input = { orgId: "o", packageKey: "led_light", reason: "per supplier sheet" };
  const err = (p: Promise<unknown>) => p.then(() => "OK", (e: Error) => e.message);
  it("1+3: a package maps to one SKU or several; standard and assembly products both save, and Cin7's assembly flag is recorded (unknown stays unknown)", async () => {
    const db = new FakeDb();
    const port = { resolveProducts: async () => ({ missing: [] as string[] }), assemblySkus: async () => ["TEST-CTRL-PANEL"] };
    await saveMappingVersion(db as never, port, { isManager: true }, "m@x", { ...input, packageKey: "control_panel", lines: [{ sku: "TEST-CTRL-PANEL", factor: 1 }] });
    await saveMappingVersion(db as never, port, { isManager: true }, "m@x", { ...input, lines: [{ sku: "TEST-FORTIS-LED", factor: 1 }, { sku: "TEST-FORTIS-CABLE", factor: 2, unit: "m" }] });
    const [ctrl, led] = db.rows("newquip_package_mappings");
    expect(ctrl.lines).toEqual([expect.objectContaining({ sku: "TEST-CTRL-PANEL", role: "FINISHED_GOOD", assembly: true })]);
    expect(led.lines).toEqual([expect.objectContaining({ sku: "TEST-FORTIS-LED", assembly: false }), expect.objectContaining({ sku: "TEST-FORTIS-CABLE", factor: 2, unit: "m", assembly: false })]);
    await saveMappingVersion(db as never, { resolveProducts: async () => ({ missing: [] }), assemblySkus: async () => { throw new Error("down"); } }, { isManager: true }, "m@x", { ...input, packageKey: "x", lines: [{ sku: "TEST-X", factor: 1 }] });
    expect(db.rows("newquip_package_mappings")[2].lines).toEqual([expect.objectContaining({ assembly: null })]);
  });
  it("manual BOM classification cannot be saved; a layout-dependent line needs no formula but is marked for confirmation", async () => {
    const db = new FakeDb(); const port = { resolveProducts: async () => ({ missing: [] as string[] }) };
    expect(await err(saveMappingVersion(db as never, port, { isManager: true }, "m@x", { ...input, lines: [{ sku: "TEST-A", factor: 1, role: "BOM_COMPONENT" } as never] }))).toMatch(/managed in Cin7/);
    expect(await err(saveMappingVersion(db as never, port, { isManager: true }, "m@x", { ...input, lines: [{ sku: "TEST-A", factor: 0 }] }))).toMatch(/positive number/);
    expect(await err(saveMappingVersion(db as never, port, { isManager: true }, "m@x", { ...input, packageKey: "penning_package", lines: [{ sku: "TEST-PEN-PANEL", factor: 0, confirmQuantity: true }] }))).toBe("OK");
    expect(db.rows("newquip_package_mappings")[0].lines).toEqual([expect.objectContaining({ quantityBasis: "MANAGER_CONFIRM" })]);
  });
  it("8: costs and margins are sealed independently of the physical SKUs: mapping never changes the internal margin sheet or the contract", () => {
    expect(JSON.stringify(seal(FULL).baseline.internalMargin)).toBe(JSON.stringify(seal().baseline.internalMargin));
    expect(seal(FULL).baseline.commercial).toEqual(seal().baseline.commercial);
  });
  it("the mapping screens no longer offer BOM-component / finished-good classification", () => {
    const f = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    for (const file of ["../../../app/projects/[id]/VariationProductPicker.tsx", "../../../app/newquip-grower/[id]/ScopePanel.tsx", "../../../app/projects/[id]/Cin7SaleCreationPanel.tsx"]) {
      expect(f(file)).not.toMatch(/BOM component \(reference only\)|Finished good \(on the Sales Order\)|withRole/);
    }
  });
});
