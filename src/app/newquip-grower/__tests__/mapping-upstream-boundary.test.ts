// Phase G workflow correction, through the REAL server actions: reusable mappings applied at manager approval are frozen into the baseline, the
// project inherits them, approval is never blocked by missing mappings, other organisations' mappings are never used, and saving a mapping is
// manager-only. Only authentication and the database client are substituted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { effectiveScope, scopeFromSnapshot } from "@/lib/projects/product-scope";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ db: null as unknown, admin: true }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => h.db }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: async () => ({ orgId: "org-nq" }) }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: async () => ({ orgId: "org-nq", userId: "u1", email: "m@nq" }) }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: async () => { if (!h.admin) throw new Error("not admin"); return { orgId: "org-nq" }; } }));
vi.mock("@/lib/activity-log", () => ({ logActivity: async () => undefined }));

import { approveGrowerQuoteAction, createProjectFromGrowerQuoteAction } from "../actions";
import { onCurrentTemplate } from "@/newquip/grower/__tests__/current-template";
import { managerExceptionOpts } from "@/newquip/grower/__tests__/baseline-exception-fixture";
import { getQuoteScopeAction, saveReusableMappingAction } from "../mapping-actions";

const ORG = "org-nq";
const legacyDraft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft); // unstamped = the ORIGINAL template (the LED has no SKUs)
const draft = onCurrentTemplate(legacyDraft); // a NEW quotation (current template revision)
const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
// The LED package is SKU-backed now (HNQ7046 / HNQ7093 / HNQ7088, Sean 2026-11), so it needs no library mapping. `ctrlDraft` adds the optional controller with an Estimator-typed price and no Cin7 mapping:
// the "typed-price package that must be mapped" the LED used to be.
const ctrlDraft = { ...draft, config: { ...draft.config, optionalEquipment: { ...draft.config.optionalEquipment, controller: true }, estimatorQuantities: { ...draft.config.estimatorQuantities, controller: 2 } },
  estimator: { ...draft.estimator, priceResolutions: { ...draft.estimator.priceResolutions, controller: { unitPriceExVat: 3000, reason: "Estimator price; no Cin7 product chosen" } } } } as typeof draft;
