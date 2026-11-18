import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkApproval } from "../workflow";
import { approvalChecklistMet, costingAcceptedIncompleteText, deriveApprovalChecklist, type ApprovalChecklistInput } from "../stage3-approval";
import { deriveStage4Steps } from "../stage4-steps";
import { deriveAcceptanceBanner } from "../stage5-banner";
import { deriveHandoverReadiness } from "../stage6-handover";
import { navStatusLabel } from "../stage-nav-model";
import { computeStages, type StageInput } from "../stages";
import { nextIncompleteStepId } from "@/components/ui/step-rail-model";

const ok: ApprovalChecklistInput = { readinessState: "READY", readinessReasons: [], totalExVatCents: 1_000_000, customerConfirmedCents: 1_000_000, signoffHash: "h1", currentDraftHash: "h1", dirty: false, isManager: true };
const met = (i: Partial<ApprovalChecklistInput>) => Object.fromEntries(deriveApprovalChecklist({ ...ok, ...i }).map((x) => [x.id, x.met]));

describe("UX-006c Stage 3 checklist (derived from checkApproval)", () => {
  it("everything met when checkApproval passes", () => {
    const items = deriveApprovalChecklist(ok);
    expect(items.map((x) => x.id)).toEqual(["ready", "total", "confirmed", "signoff", "amount", "manager"]);
    expect(approvalChecklistMet(items)).toBe(true);
    expect(checkApproval({ readiness: { state: "READY", reasons: [] } as never, totalExVatCents: 1_000_000, customerConfirmedCents: 1_000_000, signoffHash: "h1", currentDraftHash: "h1", costing: { complete: true, reasons: [] } }).ok).toBe(true);
  });
  it("each condition goes unmet on its own and carries checkApproval's own message", () => {
    expect(met({ readinessState: "BLOCKED" })).toMatchObject({ ready: false, total: true, confirmed: true, signoff: true, amount: true });
    expect(met({ totalExVatCents: null })).toMatchObject({ ready: true, total: false, amount: false });
    expect(met({ totalExVatCents: 0 })).toMatchObject({ total: false });
    expect(met({ customerConfirmedCents: null })).toMatchObject({ confirmed: false, amount: false, signoff: true });
    expect(met({ signoffHash: null })).toMatchObject({ signoff: false, ready: true });
    expect(met({ signoffHash: "old" })).toMatchObject({ signoff: false });
    expect(met({ customerConfirmedCents: 900_000 })).toMatchObject({ amount: false, confirmed: true, total: true });
    const byId = (i: Partial<ApprovalChecklistInput>) => Object.fromEntries(deriveApprovalChecklist({ ...ok, ...i }).map((x) => [x.id, x.detail]));
    expect(byId({ readinessState: "BLOCKED" }).ready).toBe("The quote is BLOCKED; it cannot be approved.");
    expect(byId({ signoffHash: null }).signoff).toBe("The estimator has not signed off this quote.");
    expect(byId({ signoffHash: "old" }).signoff).toMatch(/changed after the estimator signed off/);
    expect(byId({ customerConfirmedCents: 900_000 }).amount).toMatch(/total changed since the customer confirmed/);
  });
  it("a viewer without the Manager role gets an unmet Manager row (the Approve gate needs it), with no figures", () => {
    const items = deriveApprovalChecklist({ ...ok, isManager: false });
    expect(items.find((x) => x.id === "manager")).toMatchObject({ met: false, detail: "Only a Manager can make the final decision." });
    expect(approvalChecklistMet(items)).toBe(false);
    expect(met({ isManager: false })).toMatchObject({ ready: true, total: true, confirmed: true, signoff: true, amount: true, manager: false });
  });
  it("when the page already explains the sign-off right below, the row points to it instead of repeating it (only while unmet)", () => {
    const d = (i: Partial<ApprovalChecklistInput>) => deriveApprovalChecklist({ ...ok, signoffExplainedBelow: true, ...i }).find((x) => x.id === "signoff")!;
    expect(d({ signoffHash: null }).detail).toBe("Explained in the note below.");
    expect(d({}).detail).toBeNull();
  });
  it("the page's total is rounded exactly as the server rounds the saved total (same expression in both)", () => {
    const expr = "Math.round(budget.totals.subtotalExTax * 100)";
    expect(readFileSync(join(__dirname, "../../../app/newquip-grower/[id]/page.tsx"), "utf8")).toContain(`budget ? ${expr} : null`);
    expect(readFileSync(join(__dirname, "../../../lib/newquip-quotes/quote-store.ts"), "utf8")).toContain(`ev.budget ? ${expr.replace("budget.", "ev.budget.")} : null`);
  });
  it("unsaved edits add a sixth, unmet row (approval applies to the saved quotation)", () => {
    const items = deriveApprovalChecklist({ ...ok, dirty: true });
    expect(items.at(-1)).toMatchObject({ id: "saved", met: false });
    expect(approvalChecklistMet(items)).toBe(false);
  });
  it("shows no figures: no unmet message contains an amount", () => {
    const text = deriveApprovalChecklist({ ...ok, customerConfirmedCents: 900_000, readinessState: "BLOCKED", dirty: true }).map((x) => x.detail ?? "").join(" ");
    expect(text).not.toMatch(/\d{4,}|R\s?\d/);
  });
});

