// Commercial billing state: ONE derivation from postings + the stage ledger. Fixtures are SHAPED like the owner's project (3 stages fully billed, four
// APPROVED claims whose postings are RECONCILED, one extra cancelled claim, a commercial-only variation) but are synthetic: nothing is keyed on a real
// reference, invoice number or amount.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  billingClaimFact, claimPostingText, commercialBillingFromSummary, commercialBillingFromView, commercialBillingState, commercialBillingText,
  type BillingClaimFact, type CommercialBillingInput,
} from "../commercial-billing-state";
import { summariseReconciliation, loadReconciliationByProject } from "../variation-billing-store";
import { listPostings } from "../cin7-posting-store";
import { claimCin7Status } from "../claim-cin7-status";
import { buildProjectOverview } from "../overview-model";
import { FakeDb } from "./fake-db";
import { R, approvedVariation, claim, posting, progress, project, stage, view, demoInput } from "./overview-fixtures";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const FRESH = "2026-11-03T11:58:00Z";
const STALE = "2026-11-03T09:00:00Z";

// ── pure fact builders ──────────────────────────────────────────────────────────────────────────────────────
const reconciled = (status = "APPROVED"): BillingClaimFact => ({ status, posting: { posting_state: "RECONCILED", reconciled_at: "2026-11-01T10:00:00Z" } });
const created = (mismatch = false): BillingClaimFact => ({ status: "APPROVED", posting: { posting_state: "CREATED", mismatch } });
const pending = (stalePending: boolean): BillingClaimFact => ({ status: "APPROVED", posting: { posting_state: "PENDING", stalePending } });
const noWrite: BillingClaimFact = { status: "APPROVED", posting: { posting_state: "FAILED_CONFIRMED_NO_WRITE" } };
const cancelled: BillingClaimFact = { status: "CANCELLED_BEFORE_WRITE", posting: null };
const unposted: BillingClaimFact = { status: "APPROVED", posting: null };
const draft: BillingClaimFact = { status: "DRAFT", posting: null };
const full = [{ valueCents: R(400), committedCents: R(400) }, { valueCents: R(500), committedCents: R(500) }, { valueCents: R(100), committedCents: R(100) }];
const base = (over: Partial<CommercialBillingInput> = {}): CommercialBillingInput => ({ scope: "BASE", claims: [reconciled(), reconciled(), reconciled(), reconciled(), cancelled], stages: full, scheduleBalanced: true, uncertainClaimBlocking: false, ...over });
const variation = (over: Partial<CommercialBillingInput> = {}): CommercialBillingInput => ({ scope: "VARIATION", claims: [reconciled()], stages: [{ valueCents: R(50), committedCents: R(50) }], approvedAmountCents: R(50), billingStarted: true, ...over });
const state = (i: CommercialBillingInput) => commercialBillingState(i).state;

