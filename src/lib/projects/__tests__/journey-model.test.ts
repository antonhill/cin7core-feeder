import { describe, expect, it } from "vitest";
import { buildJourney, buildProjectOverview, JOURNEY_FOOTNOTE, type Journey, type OverviewScopeInput, type PhysicalLoad } from "../overview-model";
import { R, approvedVariation, claim, demoInput, physRow, physSection, posting, progress, project, scope, stage } from "./overview-fixtures";
import type { VariationRow } from "../variations";

// buildJourney is PURE and reads only state the Overview already holds: no admin flag, no cost figure and no request is involved.
const physOf = (physical: PhysicalLoad, deliveries = demoInput().deliveries) => buildProjectOverview(demoInput({ physical, deliveries })).physical;
const NOT_READ = physOf({ state: "not_loaded" });
const journeyOf = (scopes: OverviewScopeInput[], physical = NOT_READ): Journey => buildJourney({ scopes, physical });
const st = (j: Journey, id: string) => {
  const all = [...j.setup, ...j.lanes.flatMap((l) => l.stations)];
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error(`no station ${id}: ${all.map((x) => x.id).join(", ")}`);
  return s;
};
const variation = (code: string, status: string, over: Partial<VariationRow> = {}): VariationRow => ({ ...approvedVariation(R(1000)), id: `id-${code}`, code, title: `Title ${code}`, status, ...over });
const base = (o: { claims?: ReturnType<typeof claim>[]; postings?: ReturnType<typeof posting>[]; events?: ReturnType<typeof progress>[]; variations?: VariationRow[]; sale?: string | null; blockers?: string[]; proj?: Partial<Parameters<typeof project>[0]> } = {}) =>
  scope({ project: project({ id: "b", project_reference: "PRJ-B", original_contract_cents: R(1000), ...o.proj }), stages: [stage("s1", 1, "All", R(1000))], events: o.events, claims: o.claims, postings: o.postings, variations: o.variations, saleNumber: o.sale === undefined ? "SO-1" : o.sale, blockers: o.blockers });
const varScope = (code: string, o: { claims?: ReturnType<typeof claim>[]; postings?: ReturnType<typeof posting>[]; events?: ReturnType<typeof progress>[] } = {}) =>
  scope({ project: project({ id: `p-${code}`, project_reference: `PRJ-B-${code}`, original_contract_cents: R(1000), billing_scope: "VARIATION", parent_project_id: "b", variation_id: `id-${code}` }), stages: [stage(`vs-${code}`, 1, "V", R(1000))], events: o.events, claims: o.claims, postings: o.postings, variationCode: code, saleNumber: null });

describe("Project Journey - structure", () => {
  it("has a Setup strip, exactly three lanes and one footnote line, and no completion station anywhere", () => {
    const j = journeyOf(demoInput().scopes);
    expect(j.setup.map((s) => s.id)).toEqual(["setup-details", "setup-schedule", "setup-opening"]);
    expect(j.lanes.map((l) => l.id)).toEqual(["commercial", "physical", "variations"]);
    expect(j.lanes[0].stations.map((s) => s.label)).toEqual(["Cin7 Sale", "Stage progress", "Commercial billing", "Post to Cin7", "Invoice authorisation"]);
    expect(j.lanes[1].stations.map((s) => s.label)).toEqual(["Deliveries", "Fulfilment", "Procurement", "Milestone confirmations"]);
    expect(j.footnote).toBe(JOURNEY_FOOTNOTE);
    const all = JSON.stringify(j).toLowerCase();
    expect(all).not.toMatch(/project (is )?(complete|closed)|handover complete|closed out/);
  });
  it("never names stock fulfilment in an invoicing station or invoicing in a stock station (no dependency between them)", () => {
    const j = journeyOf([base({ claims: [claim("c1", 1, "APPROVED", R(500))], postings: [] })]);
    const text = (ids: string[]) => ids.map((i) => JSON.stringify(st(j, i))).join(" ").toLowerCase();
    expect(text(["commercial-posting", "commercial-authorisation", "commercial-billing"])).not.toMatch(/stock|fulfil|ship|deliver/);
    expect(text(["physical-fulfilment", "physical-procurement", "physical-deliveries"])).not.toMatch(/invoice|claim|billing|post/);
  });
});

describe("Project Journey - Setup", () => {
  it("Project details is informational: none/some/all of manager, start and target set; never has a Needs line", () => {
    const none = st(journeyOf([base()]), "setup-details");
    expect(none).toMatchObject({ status: "not_started", informational: true, needs: [] });
    expect(st(journeyOf([base({ proj: { project_manager: "Pat" } })]), "setup-details")).toMatchObject({ status: "in_progress" });
    expect(st(journeyOf([base({ proj: { project_manager: "Pat" } })]), "setup-details").detail).toContain("1 of 3");
    expect(st(journeyOf([base({ proj: { project_manager: "Pat", start_date: "2026-11-01", target_completion_date: "2027-01-01" } })]), "setup-details")).toMatchObject({ status: "completed" });
    expect(st(journeyOf([base({ proj: { project_manager: "  " } })]), "setup-details").status).toBe("not_started");
  });
  it("Billing schedule: balanced = completed, unbalanced = needs attention", () => {
    expect(st(journeyOf([base()]), "setup-schedule").status).toBe("completed");
    const unbalanced = scope({ project: project({ id: "b", project_reference: "P", original_contract_cents: R(1000) }), stages: [stage("s1", 1, "All", R(600))] });
    expect(st(journeyOf([unbalanced]), "setup-schedule").status).toBe("needs_attention");
  });
  it("Opening commitments: optional while none; locked once a claim exists, with the real 'locks at first claim' dependency while open", () => {
    const open = st(journeyOf([base()]), "setup-opening");
    expect(open.status).toBe("not_started");
    expect(open.detail).toMatch(/Optional/);
    expect(open.needs.join(" ")).toMatch(/before the first claim/);
    const locked = st(journeyOf([base({ claims: [claim("c1", 1, "DRAFT", R(100))] })]), "setup-opening");
    expect(locked.status).toBe("completed");
    expect(locked.detail).toMatch(/locked/);
    expect(locked.needs).toEqual([]);
  });
});

