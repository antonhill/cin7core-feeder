import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { navStatusLabel } from "@/newquip/quote/stage-nav-model";
import { computeStages, currentStage, type StageInput } from "@/newquip/quote/stages";

vi.mock("server-only", () => ({}));
import { StageNav } from "../[id]/StageNav";

// The navigation is rendered on the server here (no browser needed): six named stages, one highlighted, the status of each, the next action, and a layout that
// stacks on a phone (1 column), pairs on a tablet and spreads over six columns on a desktop.
const base: StageInput = { state: "MANAGER_APPROVED_FINAL", revision: 1, ready: true, customerSelected: true, confirmed: true, signedOff: true, commercial: "APPROVED_INTERNALLY", hasDocument: false, requiresAcceptance: true, projectLinked: false };
const html = (over: Partial<StageInput> = {}, viewing?: number) => {
  const stages = computeStages({ ...base, ...over });
  return renderToStaticMarkup(createElement(StageNav, { stages, current: currentStage(stages), viewing: (viewing ?? currentStage(stages)) as never, onSelect: () => undefined }));
};

describe("four-phase navigation (the six workflow stages are unchanged underneath)", () => {
  it("shows the four phases in order with their owner and status, highlights the phase being viewed, and states the next action", () => {
    const h = html();
    const labels = ["Configure &amp; Submit", "Cost &amp; Verify", "Approve or Return", "Customer &amp; Handover"];
    const list = h.indexOf('id="stage-nav-list"'); // the narrow-screen disclosure above the list repeats the viewed phase's name, so order is checked within the list
    let at = list; for (const l of labels) { const i = h.indexOf(l, list); expect(i, l).toBeGreaterThan(at); at = i; }
    for (const n of [1, 2, 3, 4]) expect(h).toContain(`data-phase="${n}"`);
    for (const owner of ["Rep", "Estimator", "Manager", "Rep and Manager"]) expect(h).toContain(`>${owner}`);
    expect(h).toContain("Complete"); expect(h).toContain("Awaiting action");
    expect(h.match(/aria-current="(?:step|true)" data-phase/g)).toHaveLength(1); // exactly one phase is highlighted
    expect(h.match(/aria-current="step"/g)).toHaveLength(1); // inside Customer & Handover only the active step is "step"; the phase card is "true"
    expect(h).toMatch(/aria-current="true" data-phase="4" data-stage="4"/);
    expect(h).toContain("Rep and Manager · you are here");
    expect(h).toContain("Phase 4 of 4 · Customer &amp; Handover");
    expect(h).toMatch(/Next: Rep: choose the payment schedule and generate the customer quotation PDF/);
    expect(h).not.toMatch(/Stage \d of 6/);
  });
  it("Customer & Handover keeps stages 4, 5 and 6 reachable as steps (existing stage ids) while it is viewed, and only then", () => {
    const h = html();
    expect(h).toContain('data-testid="phase4-steps"');
    for (const n of [4, 5, 6]) expect(h).toContain(`data-stage="${n}"`);
    for (const l of ["Customer Quotation", "Customer Acceptance", "Project Handover"]) expect(h).toContain(l);
    expect(h).toContain("Not yet available"); // stage 6 waits for the verified acceptance
    const early = html({}, 2);
    expect(early).not.toContain('data-testid="phase4-steps"');
    expect(early).not.toMatch(/<button[^>]*aria-current="step"[^>]*data-stage="[456]"/);
  });
  it("lets a user inspect a different phase than the current one (the highlight follows the viewed phase, 'you are here' stays on the current one)", () => {
    const h = html({}, 2);
    expect(h).toMatch(/aria-current="step" data-phase="2" data-stage="2"/);
    expect(h).toContain("Rep and Manager · you are here");
  });
  it("is responsive: one column on a phone, two on a tablet, four on a desktop", () => {
    const h = html();
    expect(h).toContain("grid-cols-1"); expect(h).toContain("sm:grid-cols-2"); expect(h).toContain("lg:grid-cols-4"); expect(h).not.toContain("lg:grid-cols-6");
  });
  it("reports returned work and not-required (grandfathered) stages", () => {
    expect(html({ state: "REP_DRAFT", revision: 2, signedOff: false, commercial: "NOT_APPROVED", confirmed: false })).toContain("Returned");
    const g = html({ requiresAcceptance: false });
    expect(g).toContain("Not required");
  });
});

