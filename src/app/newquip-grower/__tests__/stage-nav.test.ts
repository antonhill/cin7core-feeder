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