describe("Project Journey - Commercial lane", () => {
  it("Cin7 Sale: linked is completed", () => {
    expect(st(journeyOf([base({ sale: "SO-9" })]), "commercial-sale")).toMatchObject({ status: "completed", unknown: false });
  });
  it("Cin7 Sale: unresolved scope is in progress with the real Needs line; the Sale-creation row is NOT inferred when scope is clear (unknown)", () => {
    const blocked = st(journeyOf([base({ sale: null, blockers: ["a", "b"] })]), "commercial-sale");
    expect(blocked).toMatchObject({ status: "in_progress", unknown: false });
    expect(blocked.needs[0]).toMatch(/scope items resolved \(2 outstanding\)/);
    const clear = st(journeyOf([base({ sale: null })]), "commercial-sale");
    expect(clear.unknown).toBe(true);
    expect(clear.link?.tab).toBe("claims");
    expect(clear.detail).toMatch(/read on the Claims tab/);
  });
  it("Stage progress: not started, in progress, completed, and needs attention when approval sits below committed", () => {
    expect(st(journeyOf([base()]), "commercial-stages").status).toBe("not_started");
    expect(st(journeyOf([base({ events: [progress("s1", 5000, 5000)] })]), "commercial-stages").status).toBe("in_progress");
    const full = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))] });
    expect(st(journeyOf([full]), "commercial-stages").status).toBe("completed");
    const below = base({ events: [progress("s1", 5000, 5000)], claims: [claim("c1", 1, "APPROVED", R(800))] });
    expect(st(journeyOf([below]), "commercial-stages")).toMatchObject({ status: "needs_attention" });
  });
  it("Commercial billing: none, drafts/submitted in progress, uncertain = Blocked with its Needs line, reconciled postings with every stage billed = completed", () => {
    expect(st(journeyOf([base()]), "commercial-billing").status).toBe("not_started");
    expect(st(journeyOf([base()]), "commercial-billing").detail).toMatch(/Nothing is claimable/);
    const open = st(journeyOf([base({ claims: [claim("c1", 1, "DRAFT", R(100)), claim("c2", 2, "READY_FOR_APPROVAL", R(100))] })]), "commercial-billing");
    expect(open.status).toBe("in_progress");
    expect(open.detail).toContain("2 claims are still being prepared or awaiting approval");
    const uncertain = st(journeyOf([base({ claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))] })]), "commercial-billing");
    expect(uncertain.status).toBe("blocked");
    expect(uncertain.needs[0]).toMatch(/uncertain claim resolved/);
    const done = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true)] });
    expect(st(journeyOf([done]), "commercial-billing")).toMatchObject({ status: "completed", detail: "Commercial billing complete - 1 claim posted and reconciled." });
    const some = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(400))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true)] });
    const s2 = st(journeyOf([some]), "commercial-billing");
    expect(s2.status).toBe("in_progress");
    expect(s2.detail).toContain("ot every stage is fully billed yet");
  });
  it("Post to Cin7: needs a linked Sale (Blocked when approved claims wait), attention on failure/uncertain/mismatch, in progress until reconciled, completed when every live claim is RECONCILED", () => {
    const approved = [claim("c1", 1, "APPROVED", R(500))];
    const noSale = st(journeyOf([base({ claims: approved, sale: null })]), "commercial-posting");
    expect(noSale.status).toBe("blocked");
    expect(noSale.needs[0]).toMatch(/linked Cin7 Sale before a claim can be posted/);
    const ready = st(journeyOf([base({ claims: approved })]), "commercial-posting");
    expect(ready).toMatchObject({ status: "in_progress", needs: [] });
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false)] })]), "commercial-posting").status).toBe("needs_attention");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "FAILED_CONFIRMED_NO_WRITE", null, null, false)] })]), "commercial-posting").status).toBe("needs_attention");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "PENDING", null, null, false)] })]), "commercial-posting").status).toBe("in_progress");
    const created = st(journeyOf([base({ claims: approved, postings: [posting("c1", "CREATED", "INV-1", "DRAFT", false)] })]), "commercial-posting");
    expect(created).toMatchObject({ status: "in_progress" });
    expect(created.detail).toContain("1 awaiting reconciliation");
    const mismatch = st(journeyOf([base({ claims: approved, postings: [{ ...posting("c1", "CREATED", "INV-1", "DRAFT", false), last_error_code: "AMOUNT_MISMATCH" }] })]), "commercial-posting");
    expect(mismatch.status).toBe("needs_attention");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "RECONCILED", "INV-1", "DRAFT", true)] })]), "commercial-posting").status).toBe("completed");
    expect(st(journeyOf([base()]), "commercial-posting").status).toBe("not_started");
  });
  it("Invoice authorisation: with nothing verified it is 'Not verified' (never success) and shows the recorded snapshot as a record", () => {
    const one = base({ claims: [claim("c1", 1, "APPROVED", R(500)), claim("c2", 2, "APPROVED", R(300))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true), posting("c2", "RECONCILED", "INV-2", "DRAFT", true)] });
    const s = st(journeyOf([one]), "commercial-authorisation");
    expect(s).toMatchObject({ unknown: true, statusLabel: "Not verified" });
    expect(s.status).not.toBe("completed");
    expect(s.detail).toContain("Last recorded");
    expect(s.detail).toMatch(/1 authorised, 1 draft|1 draft, 1 authorised/);
    expect(s.detail).toContain("not verified");
    const none = st(journeyOf([base()]), "commercial-authorisation");
    expect(none).toMatchObject({ status: "not_started", unknown: false });
  });
});