describe("UX-006c Stage 4 steps (from the issued-document and sent records only)", () => {
  const st = (hasDocument: boolean, commercial: string | null) => deriveStage4Steps({ hasDocument, commercial }).map((s) => s.status);
  it("no PDF: issue is not complete and send is unavailable", () => expect(st(false, "APPROVED_INTERNALLY")).toEqual(["incomplete", "unavailable"]));
  it("PDF issued, not sent: issue complete, send open", () => expect(st(true, "APPROVED_INTERNALLY")).toEqual(["complete", "incomplete"]));
  it("every sent or later status completes send", () => {
    for (const c of ["SENT_TO_CUSTOMER", "ACCEPTANCE_PENDING_VERIFICATION", "ACCEPTANCE_REJECTED", "CUSTOMER_ACCEPTED", "CUSTOMER_DECLINED", "CHANGES_REQUESTED"]) expect(st(true, c), c).toEqual(["complete", "complete"]);
  });
  it("unknown (null) commercial status never marks send complete", () => expect(st(true, null)).toEqual(["complete", "incomplete"]));
  it("Next incomplete step skips an unavailable step", () => expect(nextIncompleteStepId(deriveStage4Steps({ hasDocument: false, commercial: null }), "issue")).toBeNull());
  it("states that only a Rep can send, on the step itself", () => expect(deriveStage4Steps({ hasDocument: true, commercial: null })[1].note).toMatch(/Sent by a Rep/));
});

const base: StageInput = { state: "MANAGER_APPROVED_FINAL", revision: 1, ready: true, customerSelected: true, confirmed: true, signedOff: true, commercial: "SENT_TO_CUSTOMER", hasDocument: true, requiresAcceptance: true, projectLinked: false };
const banner = (over: Partial<StageInput>) => { const s = computeStages({ ...base, ...over }); return deriveAcceptanceBanner(s[4], over.commercial === undefined ? base.commercial : over.commercial); };

describe("UX-006c Stage 5 banner (restates the existing stage-5 status)", () => {
  it("covers every acceptance state", () => {
    expect(banner({})).toMatchObject({ headline: "Awaiting customer response", tone: "info" });
    expect(banner({ commercial: "ACCEPTANCE_PENDING_VERIFICATION" })).toMatchObject({ headline: "Pending verification", tone: "warning" });
    expect(banner({ commercial: "CUSTOMER_ACCEPTED" })).toMatchObject({ headline: "Accepted", tone: "success", next: null });
    expect(banner({ commercial: "CUSTOMER_DECLINED" })?.headline).toBe("Returned: declined");
    expect(banner({ commercial: "CHANGES_REQUESTED" })?.headline).toBe("Returned: changes requested");
    expect(banner({ commercial: "ACCEPTANCE_REJECTED" })?.headline).toBe("Returned: acceptance rejected");
    expect(banner({ requiresAcceptance: false })).toMatchObject({ headline: "Not required (grandfathered)" });
  });
  it("before the quotation is sent the banner names the single next action", () => {
    expect(banner({ commercial: "APPROVED_INTERNALLY", hasDocument: false })).toMatchObject({ headline: "Awaiting the quotation to be sent", next: "Issue and send the quotation in Stage 4." });
  });
  it("the next action text is the existing stage's own; nothing for loading or an unavailable stage", () => {
    const s = computeStages({ ...base, commercial: "CUSTOMER_DECLINED" })[4];
    expect(deriveAcceptanceBanner(s, "CUSTOMER_DECLINED")?.next).toBe(s.next);
    expect(deriveAcceptanceBanner(computeStages({ ...base, state: "ESTIMATOR_REVIEW" })[4], null)).toBeNull();
    expect(deriveAcceptanceBanner(computeStages({ ...base, loading: true, commercial: null })[4], null)).toBeNull();
  });
});