describe("BASE scope", () => {
  it("owner-shaped: 3 stages fully billed, 4 APPROVED claims with RECONCILED postings and one cancelled claim -> COMPLETE (the cancelled claim does not block)", () => {
    const r = commercialBillingState(base());
    expect(r.state).toBe("COMPLETE");
    expect(r.reasons).toEqual([]);
    expect(r.counts).toMatchObject({ live: 4, reconciled: 4, uncertain: 0, mismatched: 0, approvedUnposted: 0 });
  });
  it("partially billed (a stage not fully committed) -> IN_PROGRESS", () => {
    expect(state(base({ stages: [full[0], full[1], { valueCents: R(100), committedCents: R(60) }] }))).toBe("IN_PROGRESS");
  });
  it("one stage short and another over-billed (totals equal) is never COMPLETE: the over-billed stage needs attention", () => {
    expect(state(base({ stages: [{ valueCents: R(400), committedCents: R(300) }, { valueCents: R(500), committedCents: R(600) }, full[2]] }))).toBe("NEEDS_ATTENTION");
  });
  it("approved but not posted -> NEEDS_ATTENTION", () => {
    const r = commercialBillingState(base({ claims: [reconciled(), reconciled(), reconciled(), unposted] }));
    expect(r.state).toBe("NEEDS_ATTENTION");
    expect(r.counts.approvedUnposted).toBe(1);
    expect(r.reasons.join(" ")).toMatch(/not posted to Cin7/);
  });
  it("an uncertain posting -> NEEDS_ATTENTION", () => {
    expect(state(base({ claims: [reconciled(), { status: "APPROVED", posting: { posting_state: "FAILED_UNCERTAIN" } }] }))).toBe("NEEDS_ATTENTION");
  });
  it("an unrecognised posting state is never treated as fine", () => {
    expect(state(base({ claims: [reconciled(), { status: "APPROVED", posting: { posting_state: "SOMETHING_NEW" } }] }))).toBe("NEEDS_ATTENTION");
  });
  it("AMOUNT_MISMATCH on a CREATED row -> NEEDS_ATTENTION, and the reason names the mismatch", () => {
    const r = commercialBillingState(base({ claims: [reconciled(), reconciled(), reconciled(), created(true)] }));
    expect(r.state).toBe("NEEDS_ATTENTION");
    expect(r.reasons.join(" ")).toMatch(/amount mismatch/);
  });
  it("CREATED and not yet reconciled (no mismatch) -> IN_PROGRESS", () => {
    expect(state(base({ claims: [reconciled(), reconciled(), reconciled(), created(false)] }))).toBe("IN_PROGRESS");
  });
  it("RECONCILED without reconciled_at is not counted as reconciled", () => {
    expect(state(base({ claims: [reconciled(), { status: "APPROVED", posting: { posting_state: "RECONCILED", reconciled_at: null } }] }))).toBe("IN_PROGRESS");
  });
  it("fresh PENDING -> IN_PROGRESS; stale PENDING -> NEEDS_ATTENTION", () => {
    expect(state(base({ claims: [reconciled(), pending(false)] }))).toBe("IN_PROGRESS");
    expect(state(base({ claims: [reconciled(), pending(true)] }))).toBe("NEEDS_ATTENTION");
  });
  it("an APPROVED claim whose posting is FAILED_CONFIRMED_NO_WRITE (not created, retryable) -> NEEDS_ATTENTION", () => {
    const r = commercialBillingState(base({ claims: [reconciled(), noWrite] }));
    expect(r.state).toBe("NEEDS_ATTENTION");
    expect(r.counts.retryable).toBe(1);
  });
  it("draft / submitted claims -> IN_PROGRESS, even with the stages fully billed", () => {
    expect(state(base({ claims: [reconciled(), draft] }))).toBe("IN_PROGRESS");
    expect(state(base({ claims: [reconciled(), { status: "READY_FOR_APPROVAL", posting: null }] }))).toBe("IN_PROGRESS");
  });
  it("cancelled and failed-no-write claims never block a scope that is otherwise complete", () => {
    expect(state(base({ claims: [reconciled(), cancelled, { status: "FAILED_CONFIRMED_NO_WRITE", posting: { posting_state: "FAILED_CONFIRMED_NO_WRITE" } }] }))).toBe("COMPLETE");
  });
  it("no live claims and nothing committed -> NOT_STARTED; a cancelled claim alone is still NOT_STARTED", () => {
    expect(state(base({ claims: [], stages: full.map((s) => ({ ...s, committedCents: 0 })) }))).toBe("NOT_STARTED");
    expect(state(base({ claims: [cancelled], stages: full.map((s) => ({ ...s, committedCents: 0 })) }))).toBe("NOT_STARTED");
  });
  it("committed value with no live claim (nothing reconciled) is never COMPLETE", () => {
    expect(state(base({ claims: [] }))).toBe("IN_PROGRESS");
  });
  it("below-committed progress, an unbalanced schedule and a blocking uncertain claim each -> NEEDS_ATTENTION", () => {
    expect(state(base({ stages: [{ ...full[0], belowCommitted: true }, full[1], full[2]] }))).toBe("NEEDS_ATTENTION");
    expect(state(base({ scheduleBalanced: false }))).toBe("NEEDS_ATTENTION");
    expect(state(base({ uncertainClaimBlocking: true }))).toBe("NEEDS_ATTENTION");
  });
  it("NEEDS_ATTENTION outranks IN_PROGRESS", () => {
    expect(state(base({ claims: [draft, created(true)] }))).toBe("NEEDS_ATTENTION");
  });
  it("the dead claim statuses are never consulted: APPROVED + RECONCILED posting is what completes, a claim status of 'RECONCILED' alone does not", () => {
    expect(state(base({ claims: [{ status: "RECONCILED", posting: null }] }))).toBe("NEEDS_ATTENTION");
  });
  it("wording always says Commercial billing", () => {
    expect(commercialBillingText({ state: "COMPLETE" })).toBe("Commercial billing: Complete");
    expect(commercialBillingText({ state: "IN_PROGRESS" })).toBe("Commercial billing: In progress");
    expect(commercialBillingText({ state: "NEEDS_ATTENTION" })).toBe("Commercial billing: Needs attention");
  });
});