describe("Project Journey - review fixes", () => {
  const fullyBilled = () => ({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true)] });
  it("BASE progress claims is Completed when the original contract is fully billed and reconciled, even with an approved variation that has no billing scope yet", () => {
    const j = journeyOf([base({ ...fullyBilled(), variations: [variation("V001", "APPROVED")] })]);
    expect(st(j, "commercial-billing").status).toBe("completed");
    expect(st(j, "commercial-stages").status).toBe("completed");
    expect(st(j, "variation-V001").status).toBe("needs_attention");
  });
  it("posting copy separates retryable from uncertain, in both lanes, and never says 'failed'", () => {
    const retry = journeyOf([base({ claims: [claim("c1", 1, "APPROVED", R(500))], postings: [posting("c1", "FAILED_CONFIRMED_NO_WRITE", null, null, false)] })]);
    expect(st(retry, "commercial-posting").detail).toBe("1 invoice not created in Cin7 (can be retried).");
    const unc = journeyOf([base({ claims: [claim("c1", 1, "APPROVED", R(500))], postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false)] })]);
    expect(st(unc, "commercial-posting").detail).toBe("1 invoice with an uncertain outcome: check Cin7 before doing anything.");
    const vs = [variation("V001", "APPROVED")];
    const v = journeyOf([base({ variations: vs }), varScope("V001", { claims: [claim("vc1", 1, "APPROVED", R(500))], postings: [posting("vc1", "FAILED_CONFIRMED_NO_WRITE", null, null, false)] })]);
    expect(st(v, "variation-V001").detail).toContain("not created in Cin7 (can be retried)");
    expect(JSON.stringify([retry, unc, v]).toLowerCase()).not.toContain("failed");
  });
  it("an uncertain claim has the same status (Blocked) in the Commercial lane and for a variation", () => {
    const vs = [variation("V001", "APPROVED")];
    const j = journeyOf([base({ variations: vs, claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))] }), varScope("V001", { claims: [claim("vc1", 1, "FAILED_UNCERTAIN", R(100))] })]);
    expect(st(j, "commercial-billing").status).toBe("blocked");
    expect(st(j, "variation-V001").status).toBe("blocked");
  });
  it("Deliveries mentions cancelled deliveries and does not subtract them twice (total already excludes them)", () => {
    const d = (deliveries: Parameters<typeof physOf>[1]) => st(journeyOf([base()], physOf({ state: "not_loaded" }, deliveries)), "physical-deliveries");
    const allCancelled = d({ total: 0, dispatched: 0, inProgress: 0, cancelled: 2, latestActivityAt: null });
    expect(allCancelled).toMatchObject({ status: "not_started", detail: "No live deliveries; 2 cancelled." });
    expect(d({ total: 2, dispatched: 2, inProgress: 0, cancelled: 1, latestActivityAt: null })).toMatchObject({ status: "completed", detail: "All 2 deliveries dispatched (1 cancelled)." });
    expect(d({ total: 3, dispatched: 1, inProgress: 2, cancelled: 1, latestActivityAt: null })).toMatchObject({ status: "in_progress", detail: "1 of 3 dispatched (1 cancelled)." });
  });
  it("Procurement with no physical products is Not started; a locked opening-commitments station reads 'Locked'; Post to Cin7 with no Sale is a soft Blocked", () => {
    const none = journeyOf([base()], physOf({ state: "loaded", asOf: null, sections: [physSection([])] }));
    expect(st(none, "physical-procurement").status).toBe("not_started");
    expect(st(journeyOf([base({ claims: [claim("c1", 1, "DRAFT", R(100))] })]), "setup-opening").statusLabel).toBe("Locked");
    const blocked = st(journeyOf([base({ claims: [claim("c1", 1, "APPROVED", R(500))], sale: null })]), "commercial-posting");
    expect(blocked).toMatchObject({ status: "blocked", soft: true });
  });
});