const totalOf = (d: typeof draft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
const total = totalOf(draft);
const map = (org: string, key: string, version: number, lines: Array<{ sku: string; factor: number; role?: string }>, status = "ACTIVE") =>
  ({ id: `${org}-${key}-${version}`, org_id: org, package_key: key, version, status, lines: lines.map((l) => ({ unit: "each", role: "FINISHED_GOOD", ...l })), reason: "r", created_by_email: "m", created_at: "t", superseded_at: null });

function seedQuote(db: FakeDb, id: string, ref: string, d: typeof draft = draft) {
  db.rows("newquip_quotes").push({
    id, org_id: ORG, quote_ref: ref, revision: 1, customer_name: "Test Customer", site_name: "Test Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: d, draft_hash: "h1",
    customer_confirmed_cents: totalOf(d), customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "r", estimator_signoff_hash: "h1", estimator_signoff_by_email: "e", estimator_signoff_at: "t",
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t",
  });
}
beforeEach(() => { h.db = new FakeDb(); h.admin = true; });

async function seedAndScope(db: FakeDb, d: typeof draft): Promise<number> {
  db.rows("newquip_quotes").length = 0;
  seedQuote(db, "q1", "NQ-Q-0001", d); db.rows("newquip_quotes")[0].state = "DRAFT";
  return (await getQuoteScopeAction("q1")).data!.unresolvedCount;
}

describe("approval -> project -> Sale scope, through the real actions", () => {
  it("8: UX-006 S3 - approval needs the Manager's exception for M75 / penning and a mapped typed-price product (the controller); the two Estimator-priced systems stay visibly unresolved in the frozen scope", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001", ctrlDraft);
    expect((await approveGrowerQuoteAction("q1")).error).toMatch(/3 package\(s\) are not mapped/);
    db.rows("newquip_package_mappings").push(map(ORG, "controller", 1, [{ sku: "TEST-CTRL", factor: 1 }]));
    expect((await approveGrowerQuoteAction("q1")).error).toMatch(/2 package\(s\) are not mapped/);
    const q = db.rows("newquip_quotes")[0] as { revision: number; draft_hash: string };
    expect((await approveGrowerQuoteAction("q1", managerExceptionOpts(q as never))).ok).toBe(true);
    const v = await getQuoteScopeAction("q1");
    expect(v.data).toMatchObject({ frozen: true, unresolvedCount: 2 });
  });
  it("8-legacy: on the ORIGINAL template the LED is a third unmapped package: approval needs it mapped (3), then only M75 / penning remain (2) for the Manager's exception", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001", legacyDraft);
    expect((await approveGrowerQuoteAction("q1")).error).toMatch(/3 package\(s\) are not mapped/);
    db.rows("newquip_package_mappings").push(map(ORG, "led_light", 1, [{ sku: "TEST-FORTIS-LED", factor: 1 }]));
    expect((await approveGrowerQuoteAction("q1")).error).toMatch(/2 package\(s\) are not mapped/);
    const q = db.rows("newquip_quotes")[0] as { revision: number; draft_hash: string };
    expect((await approveGrowerQuoteAction("q1", managerExceptionOpts(q as never))).ok).toBe(true);
    expect(await getQuoteScopeAction("q1")).toMatchObject({ data: { frozen: true, unresolvedCount: 2 } });
  });
  it("8b: the SKU-backed LED needs no mapping: only M75 / penning are unmapped, so the Manager's exception alone approves it", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001");
    expect((await approveGrowerQuoteAction("q1")).error).toMatch(/2 package\(s\) are not mapped to Cin7 SKUs \(M75 feed distribution system, PP penning/);
    const q = db.rows("newquip_quotes")[0] as { revision: number; draft_hash: string };
    expect((await approveGrowerQuoteAction("q1", managerExceptionOpts(q as never))).ok).toBe(true);
  });
  it("5+6: active mappings are sealed at approval, then inherited by the new project with no one re-selecting products", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001");
    db.rows("newquip_package_mappings").push(
      map(ORG, "flex_auger", 1, [{ sku: "TEST-M75-SYSTEM", factor: 1 }, { sku: "TEST-M75-MOTOR", factor: 2 }]),
      map(ORG, "penning_package", 1, [{ sku: "TEST-PEN-ROLL", factor: 0.05 }, { sku: "TEST-PEN-POST", factor: 0.5 }]),
      map(ORG, "led_light", 1, [{ sku: "TEST-FORTIS-LED", factor: 1 }]),
    );
    expect((await approveGrowerQuoteAction("q1")).ok).toBe(true);
    // a newer version appears AFTER approval: it must not touch the sealed quote
    db.rows("newquip_package_mappings").push(map(ORG, "penning_package", 2, [{ sku: "TEST-PEN-OTHER", factor: 1 }], "ACTIVE"));
    const r = await createProjectFromGrowerQuoteAction("q1");
    expect(r.ok).toBe(true);
    const proj = db.rows("projects").find((p) => p.id === r.data!.projectId)!;
    const eff = effectiveScope(scopeFromSnapshot(proj.baseline_snapshot));
    expect(eff.blockers).toEqual([]); // nothing left to resolve at Sale creation
    const q = Object.fromEntries(eff.lines.filter((l) => l.sku.startsWith("TEST-")).map((l) => [l.sku, l.quantity]));
    // the SKU-backed LED is already mapped through its own components, so the (stale) library mapping for led_light does not replace them
    expect(q).toEqual({ "TEST-M75-SYSTEM": 12, "TEST-M75-MOTOR": 24, "TEST-PEN-ROLL": 12, "TEST-PEN-POST": 120 });
    const led = Object.fromEntries(eff.lines.filter((l) => ["HNQ7046", "HNQ7093", "HNQ7088"].includes(l.sku)).map((l) => [l.sku, l.quantity]));
    expect(led).toEqual({ HNQ7046: 456, HNQ7093: 1368, HNQ7088: 456 }); // 1 luminaire + 3 clips + 1 cable per light
    expect(eff.referenceOnly).toEqual([]); // no BOM classification exists any more
    expect(((proj.baseline_snapshot as { physicalScope: Array<{ id: string; resolution?: { mappingRef?: unknown } }> }).physicalScope).find((i) => i.id === "penning_package:UNMAPPED")!.resolution!.mappingRef).toEqual({ packageKey: "penning_package", version: 1 });
  });
  it("14: another organisation's mappings are never applied", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001");
    db.rows("newquip_package_mappings").push(map("other-org", "flex_auger", 1, [{ sku: "TEST-LEAK", factor: 1 }]), map(ORG, "led_light", 1, [{ sku: "TEST-FORTIS-LED", factor: 1 }]));
    const q0 = db.rows("newquip_quotes")[0] as { revision: number; draft_hash: string };
    expect((await approveGrowerQuoteAction("q1", managerExceptionOpts(q0 as never))).ok).toBe(true);
    const q = db.rows("newquip_quotes")[0].accepted_baseline as { physicalScope: Array<{ id: string; resolution?: unknown }> };
    expect(q.physicalScope.find((i) => i.id === "flex_auger:UNMAPPED")!.resolution).toBeUndefined();
  });
  it("1: the live scope view applies active mappings to an in-progress quote and reports what is still missing", async () => {
    const db = h.db as FakeDb; seedQuote(db, "q1", "NQ-Q-0001"); db.rows("newquip_quotes")[0].state = "DRAFT";
    db.rows("newquip_package_mappings").push(map(ORG, "penning_package", 1, [{ sku: "TEST-PEN-ROLL", factor: 0.05 }]));
    const v = await getQuoteScopeAction("q1");
    expect(v.data).toMatchObject({ frozen: false, unresolvedCount: 1, canManageMappings: true }); // penning is mapped; the SKU-backed LED was never missing: only M75 is still unmapped
    const ctrl = await seedAndScope(db, ctrlDraft); // ...and a selected controller with no mapping is reported as one more missing product
    expect(ctrl).toBe(2);
    expect(v.data!.saleLines.find((l) => l.sku === "TEST-PEN-ROLL")!.quantity).toBe(12);
  });
});

describe("saving a reusable mapping", () => {
  it("is manager-only (a plain member is refused and nothing is stored)", async () => {
    h.admin = false;
    const r = await saveReusableMappingAction("penning_package", [{ sku: "TEST-PEN-ROLL", factor: 0.05 }], "per BOM sheet");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Only a manager/) });
    expect((h.db as FakeDb).rows("newquip_package_mappings")).toHaveLength(0);
  });
  it("refuses unless the single expected NewQuip Cin7 instance is the active one (cannot verify SKUs elsewhere)", async () => {
    const r = await saveReusableMappingAction("penning_package", [{ sku: "TEST-PEN-ROLL", factor: 0.05 }], "per BOM sheet");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/single expected NewQuip POC Cin7 instance/);
  });
});