describe("UX-006c Stage 6 readiness", () => {
  const r = (o: Partial<Parameters<typeof deriveHandoverReadiness>[0]>) => Object.fromEntries(deriveHandoverReadiness({ approved: true, acceptanceRequired: true, accepted: true, scheduleOk: true, isManager: true, ...o }).map((x) => [x.id, x.met]));
  it("all met for an accepted quote and a Manager", () => expect(Object.values(r({}))).toEqual([true, true, true, true]));
  it("acceptance, role and (when acceptance is not required) schedule each go unmet on their own", () => {
    expect(r({ accepted: false })).toMatchObject({ acceptance: false, manager: true });
    expect(deriveHandoverReadiness({ approved: true, acceptanceRequired: true, accepted: false, scheduleOk: true, isManager: true }).find((x) => x.id === "acceptance")!.fixStage).toBe(5);
    expect(r({ isManager: false })).toMatchObject({ manager: false, acceptance: true });
    expect(r({ acceptanceRequired: false, scheduleOk: false })).toMatchObject({ schedule: false, acceptance: true });
    expect(r({ acceptanceRequired: true, scheduleOk: false }).schedule).toBe(true); // the printed schedule is used
  });
});

describe("UX-006c stage navigation labels", () => {
  const s = computeStages({ ...base, state: "ESTIMATOR_REVIEW" });
  it("Preview only replaces Not yet available only where the page says the stage can be inspected", () => {
    expect(navStatusLabel(s[3], true)).toBe("Preview only");
    expect(navStatusLabel(s[3], false)).toBe("Not yet available");
    expect(navStatusLabel(s[4], false)).toBe("Not yet available");
  });
  it("never relabels a stage that is not unavailable", () => expect(navStatusLabel(s[2], true)).toBe(s[2].statusLabel));
});

describe("UX-006c static: presentation and derivation import no server action or store", () => {
  const roots = [join(__dirname, ".."), join(__dirname, "../../../app/newquip-grower/[id]")];
  const files = [["stage3-approval.ts", 0], ["stage4-steps.ts", 0], ["stage5-banner.ts", 0], ["stage6-handover.ts", 0], ["stage-nav-model.ts", 0], ["Stage36Guidance.tsx", 1], ["StageNav.tsx", 1]] as const;
  for (const [f, r] of files) it(f, () => {
    expect(readdirSync(roots[r])).toContain(f);
    const src = readFileSync(join(roots[r], f), "utf8");
    expect(src).not.toMatch(/from "[^"]*(actions|-store|supabase|server-only)[^"]*"/);
  });
});

describe("UX-006 integration: the baseline-exception row of the Stage 3 checklist", () => {
  const base = { readinessState: "READY" as const, readinessReasons: [], totalExVatCents: 100, customerConfirmedCents: 100, signoffHash: "h", currentDraftHash: "h", dirty: false, isManager: true, costing: { complete: true, reason: null } };
  it("no exception row unless the server says one is required", () => {
    expect(deriveApprovalChecklist(base).some((x) => x.id === "exception")).toBe(false);
    expect(deriveApprovalChecklist({ ...base, baselineException: { baselineExceptionRequired: false, items: [] } }).some((x) => x.id === "exception")).toBe(false);
    expect(deriveApprovalChecklist({ ...base, baselineException: null }).some((x) => x.id === "exception")).toBe(false);
  });
  it("a required exception is an UNMET row naming the items and pointing at 'Approve with recorded exception'; the checklist is then not met", () => {
    const items = deriveApprovalChecklist({ ...base, baselineException: { baselineExceptionRequired: true, items: [{ label: "M75 feed distribution system" }] } });
    const row = items.find((x) => x.id === "exception")!;
    expect(row).toMatchObject({ met: false, fixStage: null });
    expect(row.detail).toMatch(/M75 feed distribution system/);
    expect(row.detail).toMatch(/Approve with recorded exception/);
    expect(items.every((x) => x.met)).toBe(false);
  });
});