describe("Project Journey - Physical lane (unknown is never zero)", () => {
  it("nothing read: Fulfilment, Procurement and Milestone confirmations are unknown, with links to the tab that reads them", () => {
    const j = journeyOf([base()]);
    for (const [id, tab] of [["physical-fulfilment", "physical"], ["physical-procurement", "procurement"], ["physical-milestones", "deliveries"]] as const) {
      expect(st(j, id)).toMatchObject({ unknown: true, status: "not_started" });
      expect(st(j, id).link?.tab).toBe(tab);
      expect(st(j, id).detail).not.toMatch(/\b0\b/);
    }
    expect(st(j, "physical-milestones").detail).toMatch(/does not release claimable value/);
    expect(j.lanes[1].summary.unknown).toBe(2); // Milestone confirmations is permanently unknown here and is not counted
    expect(st(j, "physical-milestones").permanentUnknown).toBe(true);
  });
  it("a failed read is unknown, not 'nothing to ship'", () => {
    const j = journeyOf([base()], physOf({ state: "error", error: "boom" }));
    expect(st(j, "physical-fulfilment")).toMatchObject({ unknown: true });
    expect(st(j, "physical-procurement")).toMatchObject({ unknown: true });
  });
  it("Deliveries: unreadable = unknown, none, in progress, all dispatched", () => {
    const d = (deliveries: Parameters<typeof physOf>[1]) => st(journeyOf([base()], physOf({ state: "not_loaded" }, deliveries)), "physical-deliveries");
    expect(d(null)).toMatchObject({ unknown: true });
    expect(d({ total: 0, dispatched: 0, inProgress: 0, cancelled: 0, latestActivityAt: null }).status).toBe("not_started");
    expect(d({ total: 3, dispatched: 1, inProgress: 2, cancelled: 0, latestActivityAt: null })).toMatchObject({ status: "in_progress", detail: "1 of 3 dispatched." });
    expect(d({ total: 2, dispatched: 2, inProgress: 0, cancelled: 0, latestActivityAt: null }).status).toBe("completed");
  });
  it("Fulfilment and Procurement from a loaded read: shipped, shortfall, unreadable lines", () => {
    const load = (rows: ReturnType<typeof physRow>[]) => physOf({ state: "loaded", asOf: "2026-11-01T00:00:00Z", sections: [physSection(rows)] });
    const short = journeyOf([base()], load([physRow("A", { ordered: 10, shipped: 4, remaining: 6, shortfall: 2 })]));
    expect(st(short, "physical-fulfilment")).toMatchObject({ status: "in_progress", unknown: false });
    expect(st(short, "physical-procurement").status).toBe("needs_attention");
    const done = journeyOf([base()], load([physRow("A", { ordered: 10, shipped: 10, remaining: 0, shortfall: 0 })]));
    expect(st(done, "physical-fulfilment").status).toBe("completed");
    expect(st(done, "physical-procurement").status).toBe("completed");
    const unreadable = journeyOf([base()], load([physRow("A", { ordered: 10, shipped: null, remaining: null, shortfall: null, available: null })]));
    expect(st(unreadable, "physical-fulfilment").status).toBe("in_progress");
    expect(st(unreadable, "physical-fulfilment").detail).toMatch(/could not be read/);
    expect(st(unreadable, "physical-procurement").status).toBe("in_progress"); // a shortfall cannot be ruled ou
    const none = journeyOf([base()], load([physRow("A", { ordered: 10, shipped: 0, remaining: 10, shortfall: 0 })]));
    expect(st(none, "physical-fulfilment").status).toBe("not_started");
    expect(st(journeyOf([base()], load([])), "physical-fulfilment").status).toBe("not_started");
  });
  it("fulfilment does not change with billing and billing does not change with fulfilment", () => {
    const billed = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))], postings: [posting("c1", "RECONCILED", "INV", "AUTHORISED", true)] });
    const a = journeyOf([billed], NOT_READ);
    const b = journeyOf([billed], physOf({ state: "loaded", asOf: null, sections: [physSection([physRow("A", { shipped: 0, remaining: 10, shortfall: 0 })])] }));
    expect(a.lanes[0]).toEqual(b.lanes[0]);
    const unbilled = journeyOf([base()], physOf({ state: "loaded", asOf: null, sections: [physSection([physRow("A", { shipped: 0, remaining: 10, shortfall: 0 })])] }));
    expect(unbilled.lanes[1]).toEqual(b.lanes[1]);
  });
});