describe("UX-006c viewer-relative Stage 2 chip (presentation only)", () => {
  const inReview: Partial<StageInput> = { state: "ESTIMATOR_REVIEW", signedOff: false, commercial: "NOT_APPROVED" };
  const chip = (over: Partial<StageInput>, roles: string[]) => {
    const stages = computeStages({ ...base, ...over });
    const out = renderToStaticMarkup(createElement(StageNav, { stages, current: currentStage(stages), viewing: 2, onSelect: () => undefined, viewer: { roles, state: over.state ?? base.state } }));
    return out.match(/data-stage="2"[\s\S]*?<\/button>/)![0];
  };
  it("a Rep who is only a Rep sees 'With the Estimator' when the quote is with the Estimator; the stage's Next line is unchanged", () => {
    const c = chip(inReview, ["rep"]);
    expect(c).toContain("With the Estimator"); expect(c).not.toContain("Awaiting action");
    const stages = computeStages({ ...base, ...inReview });
    expect(stages[1].status).toBe("AWAITING_ACTION"); expect(stages[1].next).toMatch(/^Estimator: review/);
  });
  it("an Estimator (not Manager) sees 'Awaiting your review'; a Manager and a viewer with no roles keep 'Awaiting action'", () => {
    expect(chip(inReview, ["rep", "estimator"])).toContain("Awaiting your review");
    expect(chip(inReview, ["rep", "estimator", "manager"])).toContain("Awaiting action");
    // UX-006i2: a viewer with no quote role (an Administrator observer) is told so instead of seeing an action chip for a task they cannot do.
    expect(chip(inReview, [])).toContain("Read-only: you have no quote role");
  });
  it("never for a Rep who must act (a draft ready to send, or a returned revision), a signed-off or final quote, or another stage", () => {
    expect(chip({ state: "REP_DRAFT", commercial: "NOT_APPROVED", signedOff: false }, ["rep"])).toContain("Awaiting action");
    expect(chip({ state: "REP_DRAFT", revision: 2, commercial: "NOT_APPROVED", signedOff: false }, ["rep"])).toContain("Awaiting action");
    expect(chip({ ...inReview, signedOff: true }, ["rep"])).toContain("Complete");
    expect(chip({}, ["rep"])).toContain("Complete");
    const stages = computeStages({ ...base, ...inReview });
    const html3 = renderToStaticMarkup(createElement(StageNav, { stages, current: 2, viewing: 2, onSelect: () => undefined, viewer: { roles: ["rep"], state: "ESTIMATOR_REVIEW" } }));
    expect(html3.match(/>With the Estimator</g)).toHaveLength(1); // the chip only (the banner sentence is the unchanged summary)
  });
});

describe("UX-006c equal-height phase cards", () => {
  it("each card pins its status chip to the bottom, keeps a fixed header zone for the title offset and never truncates", () => {
    const h = html();
    expect(h.match(/mt-auto/g)).toHaveLength(4);
    expect(h.match(/lg:min-h-8/g)).toHaveLength(4);
    for (const cut of ["line-clamp", "truncate", "overflow-hidden", "text-ellipsis"]) expect(h, cut).not.toContain(cut);
    expect(h).toContain("h-full"); // the card fills its grid cell, so a row is as tall as its tallest card
  });
});