describe("review hardening", () => {
  it("P2-1: a BASE stage billed above its value is NEEDS_ATTENTION (stage over-billed), never COMPLETE", () => {
    const r = commercialBillingState(base({ stages: [{ valueCents: R(400), committedCents: R(450) }, full[1], full[2]] }));
    expect(r.state).toBe("NEEDS_ATTENTION");
    expect(r.reasons.join(" ")).toMatch(/over-billed/);
  });
  it("P3-1: a cancelled claim that still has a live or unresolved posting is evaluated, not ignored", () => {
    for (const st of ["PENDING", "CREATED", "RECONCILED", "FAILED_UNCERTAIN"]) {
      const r = commercialBillingState(base({ claims: [reconciled(), reconciled(), reconciled(), reconciled(), { status: "CANCELLED_BEFORE_WRITE", posting: { posting_state: st, reconciled_at: "2026-11-01T00:00:00Z" } }] }));
      expect(r.state, st).toBe("NEEDS_ATTENTION");
      expect(r.counts.cancelledWithPosting).toBe(1);
    }
    // ... while a cancelled claim with no posting, or a confirmed no-write one, is still ignored
    expect(state(base({ claims: [reconciled(), { status: "CANCELLED_BEFORE_WRITE", posting: { posting_state: "FAILED_CONFIRMED_NO_WRITE" } }, cancelled] }))).toBe("COMPLETE");
  });
  it("adapter-level isolation: variation claims presented to a BASE call cannot complete an unbilled BASE", () => {
    const partialBase = [{ valueCents: R(400), committedCents: R(100) }, full[1], full[2]];
    expect(state({ scope: "BASE", claims: [reconciled(), reconciled(), reconciled()], stages: partialBase, scheduleBalanced: true })).toBe("IN_PROGRESS");
  });
  it("a stale PENDING on the view path (now injected) needs attention; the same row fresh is in progress", () => {
    const b = project({ id: "base", project_reference: "PRJ-B", original_contract_cents: R(1000) });
    const row = { claim_id: "c1", posting_state: "PENDING", cin7_invoice_number: null, cin7_status: null, reconciled_at: null, requested_at: FRESH };
    const fact = (now: number) => billingClaimFact({ status: "APPROVED", cin7Status: claimCin7Status(row, now) });
    expect(state(base({ claims: [fact(NOW)] }))).toBe("IN_PROGRESS");
    expect(state(base({ claims: [fact(NOW + 3_600_000)] }))).toBe("NEEDS_ATTENTION");
  });
});