describe("Project Journey - Variations lane", () => {
  it("no variations: an empty lane, not a station", () => {
    expect(journeyOf([base()]).lanes[2].stations).toEqual([]);
  });
  it("one station per variation by status; an approved variation with no billing project needs attention and names its own start link", () => {
    const vs = [variation("V001", "DRAFT"), variation("V002", "APPROVED"), variation("V003", "REJECTED")];
    const j = journeyOf([base({ variations: vs })]);
    expect(j.lanes[2].stations.map((s) => s.id)).toEqual(["variation-V001", "variation-V002", "variation-V003"]);
    expect(st(j, "variation-V001").status).toBe("not_started");
    expect(st(j, "variation-V002")).toMatchObject({ status: "needs_attention", link: { tab: "variations", label: "Start V002 billing" } });
    expect(st(j, "variation-V002").detail).toMatch(/no billing project/);
    expect(st(j, "variation-V003")).toMatchObject({ status: "not_started", statusLabel: "Rejected" });
  });
  it("a billing project open with no claims is in progress; fully reconciled is completed; uncertain/unbalanced is attention", () => {
    const vs = [variation("V001", "APPROVED")];
    expect(st(journeyOf([base({ variations: vs }), varScope("V001")]), "variation-V001")).toMatchObject({ status: "in_progress", detail: "Title V001: billing project open; no claims raised yet." });
    const done = varScope("V001", { events: [progress("vs-V001", 10000, 10000)], claims: [claim("vc1", 1, "APPROVED", R(1000))], postings: [posting("vc1", "RECONCILED", "INV-V", "AUTHORISED", true)] });
    expect(st(journeyOf([base({ variations: vs }), done]), "variation-V001").status).toBe("completed");
    const uncertain = varScope("V001", { claims: [claim("vc1", 1, "FAILED_UNCERTAIN", R(500))] });
    const u = st(journeyOf([base({ variations: vs }), uncertain]), "variation-V001");
    expect(u.status).toBe("blocked"); // same state, same status as the Commercial lane
    expect(u.needs[0]).toMatch(/uncertain claim resolved/);
  });
  it("BASE vs VARIATION isolation: a variation's claims never move a base station, and base claims never move a variation station", () => {
    const vs = [variation("V001", "APPROVED")];
    const noisyVar = varScope("V001", { claims: [claim("vc1", 1, "FAILED_UNCERTAIN", R(500))], postings: [posting("vc1", "FAILED_UNCERTAIN", null, null, false)] });
    const quiet = journeyOf([base({ variations: vs }), varScope("V001")]);
    const noisy = journeyOf([base({ variations: vs }), noisyVar]);
    expect(noisy.lanes[0]).toEqual(quiet.lanes[0]);
    expect(noisy.setup).toEqual(quiet.setup);
    const noisyBase = base({ variations: vs, claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))], postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false)] });
    expect(st(journeyOf([noisyBase, varScope("V001")]), "variation-V001")).toEqual(st(quiet, "variation-V001"));
    // two variations: only the matching code's scope is read
    const two = journeyOf([base({ variations: [variation("V001", "APPROVED"), variation("V002", "APPROVED")] }), noisyVar]);
    expect(st(two, "variation-V001").status).toBe("blocked");
    expect(st(two, "variation-V002").status).toBe("needs_attention");
    expect(st(two, "variation-V002").detail).toMatch(/no billing project/);
  });
});

describe("Project Journey - lane summaries and missing base", () => {
  it("counts attention (needs attention + blocked), in progress and unknown; unknown stations are not counted as in progress", () => {
    const j = journeyOf([base({ claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))], sale: null })]);
    const s = j.lanes[0].summary;
    expect(s.attention).toBeGreaterThanOrEqual(1);
    expect(s.unknown).toBe(1); // the Sale: no link and nothing to say whether an attempt is in fligh
    expect(j.lanes[1].summary).toEqual({ attention: 0, inProgress: 1, unknown: 2 });
  });
  it("without a BASE scope every setup and commercial station is unknown (never a made-up status) and the variations lane is empty", () => {
    const j = journeyOf([]);
    expect(j.setup.every((s) => s.unknown)).toBe(true);
    expect(j.lanes[0].stations.every((s) => s.unknown)).toBe(true);
    expect(j.lanes[2].stations).toEqual([]);
  });
});

describe("Project Journey - role/cost safety", () => {
  it("never outputs any cost or margin figure, even when cost, margin and estimate data are loaded for an administrator", () => {
    const COST = 7_654_321_00;
    const vs = [variation("V001", "APPROVED", { estimated_cost_cents: COST })];
    const input = demoInput({ viewer: { isAdmin: true }, estimates: { revised: { revenueCents: 1, costCents: COST, gpCents: 123_456_78, marginPct: 33.79 } as never, incomplete: false, uncostedSellingCents: 0, exceptions: [{ code: "COST_UNKNOWN", scope: "S", message: "cost" }] } });
    const j = buildJourney({ scopes: [base({ variations: vs }), varScope("V001")], physical: buildProjectOverview(input).physical });
    const text = JSON.stringify(j);
    expect(text).not.toContain(String(COST));
    expect(text).not.toContain("12345678");
    expect(text).not.toContain("33.79");
    expect(text.toLowerCase()).not.toMatch(/estimated_cost|margin|gross profit|\bcost\b/);
  });
});

// ── UX-006d/g2: the journey follows the POSTING rows and stage ledger, never the claim status (which stays APPROVED after posting). Fixtures are SHAPED like the owner's
// project (three fully billed stages, four APPROVED claims with RECONCILED postings recorded DRAFT/DRAFT/DRAFT/AUTHORISED, one CANCELLED claim; a variation billed in full
// with no physical lines) but are synthetic and keyed on nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedRef } from "../invoice-authorisation";