describe("REGRESSION: stages must not revert while the persisted commercial status is loading (NQ-Q-0015: issued, accepted online, verified, Project created)", () => {
  // What the database holds for NQ-Q-0015 once everything has happened, as the page sees it.
  const done: Partial<StageInput> = { commercial: "CUSTOMER_ACCEPTED", hasDocument: true, projectLinked: true, linkState: "ACTIVE" };
  const labels = (over: Partial<StageInput>) => computeStages({ ...base, ...done, ...over }).map((s) => `${s.id}:${s.status}`);

  it("once the status has loaded, stages 4, 5 and 6 are all Complete for every viewer (the calculation has no role input)", () => {
    expect(labels({})).toEqual(["1:COMPLETE", "2:COMPLETE", "3:COMPLETE", "4:COMPLETE", "5:COMPLETE", "6:COMPLETE"]);
  });
  it("while it is loading, stages 4 and 5 say Loading - never 'Awaiting action' / 'Not started' - and so does 6 unless a Project link proves it complete", () => {
    expect(labels({ loading: true, commercial: null, hasDocument: false })).toEqual(["1:COMPLETE", "2:COMPLETE", "3:COMPLETE", "4:LOADING", "5:LOADING", "6:COMPLETE"]);
    const noProject = computeStages({ ...base, commercial: null, hasDocument: false, projectLinked: false, loading: true });
    expect(noProject.slice(3).map((s) => s.status)).toEqual(["LOADING", "LOADING", "LOADING"]);
    const h = html({ commercial: null, hasDocument: false, projectLinked: false, loading: true });
    for (const wrong of ["Awaiting action", "Not started", "Not yet available"]) expect(h, wrong).not.toContain(wrong);
    expect(h).toContain("Loading…");
  });
  it("the old behaviour is exactly what the loading state replaces: the empty defaults of an unread status DO derive the reverted stages", () => {
    // (this is the defect: without `loading`, empty defaults read as 4 awaiting / 5 not started / 6 unavailable)
    expect(computeStages({ ...base, commercial: null, hasDocument: false, projectLinked: false }).slice(3).map((s) => s.status)).toEqual(["AWAITING_ACTION", "NOT_STARTED", "NOT_AVAILABLE"]);
  });
  it("lands on the loading stage while loading, and on the real current stage afterwards (no jump back to an earlier stage)", () => {
    expect(currentStage(computeStages({ ...base, commercial: null, hasDocument: false, projectLinked: false, loading: true }))).toBe(4);
    expect(currentStage(computeStages({ ...base, ...done }))).toBe(6);
    expect(currentStage(computeStages({ ...base, ...done, loading: true }))).toBe(6); // a Project link proves stage 6, so loading lands where the loaded state does
  });
  it("loading only applies to a final quotation; earlier states are unaffected", () => {
    const early = computeStages({ ...base, state: "ESTIMATOR_REVIEW", signedOff: false, commercial: "NOT_APPROVED", loading: true });
    expect(early.some((s) => s.status === "LOADING")).toBe(false);
  });
  it("the page reads the status once, holds stages 4-6 while it is unread, and shows an error with a retry instead of defaults", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../[id]/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/loading: final && !gateReady/);
    expect(src).toMatch(/const hold = \(n: StageId\) => loadingStages/);
    for (const n of [4, 5, 6]) expect(src).toContain(`stage === ${n} && !hold(${n})`);
    expect(src).toContain("setGateReady(true)"); expect(src).toContain("Try again");
    // the "Create Project" button must not be offered from the unread defaults
    expect(src.indexOf("stage === 6 && !hold(6)")).toBeGreaterThan(0);
  });
});

describe("navStatusLabel: the Stage 1 chip is viewer-relative (UX-006i1)", () => {
  const stage1 = { id: 1, label: "Configuration", status: "COMPLETE", statusLabel: "Complete", summary: "", next: null } as never;
  it("a Rep on a Rep draft reads 'Ready to submit'; everyone else, and every other state, still reads 'Complete'", () => {
    expect(navStatusLabel(stage1, false, { roles: ["rep", "estimator"], state: "REP_DRAFT" })).toBe("Ready to submit");
    expect(navStatusLabel(stage1, false, { roles: ["estimator"], state: "REP_DRAFT" })).toBe("Complete");
    expect(navStatusLabel(stage1, false, { roles: ["manager"], state: "REP_DRAFT" })).toBe("Complete");
    expect(navStatusLabel(stage1, false, { roles: ["rep"], state: "ESTIMATOR_REVIEW" })).toBe("Complete");
    expect(navStatusLabel(stage1, false)).toBe("Complete");
  });
});

