import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { seedGoldenCatalogue, seedGoldenLibrary } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { baselineMatchesHash } from "@/newquip/quote/baseline";
import { scopeFromSnapshot } from "@/lib/projects/product-scope";
import { createQuote, estimatorSignOff, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { LED_MAPPED_SKU, ledLibraryMapping } from "@/newquip/grower/__tests__/baseline-exception-fixture";

// ROUND 4 test gaps. (a) A suite that deliberately starts from an EMPTY mapping library for the WHOLE flow (Rep submit -> Estimator sign-off -> Manager), because every other suite starts from
// seedGoldenCatalogue's mapped library and so can never meet the unmapped-catalogue path. (b) Project creation from a REAL excepted baseline: sealed through approveGrowerQuoteAction(..., {baselineException}),
// then the real createProjectFromGrowerQuoteAction. Real stores and actions over the in-memory database; only the session is replaced.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as grower from "../actions";

const ORG = "org-nq";
const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
// The Estimator typed a price for the LED catalogue line (estimator_resolution) and recorded the accepted-incomplete-cost exception, so SIGN-OFF is allowed (its gating is unchanged);
// M75 and penning are Estimator-priced by design. Nothing is mapped in the library.
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, ctx(true)).budget!.totals.subtotalExTax * 100);
const REASON = "M75 and penning are Estimator-priced by design; the library follows the customer PO";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const quote = () => db.rows("newquip_quotes")[0] as Row;
const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(db.tables).filter(([, rows]) => rows.length > 0)));
const as = (admin: boolean) => {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u1@nq" } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
};
const req = () => ({ reason: REASON, expectedRevision: quote().revision, expectedDraftHash: quote().draft_hash });

/** The whole journey from an EMPTY library: Rep creates and submits, the Estimator signs off (REAL stores). */
async function journey(library: "empty" | "led" | "all") {
  db = new FakeDb(); db.fxApplied = true;
  seedGoldenCatalogue(db as never, ORG);
  db.tables.newquip_package_mappings = []; // seedGoldenCatalogue's mapped library is removed: the catalogue/LED line is UNMAPPED
  if (library === "led") db.tables.newquip_package_mappings = [ledLibraryMapping(ORG)];
  if (library === "all") seedGoldenLibrary(db as never, ORG);
  const rep = rolesFor("member");
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, rep, id, draft);
  await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx(true), { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx(true));
  expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_by_email: "est@nq" });
  return id;
}

