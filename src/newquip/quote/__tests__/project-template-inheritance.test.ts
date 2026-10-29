import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../../grower/evaluate";
import { readyDraft } from "../../grower/__tests__/golden";
import { testPriceSource } from "../../grower/__tests__/test-snapshot";
import { buildAcceptedBaseline, baselineMatchesHash } from "../baseline";
import { quoteToProjectBaseline } from "../to-project";
import { stagesFromInput, type ScheduleSource } from "../project-template";
import { NEWQUIP_STANDARD_SCHEDULE } from "../billing-schedule";

const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
const freeze = () => { const draft = readyDraft(); return buildAcceptedBaseline({ quoteRef: "NQ-Q-0011", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals }); };
const fourStages = (() => { const r = stagesFromInput([{ name: "Deposit", percent: "25" }, { name: "Manufacture", percent: "30" }, { name: "Delivery", percent: "30" }, { name: "Install", percent: "15" }]); if (!r.ok) throw new Error("fixture"); return r.stages; })();
const source: ScheduleSource = { kind: "TEMPLATE", templateId: "tpl-1", templateName: "Four stage", templateVersion: 2, customised: false };

describe("a project created from a four-stage template", () => {
  it("gets exactly those stages, reconciling to the approved contract to the cent", () => {
    const { baseline, hash } = freeze();
    const proj = quoteToProjectBaseline(baseline, hash, "q1", fourStages, source);
    expect(proj.suggestedStages.map((s) => s.name)).toEqual(["Deposit", "Manufacture", "Delivery", "Install"]);
    expect(proj.suggestedStages.reduce((n, s) => n + s.valueCents, 0)).toBe(baseline.contractCents);
    expect(proj.contractCents).toBe(baseline.contractCents); // the approved contract value is never touched
  });
  it("records the template version it came from, so a later edit has nothing to change", () => {
    const { baseline, hash } = freeze();
    const proj = quoteToProjectBaseline(baseline, hash, "q1", fourStages, source);
    expect(proj.provenance?.billingSchedule).toEqual(source);
    // the stages are a value copy: mutating the template's list afterwards does not reach the project
    const before = JSON.stringify(proj.suggestedStages);
    fourStages[0] = { ...fourStages[0], bps: 1 };
    expect(JSON.stringify(proj.suggestedStages)).toBe(before);
    fourStages[0] = { ...fourStages[0], bps: 2500 };
  });
  it("the standard 40/55/5 and a quote with no schedule choice are unchanged, and the sealed quotation is unaffected", () => {
    const { baseline, hash } = freeze();
    const std = quoteToProjectBaseline(baseline, hash, "q1");
    expect(std.suggestedStages.map((s) => s.name)).toEqual(NEWQUIP_STANDARD_SCHEDULE.map((s) => s.name));
    expect(std.provenance?.billingSchedule).toBeUndefined();
    expect(baselineMatchesHash(baseline, hash)).toBe(true);
  });
  it("an invalid schedule can never reach project creation", () => {
    const { baseline, hash } = freeze();
    expect(() => quoteToProjectBaseline(baseline, hash, "q1", [{ name: "Only", bps: 9000, description: "", trigger: "" }])).toThrow(/Invalid billing schedule/);
  });
});