describe("D-19: the Stage 3 checklist names unmapped products no exception can cover", () => {
  const base = { readinessState: "READY" as const, readinessReasons: [], totalExVatCents: 100, customerConfirmedCents: 100, signoffHash: "h", currentDraftHash: "h", dirty: false, isManager: true, costing: { complete: true, reason: null } };
  it("an UNMET 'Mapping unresolved' row lists the labels and the M75 / penning limit; the exception row is absent (it is not offered)", () => {
    const items = deriveApprovalChecklist({ ...base, baselineException: { baselineExceptionRequired: false, items: [], blocking: [{ label: "LED light" }] } });
    const row = items.find((x) => x.id === "mapping")!;
    expect(row).toMatchObject({ met: false });
    expect(row.detail).toBe("Mapping unresolved: LED light - these need an active library mapping; the Manager exception covers only M75 / penning systems.");
    expect(items.some((x) => x.id === "exception")).toBe(false);
    expect(items.every((x) => x.met)).toBe(false);
  });
  it("when BOTH exist, both are listed and the exception is available only once the blocking items are mapped", () => {
    const row = deriveApprovalChecklist({ ...base, baselineException: { baselineExceptionRequired: false, items: [{ label: "M75 feed distribution system" }], blocking: [{ label: "LED light" }] } }).find((x) => x.id === "mapping")!;
    expect(row.detail).toMatch(/LED light/);
    expect(row.detail).toMatch(/M75 feed distribution system could be covered by an exception, but only once the unmapped products above are mapped/);
  });
  it("no row when nothing is blocking", () => {
    expect(deriveApprovalChecklist({ ...base, baselineException: { baselineExceptionRequired: false, items: [], blocking: [] } }).some((x) => x.id === "mapping")).toBe(false);
  });
});

describe("ROUND 4: an accepted-incomplete costing is its own state, never 'Costing is complete'", () => {
  const base = { readinessState: "READY" as const, readinessReasons: [], totalExVatCents: 100, customerConfirmedCents: 100, signoffHash: "h", currentDraftHash: "h", dirty: false, isManager: true };
  const acc = { reason: "Supplier prices follow the PO", by: "est@nq", at: "2026-11-02T08:00:00Z" };
  it("the costing row names who accepted it, when and why; it is allowed (met) but flagged accepted-incomplete", () => {
    const row = deriveApprovalChecklist({ ...base, costing: { complete: true, reason: null, acceptedIncomplete: acc } }).find((x) => x.id === "costing")!;
    expect(row).toMatchObject({ met: true, state: "accepted-incomplete", label: "Costing accepted incomplete by est@nq on 2026-11-02: Supplier prices follow the PO" });
    expect(row.label).not.toMatch(/is complete/);
  });
  it("a genuinely complete costing keeps 'Costing is complete'; an incomplete one stays unmet", () => {
    expect(deriveApprovalChecklist({ ...base, costing: { complete: true, reason: null } }).find((x) => x.id === "costing")).toMatchObject({ label: "Costing is complete", met: true });
    expect(deriveApprovalChecklist({ ...base, costing: { complete: true, reason: null } }).find((x) => x.id === "costing")!.state).toBeUndefined();
    expect(deriveApprovalChecklist({ ...base, costing: { complete: false, reason: "2 SKUs have no cost" } }).find((x) => x.id === "costing")).toMatchObject({ met: false });
  });
  it("costingAcceptedIncompleteText is one sentence with the date only", () => {
    expect(costingAcceptedIncompleteText(acc)).toBe("Costing accepted incomplete by est@nq on 2026-11-02: Supplier prices follow the PO");
  });
});