const ownerBase = (over: { postings?: ReturnType<typeof posting>[]; claims?: ReturnType<typeof claim>[]; stages?: ReturnType<typeof stage>[]; lines?: Array<{ claim_id: string; stage_id: string; current_claim_cents: number }> } = {}) => {
  const stages = over.stages ?? [stage("s-dep", 1, "Deposit", R(400)), stage("s-del", 2, "Delivery", R(550)), stage("s-ins", 3, "Installation", R(50))];
  const claims = over.claims ?? [claim("c1", 1, "APPROVED", R(400)), claim("c2", 2, "CANCELLED_BEFORE_WRITE", R(550)), claim("c3", 3, "APPROVED", R(550)), claim("c4", 4, "APPROVED", R(0.5)), claim("c5", 5, "APPROVED", R(50))];
  return scope({
    project: project({ id: "ob", project_reference: "PRJ-O", original_contract_cents: R(1000) }), stages, claims,
    lines: over.lines ?? [{ claim_id: "c1", stage_id: "s-dep", current_claim_cents: R(400) }, { claim_id: "c2", stage_id: "s-del", current_claim_cents: R(550) }, { claim_id: "c3", stage_id: "s-del", current_claim_cents: R(549.5) }, { claim_id: "c4", stage_id: "s-del", current_claim_cents: R(0.5) }, { claim_id: "c5", stage_id: "s-ins", current_claim_cents: R(50) }],
    events: stages.map((s) => progress(s.id, 10000, 10000)),
    postings: over.postings ?? [posting("c1", "RECONCILED", "INV-1", "DRAFT", true), posting("c3", "RECONCILED", "INV-3", "DRAFT", true), posting("c4", "RECONCILED", "INV-4", "DRAFT", true), posting("c5", "RECONCILED", "INV-5", "AUTHORISED", true)],
    variations: [variation("V001", "APPROVED", { amount_cents: R(500) })], saleNumber: "SO-1",
  });
};
const ownerVariation = (postings = [posting("vc1", "RECONCILED", "INV-V", "DRAFT", true)], committed = R(500)) => scope({
  project: project({ id: "ov", project_reference: "PRJ-O-V001", original_contract_cents: R(500), billing_scope: "VARIATION", parent_project_id: "ob", variation_id: "id-V001" }),
  stages: [stage("vs", 1, "Variation", R(500))], events: [progress("vs", 10000, 10000)], claims: [claim("vc1", 1, "APPROVED", committed)], postings, variationCode: "V001", saleNumber: "SO-2",
});
const ref = (claimId: string, invoiceNumber: string, currentStatus: string | null, outcome: "SAME" | "CHANGED" = "CHANGED", at = "2026-11-02T10:00:00Z"): VerifiedRef => ({ verifiedAt: at, invoice: { postingId: `p-${claimId}`, claimId, invoiceNumber, recordedStatus: "DRAFT", currentStatus, outcome } });
const verifyAll = (status = "AUTHORISED"): { verifiedByClaimId: Record<string, VerifiedRef | undefined>; failedClaimIds: string[] } => ({ verifiedByClaimId: { c1: ref("c1", "INV-1", status), c3: ref("c3", "INV-3", status), c4: ref("c4", "INV-4", status), c5: ref("c5", "INV-5", status), vc1: ref("vc1", "INV-V", status) }, failedClaimIds: [] });
const oldRule = (v: OverviewScopeInput["view"]) => v.claims.length > 0 && v.claims.every((c) => ["RECONCILED", "FAILED_CONFIRMED_NO_WRITE", "CANCELLED_BEFORE_WRITE"].includes(c.status)) && v.claims.some((c) => c.status === "RECONCILED");