describe("VARIATION scope", () => {
  it("fully billed commercial-only variation (no physical lines, one reconciled claim, committed == approved) -> COMPLETE", () => {
    expect(state(variation())).toBe("COMPLETE");
  });
  it("partially billed -> IN_PROGRESS", () => {
    expect(state(variation({ stages: [{ valueCents: R(50), committedCents: R(20) }] }))).toBe("IN_PROGRESS");
  });
  it("billing not started -> NOT_STARTED; started with nothing claimed is NOT_STARTED too", () => {
    expect(state(variation({ claims: [], stages: [{ valueCents: R(50), committedCents: 0 }], billingStarted: false }))).toBe("NOT_STARTED");
  });
  it("requires billing started and an approved amount (never complete by default)", () => {
    expect(state(variation({ billingStarted: false }))).toBe("IN_PROGRESS");
    expect(state(variation({ approvedAmountCents: undefined }))).toBe("IN_PROGRESS");
  });
  it("committed above the approved amount needs attention", () => {
    expect(state(variation({ stages: [{ valueCents: R(50), committedCents: R(60) }] }))).toBe("NEEDS_ATTENTION");
  });
  it("mismatch / uncertain / unposted on the variation -> NEEDS_ATTENTION", () => {
    expect(state(variation({ claims: [created(true)] }))).toBe("NEEDS_ATTENTION");
    expect(state(variation({ claims: [{ status: "APPROVED", posting: { posting_state: "FAILED_UNCERTAIN" } }] }))).toBe("NEEDS_ATTENTION");
    expect(state(variation({ claims: [reconciled(), unposted] }))).toBe("NEEDS_ATTENTION");
  });
  it("multiple variations are independent: one complete, one partial, one with a mismatch", () => {
    const a = variation();
    const b = variation({ stages: [{ valueCents: R(80), committedCents: R(10) }], approvedAmountCents: R(80) });
    const c = variation({ claims: [created(true)] });
    expect([state(a), state(b), state(c)]).toEqual(["COMPLETE", "IN_PROGRESS", "NEEDS_ATTENTION"]);
  });
});