describe("(a) the unmapped CATALOGUE path, whole flow from an EMPTY library", () => {
  it("Rep submit and Estimator sign-off are ALLOWED with the LED line unmapped; the cost-entitled view names it (this is what the visible Estimator notice renders)", async () => {
    const id = await journey("empty");
    as(true);
    const v = (await grower.getGrowerQuoteAction(id)).data!;
    expect(v.baselineException?.blocking).toEqual([{ label: expect.stringMatching(/LED/), pricedBy: "estimator_resolution" }]);
    expect(v.baselineException?.baselineExceptionRequired).toBe(false);
    expect(v.baselineException?.items.map((i) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    // a Rep-level caller never receives it
    as(false);
    expect((await grower.getGrowerQuoteAction(id)).data!.baselineException).toBeUndefined();
  });
  it("REFUSED: plain approval names the unmapped product and says an exception cannot cover it; nothing is written", async () => {
    const id = await journey("empty"); as(true);
    const before = snapshot();
    const r = await grower.approveGrowerQuoteAction(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3 package\(s\) are not mapped to Cin7 SKUs \(.*LED.*\).*need an active library mapping/);
    expect(snapshot()).toBe(before);
  });
  it("REFUSED: even with a Manager exception, the unmapped catalogue product keeps blocking (and it is named); nothing is written", async () => {
    const id = await journey("empty"); as(true);
    const before = snapshot();
    const r = await grower.approveGrowerQuoteAction(id, { baselineException: req() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot cover everything still unresolved: .*LED/);
    expect(snapshot()).toBe(before);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("EXCEPTION-APPROVED once the catalogue product is mapped: only M75 / penning are excepted", async () => {
    const id = await journey("led"); as(true);
    const v = (await grower.getGrowerQuoteAction(id)).data!;
    expect(v.baselineException).toMatchObject({ baselineExceptionRequired: true, blocking: [] });
    expect((await grower.approveGrowerQuoteAction(id, { baselineException: req() })).error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote().accepted_baseline.exceptions[0].unresolved.map((i: Row) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
  });
  it("MAPPED path: with every package mapped plain approval succeeds and no exception is sealed", async () => {
    const id = await journey("all"); as(true);
    expect((await grower.getGrowerQuoteAction(id)).data!.baselineException).toMatchObject({ baselineExceptionRequired: false, items: [], blocking: [] });
    expect((await grower.approveGrowerQuoteAction(id)).error).toBeUndefined();
    expect(quote().accepted_baseline.exceptions).toBeUndefined();
  });
});

describe("(b) PROJECT creation from a REAL excepted baseline", () => {
  it("the baseline sealed through approveGrowerQuoteAction(..., {baselineException}) becomes a Project; the exception travels with it and the unresolved scope is preserved, never silently mapped", async () => {
    const id = await journey("led"); as(true);
    expect((await grower.approveGrowerQuoteAction(id, { baselineException: req() })).error).toBeUndefined();
    const sealed = quote().accepted_baseline;
    expect(sealed.exceptions).toHaveLength(1);
    expect(baselineMatchesHash(sealed, quote().baseline_hash)).toBe(true);

    const r = await grower.createProjectFromGrowerQuoteAction(id);
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ created: true });
    const project = db.rows("projects").find((p) => p.id === r.data!.projectId)!;
    expect(project).toBeTruthy();
    expect(quote().project_id).toBe(project.id);

    // the project's baseline reference: the seal that covers the exception, plus what was accepted, why, by whom and for which version
    const prov = (project.baseline_snapshot as Row).provenance;
    expect(prov).toMatchObject({ baselineHash: quote().baseline_hash, quoteRef: quote().quote_ref });
    expect(prov.baselineExceptions).toHaveLength(1);
    expect(prov.baselineExceptions[0]).toMatchObject({ kind: "ESTIMATOR_PRICED_WITHOUT_CIN7_SKU", reason: REASON, approvedBy: "u1@nq", version: { quoteRef: quote().quote_ref, revision: quote().revision } });
    expect(prov.baselineExceptions[0].unresolved.map((i: Row) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);

    // the unresolved physical scope is inherited VERBATIM: M75 and penning stay UNMAPPED, the library-mapped LED line is mapped
    const scope = scopeFromSnapshot(project.baseline_snapshot);
    expect(scope).toEqual(sealed.physicalScope);
    // a library mapping is recorded as a RESOLUTION on the scope item; an item with none is genuinely unresolved
    const open = scope.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution);
    const unmapped = open.map((i) => i.id.replace(/:UNMAPPED$/, "")).sort();
    expect(unmapped).toEqual(["flex_auger", "penning_package"]);
    const led = scope.find((i) => i.id.startsWith("led_light"))!;
    expect(led.resolution).toMatchObject({ kind: "MAP_LINES" });
    expect(JSON.stringify(led.resolution)).toContain(LED_MAPPED_SKU);
    expect(open.every((i) => !i.sku || !i.sku.trim() || !i.resolution)).toBe(true); // M75 / penning: no SKU, no resolution invented
  });
  it("a baseline WITHOUT an exception carries no baselineExceptions on the project", async () => {
    const id = await journey("all"); as(true);
    expect((await grower.approveGrowerQuoteAction(id)).error).toBeUndefined();
    const r = await grower.createProjectFromGrowerQuoteAction(id);
    expect(r.error).toBeUndefined();
    expect(((db.rows("projects").find((p) => p.id === r.data!.projectId)!.baseline_snapshot as Row).provenance).baselineExceptions).toBeUndefined();
  });
});

describe("ROUND 4: each lost-race refusal names the step it belongs to", () => {
  // A conditional update that matches 0 rows (another writer moved the quotation first) is what each message guards. The update is forced to match nothing.
  const zeroRows = (d: FakeDb) => {
    const real = d.from.bind(d);
    (d as any).from = (t: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const b = real(t);
      if (t !== "newquip_quotes") return b;
      return new Proxy(b, { get: (o, k) => (k === "update" ? () => { const chain: any = new Proxy({}, { get: (_x, m) => (m === "select" ? async () => ({ data: [], error: null }) : () => chain) }); return chain; } : (o as any)[k]) }); // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return () => { (d as any).from = real; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };
  it("sending says 'while sending'; withdrawing a confirmation says 'while withdrawing the confirmation'; signing off says 'while signing off'; approving says 'during approval'", async () => {
    // sending (REP_DRAFT, Rep)
    db = new FakeDb(); db.fxApplied = true; seedGoldenCatalogue(db as never, ORG); seedGoldenLibrary(db as never, ORG);
    const rep = rolesFor("member"); const mgr = rolesFor("admin");
    const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, rep, id, draft);
    let undo = zeroRows(db);
    expect(await err(sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx(true), { confirmedAmountCents: total, confirmedBy: "Joe" }))).toBe("The quote changed while sending; refresh and try again.");
    undo();
    await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx(true), { confirmedAmountCents: total, confirmedBy: "Joe" });
    // withdrawing the confirmation
    const { invalidateConfirmation } = await import("@/lib/newquip-quotes/quote-store");
    undo = zeroRows(db);
    expect(await err(invalidateConfirmation(db as never, ORG, id, { email: "rep@nq", role: "rep" }))).toMatch(/while withdrawing the confirmation/);
    undo();
    // signing off
    undo = zeroRows(db);
    expect(await err(estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx(true)))).toBe("The quote changed or was signed off while signing off; refresh and try again.");
    undo();
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx(true));
    // approving
    const { managerApprove } = await import("@/lib/newquip-quotes/quote-store");
    undo = zeroRows(db);
    expect(await err(managerApprove(db as never, ORG, mgr, "mgr@nq", id, ctx(true), ctx(false)))).toBe("The quote changed during approval; refresh and review it again.");
    undo();
  });
});
