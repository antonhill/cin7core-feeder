import { describe, expect, it } from "vitest";
import { computeHeadlineScore, computeHeadlineResults, computeOverallScore, computeRuleScore, deriveStatus } from "../scoring";
import type { HeadlineResult, MetricResult, SectionDefinition } from "../types";

describe("deriveStatus — score-to-status boundaries", () => {
  it("Not Scored is null, never a status derived from 0", () => {
    expect(deriveStatus(null)).toBe("not_scored");
  });

  it.each([
    [10, "strong"],
    [9, "strong"],
    [8.99, "acceptable"],
    [7, "acceptable"],
    [6.99, "needs_attention"],
    [5, "needs_attention"],
    [4.99, "serious_weakness"],
    [3, "serious_weakness"],
    [2.99, "critical"],
    [1, "critical"],
    [0.5, "critical"],
    [0, "critical"],
  ] as const)("score %s -> %s", (score, status) => {
    expect(deriveStatus(score)).toBe(status);
  });
});

describe("computeRuleScore — direction handling", () => {
  const bands = [
    { threshold: 95, score: 10 },
    { threshold: 90, score: 8 },
    { threshold: 80, score: 5 },
  ];

  it("HIGHER_IS_BETTER picks the highest band the actual clears", () => {
    expect(computeRuleScore(97, "HIGHER_IS_BETTER", { bands })).toBe(10);
    expect(computeRuleScore(91, "HIGHER_IS_BETTER", { bands })).toBe(8);
    expect(computeRuleScore(80, "HIGHER_IS_BETTER", { bands })).toBe(5);
  });

  it("HIGHER_IS_BETTER below every band returns null, not 0", () => {
    expect(computeRuleScore(10, "HIGHER_IS_BETTER", { bands })).toBeNull();
  });

  it("LOWER_IS_BETTER picks the lowest band the actual is under (inverse metric, e.g. incorrect deliveries)", () => {
    const lowerBands = [
      { threshold: 0, score: 10 },
      { threshold: 1, score: 7 },
      { threshold: 5, score: 3 },
    ];
    expect(computeRuleScore(0, "LOWER_IS_BETTER", { bands: lowerBands })).toBe(10);
    expect(computeRuleScore(0.5, "LOWER_IS_BETTER", { bands: lowerBands })).toBe(7);
    expect(computeRuleScore(3, "LOWER_IS_BETTER", { bands: lowerBands })).toBe(3);
  });

  it("LOWER_IS_BETTER above every band returns null, not 0", () => {
    const lowerBands = [{ threshold: 1, score: 10 }];
    expect(computeRuleScore(50, "LOWER_IS_BETTER", { bands: lowerBands })).toBeNull();
  });

  it("refuses to invent scoring semantics for TARGET_RANGE or REVIEW_ONLY", () => {
    expect(() => computeRuleScore(50, "TARGET_RANGE", { bands })).toThrow();
    expect(() => computeRuleScore(50, "REVIEW_ONLY", { bands })).toThrow();
  });

  it("clamps an out-of-range configured band score into 0-10", () => {
    expect(computeRuleScore(100, "HIGHER_IS_BETTER", { bands: [{ threshold: 0, score: 15 }] })).toBe(10);
    expect(computeRuleScore(100, "HIGHER_IS_BETTER", { bands: [{ threshold: 0, score: -5 }] })).toBe(0);
  });
});

describe("computeHeadlineScore — weighted and equal-weighted KPI rollup", () => {
  it("equal-weights scored metrics when no explicit weight is set (brief default)", () => {
    const result = computeHeadlineScore([
      { weight: null, result: { metricDefinitionId: "a", score: 8 } },
      { weight: null, result: { metricDefinitionId: "b", score: 4 } },
    ]);
    expect(result).toBe(6);
  });

  it("uses explicit weights, renormalised over only the weighted+scored metrics", () => {
    const result = computeHeadlineScore([
      { weight: 0.75, result: { metricDefinitionId: "a", score: 10 } },
      { weight: 0.25, result: { metricDefinitionId: "b", score: 2 } },
    ]);
    expect(result).toBe(8);
  });

  it("Not Scored metrics are excluded, never treated as 0", () => {
    const withGap = computeHeadlineScore([
      { weight: null, result: { metricDefinitionId: "a", score: 8 } },
      { weight: null, result: { metricDefinitionId: "b", score: null } },
      { weight: null, result: undefined },
    ]);
    // Only "a" (score 8) counts — if the null/undefined ones were treated
    // as 0, this would be (8+0+0)/3 = 2.67, not 8.
    expect(withGap).toBe(8);
  });

  it("every metric Not Scored -> the headline itself is Not Scored (null), never 0", () => {
    const result = computeHeadlineScore([
      { weight: null, result: { metricDefinitionId: "a", score: null } },
      { weight: null, result: undefined },
    ]);
    expect(result).toBeNull();
  });

  it("no metrics at all -> null, no divide-by-zero", () => {
    expect(computeHeadlineScore([])).toBeNull();
  });

  it("all-zero explicit weights among scored metrics -> null, no divide-by-zero", () => {
    const result = computeHeadlineScore([
      { weight: 0, result: { metricDefinitionId: "a", score: 9 } },
      { weight: 0, result: { metricDefinitionId: "b", score: 3 } },
    ]);
    expect(result).toBeNull();
  });
});