describe("Project Journey - commercial billing follows postings (owner-shaped)", () => {
  const owner = () => [ownerBase(), ownerVariation()];
  it("BASE and V001 are Commercial billing complete; the OLD claim-status rule would have said In progress on the same data", () => {
    const [b, v] = owner();
    expect(oldRule(b.view)).toBe(false); // claims are APPROVED, not RECONCILED, after posting: the old station could never complete
    expect(oldRule(v.view)).toBe(false);
    const j = journeyOf([b, v]);
    expect(st(j, "commercial-billing")).toMatchObject({ status: "completed", detail: "Commercial billing complete - 4 claims posted and reconciled." });
    expect(st(j, "commercial-posting")).toMatchObject({ status: "completed" });
    expect(st(j, "variation-V001").status).toBe("completed");
    expect(st(j, "variation-V001").detail).toMatch(/commercial billing complete - .*500.* billed, .*0,00 remaining, 1 invoice reconciled/);
    expect(JSON.stringify(j.lanes[0]).toLowerCase()).not.toMatch(/physical|fulfil/);
    expect(st(j, "variation-V001").label).toBe("V001 commercial billing");
  });
  it("physical stays independent: billing complete with deliveries unknown / incomplete / nothing read leaves the Physical lane exactly as it was", () => {
    const unbilled = journeyOf([base()]);
    const billed = journeyOf(owner());
    expect(billed.lanes[1]).toEqual(unbilled.lanes[1]);
    expect(st(billed, "physical-fulfilment")).toMatchObject({ unknown: true });
    const partlyShipped = physOf({ state: "not_loaded" }, { total: 3, dispatched: 1, inProgress: 2, cancelled: 0, latestActivityAt: null });
    const j = journeyOf(owner(), partlyShipped);
    expect(st(j, "commercial-billing").status).toBe("completed");
    expect(st(j, "physical-deliveries").status).toBe("in_progress");
    expect(journeyOf(owner(), physOf({ state: "not_loaded" }, null)).lanes[1].stations[0].unknown).toBe(true);
  });
  it("invoice authorisation: nothing verified is 'Not verified' with the recorded snapshot (never success), for BASE and the variation line", () => {
    const j = journeyOf(owner());
    const a = st(j, "commercial-authorisation");
    expect(a).toMatchObject({ unknown: true, statusLabel: "Not verified" });
    expect(a.detail).toMatch(/3 draft, 1 authorised/);
    expect(a.detail).toMatch(/recorded snapshot, not verified/);
    expect(st(j, "variation-V001").lines?.[0]).toMatch(/^Invoice authorisation: Not verified\./);
  });
  it("invoice authorisation: verified AUTHORISED for ALL live invoices is Completed with the time; mixed shows N of M; a failed read says 'Could not verify'", () => {
    const j = buildJourney({ scopes: owner(), physical: NOT_READ, verification: verifyAll() });
    const a = st(j, "commercial-authorisation");
    expect(a).toMatchObject({ status: "completed", unknown: false, statusLabel: "Authorised (verified)" });
    expect(a.detail).toContain("Authorised in Cin7 - verified");
    expect(st(j, "variation-V001").lines?.[0]).toContain("Authorised in Cin7 - verified");
    const v = verifyAll();
    v.verifiedByClaimId.c5 = ref("c5", "INV-5", "DRAFT");
    const mixed = st(buildJourney({ scopes: owner(), physical: NOT_READ, verification: v }), "commercial-authorisation");
    expect(mixed).toMatchObject({ status: "in_progress" });
    expect(mixed.detail).toContain("3 of 4 authorised (verified");
    const failed = st(buildJourney({ scopes: owner(), physical: NOT_READ, verification: { verifiedByClaimId: {}, failedClaimIds: ["c1", "c3"] } }), "commercial-authorisation");
    expect(failed).toMatchObject({ unknown: true, statusLabel: "Could not verify" });
    const onlyOne = verifyAll(); delete onlyOne.verifiedByClaimId.c3;
    expect(st(buildJourney({ scopes: owner(), physical: NOT_READ, verification: onlyOne }), "commercial-authorisation").status).not.toBe("completed");
    const missing = verifyAll(); missing.verifiedByClaimId.c1 = ref("c1", "INV-1", null, "SAME");
    expect(st(buildJourney({ scopes: owner(), physical: NOT_READ, verification: missing }), "commercial-authorisation").status).not.toBe("completed");
  });
  it("a verification that lists only the VARIATION's claim never completes BASE authorisation, and vice versa", () => {
    const only = { verifiedByClaimId: { vc1: ref("vc1", "INV-V", "AUTHORISED") }, failedClaimIds: [] };
    const j = buildJourney({ scopes: owner(), physical: NOT_READ, verification: only });
    expect(st(j, "commercial-authorisation").unknown).toBe(true);
    expect(st(j, "variation-V001").lines?.[0]).toContain("Authorised in Cin7 - verified");
    const baseOnly = { verifiedByClaimId: Object.fromEntries(Object.entries(verifyAll().verifiedByClaimId).filter(([k]) => k !== "vc1")), failedClaimIds: [] };
    const j2 = buildJourney({ scopes: owner(), physical: NOT_READ, verification: baseOnly });
    expect(st(j2, "commercial-authorisation").status).toBe("completed");
    expect(st(j2, "variation-V001").lines?.[0]).toMatch(/Not verified/);
  });
  it("partially billed: a stage not fully committed is In progress, not complete, even when every posting is reconciled", () => {
    const b = ownerBase({ stages: [stage("s-dep", 1, "Deposit", R(400)), stage("s-del", 2, "Delivery", R(550)), stage("s-ins", 3, "Installation", R(50))], claims: [claim("c1", 1, "APPROVED", R(400))], lines: [{ claim_id: "c1", stage_id: "s-dep", current_claim_cents: R(400) }], postings: [posting("c1", "RECONCILED", "INV-1", "DRAFT", true)] });
    const s = st(journeyOf([b]), "commercial-billing");
    expect(s.status).toBe("in_progress");
    expect(s.detail).toContain("ot every stage is fully billed yet");
    expect(st(journeyOf([b]), "commercial-stages").status).toBe("in_progress");
  });
  it("approved-unposted, uncertain and mismatch are each reported honestly (never complete)", () => {
    const allButOne = [posting("c1", "RECONCILED", "INV-1", "DRAFT", true), posting("c3", "RECONCILED", "INV-3", "DRAFT", true), posting("c4", "RECONCILED", "INV-4", "DRAFT", true)];
    const unposted = st(journeyOf([ownerBase({ postings: allButOne })]), "commercial-billing");
    expect(unposted.status).toBe("needs_attention");
    expect(unposted.detail).toContain("not posted to Cin7 yet");
    const unc = ownerBase({ claims: [claim("c1", 1, "APPROVED", R(400)), claim("c2", 2, "CANCELLED_BEFORE_WRITE", R(550)), claim("c3", 3, "APPROVED", R(550)), claim("c4", 4, "APPROVED", R(0.5)), claim("c5", 5, "FAILED_UNCERTAIN", R(50))], postings: [...allButOne, posting("c5", "FAILED_UNCERTAIN", null, null, false)] });
    expect(st(journeyOf([unc]), "commercial-billing").status).toBe("blocked");
    const mm = ownerBase({ postings: [...allButOne, { ...posting("c5", "CREATED", "INV-5", "DRAFT", false), last_error_code: "AMOUNT_MISMATCH" }] });
    const m = st(journeyOf([mm]), "commercial-billing");
    expect(m.status).toBe("needs_attention");
    expect(m.detail).toContain("recorded amount mismatch");
    const waiting = ownerBase({ postings: [...allButOne, posting("c5", "CREATED", "INV-5", "AUTHORISED", false)] });
    expect(st(journeyOf([waiting]), "commercial-billing")).toMatchObject({ status: "in_progress" });
    expect(st(journeyOf([waiting]), "commercial-billing").detail).toContain("awaiting reconciliation");
  });
  it("BASE/VARIATION isolation: a variation's claims never complete BASE, base claims never complete a variation, and V001 never counts for V002", () => {
    const unbilledBase = base({ variations: [variation("V001", "APPROVED", { amount_cents: R(500) })] });
    expect(st(journeyOf([unbilledBase, ownerVariation()]), "commercial-billing").status).not.toBe("completed");
    const unbilledVar = varScope("V001");
    expect(st(journeyOf([ownerBase(), unbilledVar]), "variation-V001").status).not.toBe("completed");
    expect(st(journeyOf([ownerBase(), unbilledVar]), "commercial-billing").status).toBe("completed");
    const two = journeyOf([scope({ ...{ project: project({ id: "ob2", project_reference: "P", original_contract_cents: R(1000) }), stages: [stage("s1", 1, "All", R(1000))] }, variations: [variation("V001", "APPROVED", { amount_cents: R(500) }), variation("V002", "APPROVED", { amount_cents: R(500) })] }), ownerVariation()]);
    expect(st(two, "variation-V001").status).toBe("completed");
    expect(st(two, "variation-V002")).toMatchObject({ status: "needs_attention" });
    expect(st(two, "variation-V002").detail).toMatch(/no billing project/);
  });
  it("is pure over loaded data: no hook, context, action, store, database or org identifier in the model's imports or code", () => {
    const src = readFileSync(join(__dirname, "../overview-model.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports).not.toMatch(/react|context|actions|-store|supabase|authorization/);
    expect(src).not.toMatch(/org_id|createServiceRoleClient|useInvoiceVerification/);
  });
});

describe("Project Journey - stricter g2 derivation and money format", () => {
  const sevenDown = [posting("c1", "RECONCILED", "INV-1", "DRAFT", true), posting("c3", "RECONCILED", "INV-3", "DRAFT", true), posting("c4", "RECONCILED", "INV-4", "DRAFT", true), posting("c5", "RECONCILED", "INV-5", "AUTHORISED", true)];
  it("an over-billed BASE stage is Needs attention, never complete", () => {
    const b = ownerBase({ lines: [{ claim_id: "c1", stage_id: "s-dep", current_claim_cents: R(400) }, { claim_id: "c3", stage_id: "s-del", current_claim_cents: R(560) }, { claim_id: "c4", stage_id: "s-del", current_claim_cents: R(0.5) }, { claim_id: "c5", stage_id: "s-ins", current_claim_cents: R(50) }] });
    const s = st(journeyOf([b]), "commercial-billing");
    expect(s.status).toBe("needs_attention");
    expect(s.detail).toContain("over-billed");
  });
  it("a cancelled claim that still has a live posting is Needs attention, never complete", () => {
    const b = ownerBase({ postings: [...sevenDown, posting("c2", "RECONCILED", "INV-2", "DRAFT", true)] });
    const s = st(journeyOf([b]), "commercial-billing");
    expect(s.status).toBe("needs_attention");
    expect(s.detail).toContain("cancelled claim still has a Cin7 posting");
  });
  it("an unrecognised posting state is never treated as fine (not complete)", () => {
    const b = ownerBase({ postings: [...sevenDown.slice(0, 3), posting("c5", "SOMETHING_NEW", "INV-5", "DRAFT", false)] });
    expect(st(journeyOf([b]), "commercial-billing").status).not.toBe("completed");
  });
  it("an over-billed variation is Needs attention", () => {
    const v = scope({ project: project({ id: "ov", project_reference: "P-V", original_contract_cents: R(500), billing_scope: "VARIATION", parent_project_id: "ob", variation_id: "x" }), stages: [stage("vs", 1, "V", R(500))], events: [progress("vs", 10000, 10000)], claims: [claim("vc1", 1, "APPROVED", R(600))], postings: [posting("vc1", "RECONCILED", "INV-V", "DRAFT", true)], variationCode: "V001" });
    expect(st(journeyOf([ownerBase(), v]), "variation-V001").status).toBe("needs_attention");
  });
  it("every amount in Journey text uses the shared formatter at full owner scale (R 500 000,00 / R 0,00), never a truncated or hand-built figure", () => {
    const v = scope({ project: project({ id: "ov", project_reference: "P-V", original_contract_cents: R(500_000), billing_scope: "VARIATION", parent_project_id: "ob", variation_id: "x" }), stages: [stage("vs", 1, "V", R(500_000))], events: [progress("vs", 10000, 10000)], claims: [claim("vc1", 1, "APPROVED", R(500_000))], postings: [posting("vc1", "RECONCILED", "INV-V", "DRAFT", true)], variationCode: "V001" });
    const b = scope({ project: project({ id: "ob3", project_reference: "P", original_contract_cents: R(10_072_000) }), stages: [stage("s1", 1, "All", R(10_072_000))], variations: [variation("V001", "APPROVED", { amount_cents: R(500_000) })], saleNumber: "SO-1" });
    const j = journeyOf([b, v]);
    expect(st(j, "variation-V001").detail).toBe("Title V001: commercial billing complete - R\u00A0500\u00A0000,00 billed, R\u00A00,00 remaining, 1 invoice reconciled.");
    const draft = journeyOf([scope({ project: project({ id: "ob4", project_reference: "P", original_contract_cents: R(10_072_000) }), stages: [stage("s1", 1, "All", R(10_072_000))], variations: [variation("V001", "DRAFT", { amount_cents: R(500_000) })] })]);
    expect(st(draft, "variation-V001").detail).toContain("R\u00A0500\u00A0000,00 ex VAT");
    expect(JSON.stringify(j)).not.toMatch(/R\d/); // no "R500" style hand-built amounts
  });
});
