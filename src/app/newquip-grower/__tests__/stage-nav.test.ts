import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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

describe("six-stage navigation", () => {
  it("shows all six stages in order with their status, highlights the stage being viewed, and states the next action", () => {
    const h = html();
    const labels = ["Configuration", "Costing &amp; Estimator Review", "Manager Approval", "Customer Quotation", "Customer Acceptance", "Project Handover"];
    let at = -1; for (const l of labels) { const i = h.indexOf(l); expect(i, l).toBeGreaterThan(at); at = i; }
    for (const n of [1, 2, 3, 4, 5, 6]) expect(h).toContain(`data-stage="${n}"`);
    expect(h).toContain("Complete"); expect(h).toContain("Awaiting action"); expect(h).toContain("Not yet available");
    expect(h.match(/aria-current="step"/g)).toHaveLength(1);
    expect(h).toContain("Stage 4 · you are here");
    expect(h).toMatch(/Next: Rep: choose the payment schedule and generate the customer quotation PDF/);
  });
  it("lets a user inspect a different stage than the current one (the highlight follows the viewed stage, 'you are here' stays on the current one)", () => {
    const h = html({}, 2);
    expect(h).toMatch(/data-stage="2" aria-current="step"|aria-current="step" data-stage="2"/);
    expect(h).toContain("Stage 4 · you are here");
  });
  it("is responsive: one column on a phone, two on a tablet, six on a desktop", () => {
    const h = html();
    expect(h).toContain("grid-cols-1"); expect(h).toContain("sm:grid-cols-2"); expect(h).toContain("lg:grid-cols-6");
  });
  it("reports returned work and not-required (grandfathered) stages", () => {
    expect(html({ state: "REP_DRAFT", revision: 2, signedOff: false, commercial: "NOT_APPROVED", confirmed: false })).toContain("Returned");
    const g = html({ requiresAcceptance: false });
    expect(g).toContain("Not required");
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