describe("computeOverallScore — weighted headline rollup", () => {
  const headlines = (scores: (number | null)[]): HeadlineResult[] =>
    scores.map((score, i) => ({ sectionId: `s${i}`, weight: [0.2, 0.2, 0.2, 0.15, 0.15, 0.1][i], score }));

  it("SUM(headline score x headline weight) when every headline is scored", () => {
    // 8*.2 + 6*.2 + 9*.2 + 5*.15 + 7*.15 + 4*.1 = 1.6+1.2+1.8+0.75+1.05+0.4 = 6.8
    const result = computeOverallScore(headlines([8, 6, 9, 5, 7, 4]));
    expect(result).toBe(6.8);
  });

  it("renormalises over scored headlines when one headline is entirely Not Scored", () => {
    // Weights sum to 1.0 across all six; dropping the null one (weight .1)
    // and renormalising over the remaining .9 must NOT silently score the
    // gap as 0 and must not divide by the full 1.0 either.
    const withGap = computeOverallScore(headlines([10, 10, 10, 10, 10, null]));
    // (10*.2+10*.2+10*.2+10*.15+10*.15)/(0.2+0.2+0.2+0.15+0.15) = 10
    expect(withGap).toBe(10);
  });

  it("every headline Not Scored -> overall is Not Scored (null), not 0", () => {
    expect(computeOverallScore(headlines([null, null, null, null, null, null]))).toBeNull();
  });

  it("no headlines -> null, no divide-by-zero", () => {
    expect(computeOverallScore([])).toBeNull();
  });

  it("matches the brief's own worked dashboard example shape (6.4/10, Needs Attention band)", () => {
    // Not the brief's literal seeded numbers (none were supplied — this is
    // a synthetic check that a plausible real spread lands in the
    // documented band, not a claim about LBL's actual current score).
    const result = computeOverallScore(headlines([6.5, 6.0, 7.0, 6.5, 6.0, 6.0]));
    expect(result).not.toBeNull();
    expect(deriveStatus(result as number)).toBe("needs_attention");
  });
});

describe("computeHeadlineResults — joins sections to their metric/result pairs consistently", () => {
  it("produces one HeadlineResult per section, preserving section weight", () => {
    const sections: SectionDefinition[] = [
      { id: "sec-1", scorecardDefinitionId: "def-1", name: "Order Flow", weight: 0.2, displayOrder: 1 },
      { id: "sec-2", scorecardDefinitionId: "def-1", name: "Dispatch Performance", weight: 0.15, displayOrder: 2 },
    ];
    const byResult: MetricResult[] = [
      { metricDefinitionId: "m1", score: 8 },
      { metricDefinitionId: "m2", score: 6 },
    ];
    const metricsBySection = new Map<string, { weight: number | null; result: MetricResult | undefined }[]>([
      ["sec-1", [{ weight: null, result: byResult[0] }]],
      ["sec-2", [{ weight: null, result: byResult[1] }]],
    ]);

    const results = computeHeadlineResults(sections, metricsBySection);
    expect(results).toEqual([
      { sectionId: "sec-1", weight: 0.2, score: 8 },
      { sectionId: "sec-2", weight: 0.15, score: 6 },
    ]);
  });

  it("a section with no entry in the map scores Not Scored, not an error", () => {
    const sections: SectionDefinition[] = [{ id: "sec-1", scorecardDefinitionId: "def-1", name: "Order Flow", weight: 0.2, displayOrder: 1 }];
    const results = computeHeadlineResults(sections, new Map());
    expect(results).toEqual([{ sectionId: "sec-1", weight: 0.2, score: null }]);
  });
});
