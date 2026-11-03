import type { MetricDefinition, SectionDefinition } from "./types";

/**
 * A KPI that blocks finalisation, with enough context for the UI to link
 * straight to it.
 *
 *   missing — no result row, or the score is null (Not Scored).
 *   invalid — a score is present but is not a finite number in [0, 10].
 */
export interface IncompleteKpi {
  metricDefinitionId: string;
  metricName: string;
  sectionId: string;
  sectionName: string;
  reason: "missing" | "invalid";
}

/**
 * Whether a stored/entered score is a usable value. 0 IS valid — a real zero is
 * a poor result, not missing data. null/undefined is missing, never coerced to
 * 0. NaN/Infinity/out-of-range are invalid.
 */
export function isValidScore(score: unknown): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10;
}

/**
 * Every active KPI of the scorecard must carry a valid score before a review
 * may be finalised (owner decision: all KPIs are mandatory). Returns the KPIs
 * that do not, in scorecard order (section order, then KPI order). An empty
 * array means the review is complete.
 *
 * Pure and dependency-free so the server action, the history screen and the
 * tests all apply exactly one definition of "complete". The database function
 * scorecard_finalise_review re-checks the same rule independently.
 */
export function findIncompleteKpis(
  sections: SectionDefinition[],
  metrics: MetricDefinition[],
  results: { metric_definition_id: string; score: number | null | undefined }[]
): IncompleteKpi[] {
  const scoreByMetric = new Map(results.map((r) => [r.metric_definition_id, r.score]));
  const incomplete: IncompleteKpi[] = [];

  const orderedSections = [...sections].sort((a, b) => a.displayOrder - b.displayOrder);
  for (const section of orderedSections) {
    const sectionMetrics = metrics.filter((m) => m.scorecardSectionId === section.id).sort((a, b) => a.displayOrder - b.displayOrder);
    for (const metric of sectionMetrics) {
      const score = scoreByMetric.get(metric.id);
      if (score === null || score === undefined) {
        incomplete.push({ metricDefinitionId: metric.id, metricName: metric.name, sectionId: section.id, sectionName: section.name, reason: "missing" });
      } else if (!isValidScore(score)) {
        incomplete.push({ metricDefinitionId: metric.id, metricName: metric.name, sectionId: section.id, sectionName: section.name, reason: "invalid" });
      }
    }
  }
  return incomplete;
}