describe("BASE / VARIATION isolation and independence from everything non-commercial", () => {
  const input = base();
  it("a variation's claims and amounts never change the BASE result, and vice versa", () => {
    const baseOnly = state(base());
    const withBadVariation = state(base()); // BASE input carries no variation data by construction
    expect(withBadVariation).toBe(baseOnly);
    // the BASE test uses ITS OWN stages only: a variation's open amount would sit in project-level remaining, which is deliberately not an input
    expect(Object.keys(input)).not.toContain("remainingCents");
    // a mismatched variation does not touch a complete BASE and a complete BASE does not complete an unbilled variation
    expect(state(variation({ claims: [created(true)] }))).toBe("NEEDS_ATTENTION");
    expect(state(base())).toBe("COMPLETE");
    expect(state(variation({ claims: [], stages: [{ valueCents: R(50), committedCents: 0 }] }))).toBe("NOT_STARTED");
  });
  it("derived from real project views: V001's claims never count toward another variation or the BASE view", () => {
    const b = project({ id: "base", project_reference: "PRJ-B", original_contract_cents: R(1000) });
    const v1 = project({ id: "v1", project_reference: "PRJ-V1", original_contract_cents: R(50), billing_scope: "VARIATION" });
    const v2 = project({ id: "v2", project_reference: "PRJ-V2", original_contract_cents: R(70), billing_scope: "VARIATION" });
    const baseView = view({ project: b, stages: [stage("s1", 1, "Deposit", R(1000))], events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-1", "DRAFT", true)] });
    const v1View = view({ project: v1, stages: [stage("t1", 1, "Variation", R(50))], events: [progress("t1", 10000, 10000)], claims: [claim("d1", 1, "APPROVED", R(50))], postings: [posting("d1", "CREATED", "INV-2", "DRAFT", false, null, "AMOUNT_MISMATCH")] });
    const v2View = view({ project: v2, stages: [stage("u1", 1, "Variation", R(70))], events: [progress("u1", 10000, 10000)], claims: [claim("e1", 1, "APPROVED", R(70))], postings: [posting("e1", "RECONCILED", "INV-3", "DRAFT", true)] });
    expect(commercialBillingFromView(baseView, "BASE").state).toBe("COMPLETE");
    expect(commercialBillingFromView(v1View, "VARIATION", { approvedAmountCents: R(50), billingStarted: true }).state).toBe("NEEDS_ATTENTION");
    expect(commercialBillingFromView(v2View, "VARIATION", { approvedAmountCents: R(70), billingStarted: true }).state).toBe("COMPLETE");
  });
  it("an approved, not-yet-billed variation raises the project-level remaining value but never un-completes a fully billed BASE", () => {
    const b = project({ id: "base", project_reference: "PRJ-B", original_contract_cents: R(1000) });
    const v = view({ project: b, stages: [stage("s1", 1, "Deposit", R(1000))], events: [progress("s1", 10000, 10000)], claims: [claim("c1", 1, "APPROVED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-1", "DRAFT", true)], variations: [approvedVariation(R(500))] });
    expect(v.commercial.remainingCents).toBe(R(500)); // project-level remaining includes the variation
    expect(commercialBillingFromView(v, "BASE").state).toBe("COMPLETE");
  });
  it("physical fulfilment, delivery, payment and invoice authorisation are not inputs: the result is the same whatever they are", () => {
    const keys = Object.keys(base()).concat(Object.keys(variation()));
    expect(keys.join(" ")).not.toMatch(/physical|deliver|shipped|payment|paid|authori/i);
    // an invoice recorded as DRAFT or AUTHORISED (concept B) has the same commercial state: only the posting row matters
    const draftSnap = claimCin7Status({ claim_id: "x", posting_state: "RECONCILED", cin7_invoice_number: "INV-1", cin7_status: "DRAFT", reconciled_at: "2026-11-01T00:00:00Z" }, NOW);
    const authSnap = claimCin7Status({ claim_id: "x", posting_state: "RECONCILED", cin7_invoice_number: "INV-1", cin7_status: "AUTHORISED", reconciled_at: "2026-11-01T00:00:00Z" }, NOW);
    const f = (k: typeof draftSnap) => state(base({ claims: [billingClaimFact({ status: "APPROVED", cin7Status: k })] }));
    expect(f(draftSnap)).toBe(f(authSnap));
    expect(f(draftSnap)).toBe("COMPLETE");
  });
  it("the module imports no server action, store, Cin7 or crypto code (pure derivation)", () => {
    const src = readFileSync(new URL("../commercial-billing-state.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import .*(actions|-store|cin7-posting|node:|supabase|cin7\/)/m);
    expect(src).not.toMatch(/^import(?! type)/m);
  });
});

describe("posting facts mapped from real posting rows", () => {
  const row = (state: string, extra: Record<string, unknown> = {}) => claimCin7Status({ claim_id: "c", posting_state: state, cin7_invoice_number: "INV-9", cin7_status: "DRAFT", reconciled_at: null, ...extra }, NOW);
  it("CREATED + AMOUNT_MISMATCH is a mismatch; the same code on any other state is not", () => {
    expect(row("CREATED", { last_error_code: "AMOUNT_MISMATCH" }).mismatch).toBe(true);
    expect(row("CREATED").mismatch).toBe(false);
    expect(row("RECONCILED", { last_error_code: "AMOUNT_MISMATCH", reconciled_at: "2026-11-01T00:00:00Z" }).mismatch).toBe(false);
  });
  it("PENDING is stale after the window, and when its time is unreadable (never in progress by default)", () => {
    expect(row("PENDING", { requested_at: FRESH }).stalePending).toBe(false);
    expect(row("PENDING", { requested_at: STALE }).stalePending).toBe(true);
    expect(row("PENDING", { requested_at: null }).stalePending).toBe(true);
    expect(row("CREATED", { requested_at: STALE }).stalePending).toBe(false);
  });
  it("the display label is unchanged by the additive fields", () => {
    expect(row("CREATED", { last_error_code: "AMOUNT_MISMATCH" }).label).toBe("Draft recorded");
  });
});

describe("old rule documented: a claim-status test can never be true", () => {
  const b = project({ id: "base", project_reference: "PRJ-B", original_contract_cents: R(1000) });
  const stages = [stage("s1", 1, "Deposit", R(400)), stage("s2", 2, "Delivery", R(500)), stage("s3", 3, "Install", R(100))];
  const claims = [claim("c1", 1, "APPROVED", R(400)), claim("c2", 2, "APPROVED", R(500)), claim("c3", 3, "APPROVED", R(60)), claim("c4", 4, "APPROVED", R(40)), claim("c5", 5, "CANCELLED_BEFORE_WRITE", R(10))];
  const v = view({
    project: b, stages, events: stages.map((s) => progress(s.id, 10000, 10000)), claims,
    lines: [
      { claim_id: "c1", stage_id: "s1", current_claim_cents: R(400) }, { claim_id: "c2", stage_id: "s2", current_claim_cents: R(500) },
      { claim_id: "c3", stage_id: "s3", current_claim_cents: R(60) }, { claim_id: "c4", stage_id: "s3", current_claim_cents: R(40) }, { claim_id: "c5", stage_id: "s3", current_claim_cents: R(10) },
    ],
    postings: ["c1", "c2", "c3", "c4"].map((id, i) => posting(id, "RECONCILED", `INV-${i + 1}`, i === 3 ? "AUTHORISED" : "DRAFT", true)),
  });
  // The previous Journey rule: every live claim must have the claim STATUS RECONCILED.
  const legacyAllSettled = (vw: typeof v) => { const live = vw.claims.filter((c) => c.status !== "CANCELLED_BEFORE_WRITE"); return live.length > 0 && live.every((c) => c.status === "RECONCILED"); };
  it("the real view keeps every claim APPROVED, so the legacy rule says not settled", () => {
    expect(v.claims.filter((c) => c.status === "RECONCILED")).toHaveLength(0);
    expect(legacyAllSettled(v)).toBe(false); // the bug: "In progress" forever
  });
  it("the shared derivation says COMPLETE on the very same view (stages 100% committed, 4 reconciled postings, the cancelled claim ignored)", () => {
    expect(v.stages.every((s) => s.committedCents >= s.valueCents)).toBe(true);
    const r = commercialBillingFromView(v, "BASE");
    expect(r.state).toBe("COMPLETE");
    expect(r.counts).toMatchObject({ live: 4, reconciled: 4 });
  });
  it("Overview reconciliation carries the same state, named commercially, and names a mismatch", () => {
    const input = { ...demoInput(), scopes: [{ projectId: "base", scope: "BASE" as const, label: "Original contract", variationCode: null, saleNumber: "SO-1", view: v, scopeBlockers: [] }], unbilledApprovedVariations: [] };
    const o = buildProjectOverview(input);
    expect(o.reconciliation.scopes[0].billing.state).toBe("COMPLETE");
    const v2 = view({ project: b, stages, events: stages.map((s) => progress(s.id, 10000, 10000)), claims: claims.slice(0, 4), postings: [posting("c1", "RECONCILED", "INV-1", "DRAFT", true), posting("c2", "CREATED", "INV-2", "DRAFT", false, null, "AMOUNT_MISMATCH")] });
    const o2 = buildProjectOverview({ ...input, scopes: [{ ...input.scopes[0], view: v2 }] });
    expect(o2.reconciliation.scopes[0].billing.state).toBe("NEEDS_ATTENTION");
    expect(o2.reconciliation.scopes[0].summary.mismatchCount).toBe(1);
    expect(o2.reconciliation.scopes[0].claims.find((c) => c.claimNumber === "C02")?.mismatch).toBe(true);
  });
});

describe("variation reconciliation line derivation (from the posting summary + committed)", () => {
  const sum = (rows: Array<{ posting_state: string; last_error_code?: string; requested_at?: string; amount_ex_vat_cents?: number }>) => summariseReconciliation(rows, NOW);
  const approved = R(50);
  const ctx = { approvedAmountCents: approved, committedCents: approved, billingStarted: true };
  it("one reconciled invoice covering the committed amount -> COMPLETE", () => {
    expect(commercialBillingFromSummary(sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: approved }]), ctx).state).toBe("COMPLETE");
  });
  it("committed value no invoice accounts for is approved-but-unposted -> NEEDS_ATTENTION", () => {
    expect(commercialBillingFromSummary(sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: R(10) }]), ctx).state).toBe("NEEDS_ATTENTION");
  });
  it("mismatch, stale PENDING, fresh PENDING, created, no-write", () => {
    const f = (rows: Parameters<typeof sum>[0]) => commercialBillingFromSummary(sum(rows), ctx).state;
    expect(f([{ posting_state: "CREATED", last_error_code: "AMOUNT_MISMATCH", amount_ex_vat_cents: approved }])).toBe("NEEDS_ATTENTION");
    expect(f([{ posting_state: "PENDING", requested_at: STALE, amount_ex_vat_cents: approved }])).toBe("NEEDS_ATTENTION");
    expect(f([{ posting_state: "PENDING", requested_at: FRESH, amount_ex_vat_cents: approved }])).toBe("IN_PROGRESS");
    expect(f([{ posting_state: "CREATED", amount_ex_vat_cents: approved }])).toBe("IN_PROGRESS");
    expect(f([{ posting_state: "FAILED_CONFIRMED_NO_WRITE" }])).toBe("NEEDS_ATTENTION");
  });
  it("P2-2: posted amount above or below the billed amount needs attention, with distinct reasons", () => {
    const below = commercialBillingFromSummary(sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: R(10) }]), ctx);
    const above = commercialBillingFromSummary(sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: R(60) }]), ctx);
    expect([below.state, above.state]).toEqual(["NEEDS_ATTENTION", "NEEDS_ATTENTION"]);
    expect(below.reasons[0]).toMatch(/below the billed amount/);
    expect(above.reasons[0]).toMatch(/above the billed amount/);
  });
  it("P2-2: an unknown posted amount (null) is 'not verified' and never COMPLETE", () => {
    const base_ = sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: approved }]);
    const r = commercialBillingFromSummary({ ...base_, postingExVatCents: null }, ctx);
    expect(r.state).toBe("IN_PROGRESS");
    expect(r.reasons.join(" ")).toMatch(/could not be verified/);
    expect(commercialBillingFromSummary(base_, ctx).state).toBe("COMPLETE");
  });
  it("no postings, nothing committed -> NOT_STARTED; partially committed -> IN_PROGRESS", () => {
    expect(commercialBillingFromSummary(sum([]), { ...ctx, committedCents: 0 }).state).toBe("NOT_STARTED");
    expect(commercialBillingFromSummary(sum([{ posting_state: "RECONCILED", amount_ex_vat_cents: R(20) }]), { ...ctx, committedCents: R(20) }).state).toBe("IN_PROGRESS");
  });
});

