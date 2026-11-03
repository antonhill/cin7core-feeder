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
    expect(j.lanes[0].stations.map((s) => s.label)).toEqual(["Cin7 Sale", "Stage progress", "Progress claims", "Post to Cin7", "Invoice status"]);
    expect(j.lanes[1].stations.map((s) => s.label)).toEqual(["Deliveries", "Fulfilment", "Procurement", "Milestone confirmations"]);
    expect(j.footnote).toBe(JOURNEY_FOOTNOTE);
    const all = JSON.stringify(j).toLowerCase();
    expect(all).not.toMatch(/project (is )?(complete|closed)|handover complete|closed out/);
  });
  it("never names stock fulfilment in an invoicing station or invoicing in a stock station (no dependency between them)", () => {
    const j = journeyOf([base({ claims: [claim("c1", 1, "APPROVED", R(500))], postings: [] })]);
    const text = (ids: string[]) => ids.map((i) => JSON.stringify(st(j, i))).join(" ").toLowerCase();
    expect(text(["commercial-posting", "commercial-invoices", "commercial-claims"])).not.toMatch(/stock|fulfil|ship|deliver/);
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
  it("Progress claims: none, drafts/submitted in progress, uncertain = Blocked with its Needs line, all reconciled with nothing left = completed", () => {
    expect(st(journeyOf([base()]), "commercial-claims").status).toBe("not_started");
    expect(st(journeyOf([base()]), "commercial-claims").detail).toMatch(/Nothing is claimable/);
    const open = st(journeyOf([base({ claims: [claim("c1", 1, "DRAFT", R(100)), claim("c2", 2, "READY_FOR_APPROVAL", R(100))] })]), "commercial-claims");
    expect(open.status).toBe("in_progress");
    expect(open.detail).toBe("1 in draft, 1 awaiting approval.");
    const uncertain = st(journeyOf([base({ claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))] })]), "commercial-claims");
    expect(uncertain.status).toBe("blocked");
    expect(uncertain.needs[0]).toMatch(/uncertain claim resolved/);
    const done = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "RECONCILED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true)] });
    expect(st(journeyOf([done]), "commercial-claims").status).toBe("completed");
    const some = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "RECONCILED", R(400))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true)] });
    expect(st(journeyOf([some]), "commercial-claims").status).toBe("in_progress");
  });
  it("Post to Cin7: needs a linked Sale (Blocked when approved claims wait), attention on failure/uncertain, completed when posted", () => {
    const approved = [claim("c1", 1, "APPROVED", R(500))];
    const noSale = st(journeyOf([base({ claims: approved, sale: null })]), "commercial-posting");
    expect(noSale.status).toBe("blocked");
    expect(noSale.needs[0]).toMatch(/linked Cin7 Sale before a claim can be posted/);
    const ready = st(journeyOf([base({ claims: approved })]), "commercial-posting");
    expect(ready).toMatchObject({ status: "in_progress", needs: [] });
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false)] })]), "commercial-posting").status).toBe("needs_attention");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "FAILED_CONFIRMED_NO_WRITE", null, null, false)] })]), "commercial-posting").status).toBe("needs_attention");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "PENDING", null, null, false)] })]), "commercial-posting").status).toBe("in_progress");
    expect(st(journeyOf([base({ claims: approved, postings: [posting("c1", "CREATED", "INV-1", "DRAFT", false)] })]), "commercial-posting").status).toBe("completed");
    expect(st(journeyOf([base()]), "commercial-posting").status).toBe("not_started");
  });
  it("Invoice status reports only the LAST RECORDED status and always says the live status is Not read yet", () => {
    const one = base({ claims: [claim("c1", 1, "APPROVED", R(500)), claim("c2", 2, "APPROVED", R(300))], postings: [posting("c1", "RECONCILED", "INV-1", "AUTHORISED", true), posting("c2", "CREATED", "INV-2", "DRAFT", false)] });
    const s = st(journeyOf([one]), "commercial-invoices");
    expect(s.status).toBe("in_progress");
    expect(s.detail).toContain("2 invoices recorded, 1 reconciled");
    expect(s.detail).toContain("Live Cin7 status: Not read yet");
    const none = st(journeyOf([base()]), "commercial-invoices");
    expect(none.status).toBe("not_started");
    expect(none.detail).toContain("Not read yet");
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
    expect(j.lanes[1].summary.unknown).toBe(3);
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
    expect(st(unreadable, "physical-procurement").status).toBe("in_progress"); // a shortfall cannot be ruled out
    const none = journeyOf([base()], load([physRow("A", { ordered: 10, shipped: 0, remaining: 10, shortfall: 0 })]));
    expect(st(none, "physical-fulfilment").status).toBe("not_started");
    expect(st(journeyOf([base()], load([])), "physical-fulfilment").status).toBe("not_started");
  });
  it("fulfilment does not change with billing and billing does not change with fulfilment", () => {
    const billed = base({ events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "RECONCILED", R(1000))], postings: [posting("c1", "RECONCILED", "INV", "AUTHORISED", true)] });
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
    expect(st(j, "variation-V003").status).toBe("completed");
  });
  it("a billing project open with no claims is in progress; fully reconciled is completed; uncertain/unbalanced is attention", () => {
    const vs = [variation("V001", "APPROVED")];
    expect(st(journeyOf([base({ variations: vs }), varScope("V001")]), "variation-V001")).toMatchObject({ status: "in_progress", detail: "Billing project open; no claims raised yet." });
    const done = varScope("V001", { events: [progress("vs-V001", 10000, 10000)], claims: [claim("vc1", 1, "RECONCILED", R(1000))], postings: [posting("vc1", "RECONCILED", "INV-V", "AUTHORISED", true)] });
    expect(st(journeyOf([base({ variations: vs }), done]), "variation-V001").status).toBe("completed");
    const uncertain = varScope("V001", { claims: [claim("vc1", 1, "FAILED_UNCERTAIN", R(500))] });
    const u = st(journeyOf([base({ variations: vs }), uncertain]), "variation-V001");
    expect(u.status).toBe("needs_attention");
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
    expect(st(two, "variation-V001").status).toBe("needs_attention");
    expect(st(two, "variation-V002").status).toBe("needs_attention");
    expect(st(two, "variation-V002").detail).toMatch(/no billing project/);
  });
});

describe("Project Journey - lane summaries and missing base", () => {
  it("counts attention (needs attention + blocked), in progress and unknown; unknown stations are not counted as in progress", () => {
    const j = journeyOf([base({ claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))], sale: null })]);
    const s = j.lanes[0].summary;
    expect(s.attention).toBeGreaterThanOrEqual(1);
    expect(s.unknown).toBe(1); // the Sale: no link and nothing to say whether an attempt is in flight
    expect(j.lanes[1].summary).toEqual({ attention: 0, inProgress: 1, unknown: 3 });
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