// UX-006i2: viewer-relative chips and next-action lines. computeStages is NOT changed (asserted below); only the presentation is.
import { navPresentation } from "@/newquip/quote/stage-nav-model";
describe("UX-006i2 viewer-relative stage wording (presentation only; computeStages unchanged)", () => {
  const draftReady: Partial<StageInput> = { state: "REP_DRAFT", signedOff: false, commercial: "NOT_APPROVED", confirmed: false };
  const stage2 = (over: Partial<StageInput>) => computeStages({ ...base, ...over })[1];
  it("an Estimator on a Rep draft with open mapping: consistent 'your mapping is needed' wording, not 'Starts once the quote is READY'", () => {
    const s = stage2({ ...draftReady, ready: false });
    expect(s.summary).toBe("Starts once the quote is READY."); // the computed text is untouched
    const p = navPresentation(s, false, { roles: ["estimator"], state: "REP_DRAFT", estimatorOpen: 3 });
    expect(p.chip).toBe("Your mapping is needed");
    expect(p.summary).not.toMatch(/Starts once/);
    expect(p.next).toMatch(/^Estimator: map the products/);
    expect(navPresentation(s, false, { roles: ["rep"], state: "REP_DRAFT", estimatorOpen: 3 }).summary).toBe("Starts once the quote is READY."); // a Rep keeps the computed text
  });
  it("after the mapping is done the Estimator is told it is with the Rep (they were the actor, not the next owner); the computed text still names the Rep", () => {
    const s = stage2({ ...draftReady });
    expect(s.status).toBe("AWAITING_ACTION"); expect(s.next).toMatch(/^Rep: submit/);
    const p = navPresentation(s, false, { roles: ["estimator"], state: "REP_DRAFT", estimatorOpen: 0 });
    expect(p.chip).toBe("With the Rep"); expect(p.summary).toBe("Nothing is left for you until the Rep submits."); expect(p.next).toMatch(/^Rep: submit the quotation to the Estimator/);
    expect(navPresentation(s, false, { roles: ["rep", "estimator"], state: "REP_DRAFT", estimatorOpen: 0 }).next).toMatch(/^Rep: submit/); // the member tier IS the Rep
  });
  it("Stage 6: a Rep, an Estimator and a Manager-less viewer see 'Waiting on the Manager' and a next action naming the Manager; an observer sees the read-only chip; the Manager is unchanged", () => {
    const s6 = computeStages({ ...base, commercial: "CUSTOMER_ACCEPTED" })[5];
    expect(s6.status).toBe("AWAITING_ACTION"); expect(s6.next).toBe("Create the Project.");
    for (const roles of [["rep"], ["estimator"], ["rep", "estimator"]]) {
      const p = navPresentation(s6, false, { roles, state: "MANAGER_APPROVED_FINAL" });
      expect(p.chip).toBe("Waiting on the Manager"); expect(p.next).toBe("Manager: create the Project.");
    }
    const obs = navPresentation(s6, false, { roles: [], state: "MANAGER_APPROVED_FINAL" });
    expect(obs.chip).toBe("Read-only: you have no quote role"); expect(obs.next).toBe("Manager: create the Project.");
    const mgr = navPresentation(s6, false, { roles: ["manager"], state: "MANAGER_APPROVED_FINAL" });
    expect(mgr.chip).toBe("Awaiting action"); expect(mgr.next).toBe("Create the Project.");
  });
  it("rendered: the Stage 6 card and the next-action line say Manager for a Rep", () => {
    const stages = computeStages({ ...base, commercial: "CUSTOMER_ACCEPTED" });
    const out = renderToStaticMarkup(createElement(StageNav, { stages, current: 6, viewing: 6, onSelect: () => undefined, viewer: { roles: ["rep"], state: "MANAGER_APPROVED_FINAL" } }));
    expect(out).toContain("Waiting on the Manager"); expect(out).toContain("Next: Manager: create the Project.");
  });
});