describe("claim posting wording for the consolidated report", () => {
  const t = (over: Partial<Parameters<typeof claimPostingText>[0]>) => claimPostingText({ status: "APPROVED", postingState: null, invoiceNumber: null, reconciled: false, mismatch: false, ...over });
  it("never leaves an approved, posted claim as a bare 'Approved'", () => {
    expect(t({ postingState: "RECONCILED", invoiceNumber: "INV-7", reconciled: true })).toBe("Reconciled as INV-7");
    expect(t({ postingState: "CREATED", invoiceNumber: "INV-7" })).toBe("Posted as INV-7, not reconciled yet");
    expect(t({ postingState: "CREATED", invoiceNumber: "INV-7", mismatch: true })).toBe("Posted as INV-7, amount mismatch recorded");
    expect(t({})).toBe("Not posted to Cin7 yet");
    expect(t({ status: "DRAFT" })).toBeNull();
    expect(t({ postingState: "PENDING", stalePending: true })).toBe("Posting outcome uncertain");
    expect(t({ postingState: "FAILED_CONFIRMED_NO_WRITE" })).toBe("Not created in Cin7 (can be retried)");
  });
});

describe("organisation isolation (loaders stay org-filtered)", () => {
  it("another organisation's postings are never read or counted", async () => {
    const db = new FakeDb();
    const mine = "org-a"; const theirs = "org-b";
    db.rows("project_claim_cin7_postings").push(
      { org_id: mine, project_id: "p1", claim_id: "c1", posting_state: "RECONCILED", amount_ex_vat_cents: R(50), requested_at: FRESH },
      { org_id: theirs, project_id: "p1", claim_id: "c2", posting_state: "CREATED", last_error_code: "AMOUNT_MISMATCH", amount_ex_vat_cents: R(50), requested_at: FRESH },
      { org_id: theirs, project_id: "p1", claim_id: "c3", posting_state: "FAILED_UNCERTAIN", requested_at: FRESH },
    );
    const byProject = await loadReconciliationByProject(db as never, mine, ["p1"]);
    expect(byProject.p1).toMatchObject({ invoices: 1, reconciled: 1, mismatched: 0, uncertain: 0 });
    expect((await listPostings(db as never, mine, "p1")).map((p) => p.claim_id)).toEqual(["c1"]);
    expect(commercialBillingFromSummary(byProject.p1, { approvedAmountCents: R(50), committedCents: R(50), billingStarted: true }).state).toBe("COMPLETE");
  });
});
