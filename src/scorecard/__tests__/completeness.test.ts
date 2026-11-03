import { describe, expect, it } from "vitest";
import { findIncompleteKpis, isValidScore } from "../completeness";
import type { MetricDefinition, SectionDefinition } from "../types";

const section = (id: string, order: number): SectionDefinition => ({ id, scorecardDefinitionId: "d", name: `Sec ${id}`, weight: 0.5, displayOrder: order });
const metric = (id: string, sectionId: string, order = 1): MetricDefinition =>
  ({ id, scorecardSectionId: sectionId, name: `KPI ${id}`, displayOrder: order, active: true }) as MetricDefinition;

describe("isValidScore", () => {
  it.each([0, 0.5, 10])("%s is valid — including a genuine 0", (v) => expect(isValidScore(v)).toBe(true));
  it.each([null, undefined, Number.NaN, Infinity, -1, 10.01, "5", {}])("%s is not valid", (v) => expect(isValidScore(v)).toBe(false));
});

describe("findIncompleteKpis", () => {
  const sections = [section("b", 2), section("a", 1)];
  const metrics = [metric("m3", "b"), metric("m2", "a", 2), metric("m1", "a", 1)];

  it("is empty only when every active KPI has a valid score; zero counts as complete", () => {
    expect(findIncompleteKpis(sections, metrics, [{ metric_definition_id: "m1", score: 0 }, { metric_definition_id: "m2", score: 0 }, { metric_definition_id: "m3", score: 10 }])).toEqual([]);
  });

  it("reports missing rows, null scores and invalid scores distinctly, in scorecard order", () => {
    const out = findIncompleteKpis(sections, metrics, [{ metric_definition_id: "m2", score: null }, { metric_definition_id: "m3", score: 99 }]);
    expect(out.map((k) => [k.metricDefinitionId, k.reason])).toEqual([["m1", "missing"], ["m2", "missing"], ["m3", "invalid"]]);
  });

  it("with no results at all (the November 2026 shape) every KPI is incomplete", () => {
    expect(findIncompleteKpis(sections, metrics, [])).toHaveLength(3);
  });
});
