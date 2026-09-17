import "server-only";
import type { HeadlineResult, MetricDirection, MetricResult, RuleScoringConfig, ScoreStatus, SectionDefinition } from "./types";

/**
 * Status bands from the brief, verbatim:
 *   9.00-10.00 Strong · 7.00-8.99 Acceptable · 5.00-6.99 Needs Attention ·
 *   3.00-4.99 Serious Weakness · 1.00-2.99 Critical
 * The brief leaves 0.00-0.99 undefined (its lowest named band starts at
 * 1.00). A `null` score is Not Scored, never 0 — so a real 0 must still map
 * somewhere; this extends Critical down to 0 rather than leaving a gap,
 * since a genuine zero is a worse outcome than 1.00-2.99, not an undefined
 * one. Status is ALWAYS derived from score by this one function — nowhere
 * in this codebase should status be entered or stored independently of it
 * (brief §5: "Do not store independently editable score and status
 * values").
 */
export function deriveStatus(score: number | null): ScoreStatus {
  if (score === null) return "not_scored";
  if (score >= 9) return "strong";
  if (score >= 7) return "acceptable";
  if (score >= 5) return "needs_attention";
  if (score >= 3) return "serious_weakness";
  return "critical";
}

export const SCORE_STATUS_LABELS: Record<ScoreStatus, string> = {
  strong: "Strong",
  acceptable: "Acceptable",
  needs_attention: "Needs Attention",
  serious_weakness: "Serious Weakness",
  critical: "Critical",
  not_scored: "Not Scored",
};

/**
 * Evaluates a RULE scoring_config against a numeric actual, honouring
 * metric_direction (brief §7 — "never assume higher = better"). Unused by
 * any KPI seeded in Phase 1 (every one is scoring_method = REVIEWER) but
 * implemented and tested now so a future, explicitly-approved RULE
 * conversion has a single correct place to live rather than being
 * reinvented ad hoc per metric.
 *
 * HIGHER_IS_BETTER: the highest band whose threshold the actual meets or
 * exceeds wins (bands sorted descending by threshold internally).
 * LOWER_IS_BETTER: the lowest band whose threshold the actual meets or
 * is under wins (bands sorted ascending).
 * TARGET_RANGE and REVIEW_ONLY have no numeric rule evaluation — calling
 * this with either throws, since no band-comparison semantics were
 * specified for them by the brief; inventing one here would be exactly the
 * "invent a scoring rule" mistake the brief explicitly forbids.
 */
export function computeRuleScore(actual: number, direction: MetricDirection, config: RuleScoringConfig): number | null {
  if (direction === "TARGET_RANGE" || direction === "REVIEW_ONLY") {
    throw new Error(`computeRuleScore has no defined band semantics for direction ${direction} — do not invent one.`);
  }
  if (config.bands.length === 0) return null;

  if (direction === "HIGHER_IS_BETTER") {
    const sorted = [...config.bands].sort((a, b) => b.threshold - a.threshold);
    const hit = sorted.find((b) => actual >= b.threshold);
    return hit ? clampScore(hit.score) : null;
  }

  // LOWER_IS_BETTER
  const sorted = [...config.bands].sort((a, b) => a.threshold - b.threshold);
  const hit = sorted.find((b) => actual <= b.threshold);
  return hit ? clampScore(hit.score) : null;
}

function clampScore(score: number): number {
  return Math.min(10, Math.max(0, score));
}

/**
 * A section's headline score: the weighted (or, absent explicit per-KPI
 * weights, equal-weighted) average of its SCORED metrics only.
 *
 * Not-Scored metrics are excluded from both the numerator and the
 * denominator — never treated as a 0 that would drag the average down, and
 * never padded to look complete. If every metric in the section is
 * Not Scored, the headline itself is Not Scored (`null`), which is a
 * distinct, visible state from "this headline scored 0" or "this headline
 * scored acceptably by ignoring its gaps."
 *
 * `metrics` must be the section's full active metric set with their
 * configured `weight` (see MetricDefinition) paired with the review's
 * captured `score` for that metric — callers join results in before
 * calling this.
 */
export function computeHeadlineScore(metrics: { weight: number | null; result: MetricResult | undefined }[]): number | null {
  const scored = metrics.filter((m) => m.result && m.result.score !== null) as { weight: number | null; result: MetricResult }[];
  if (scored.length === 0) return null;

  const explicitWeightSum = scored.reduce((sum, m) => sum + (m.weight ?? 0), 0);
  const hasAnyExplicitWeight = scored.some((m) => m.weight !== null);

  if (!hasAnyExplicitWeight) {
    // Equal weighting among the scored metrics (brief §6 default).
    const total = scored.reduce((sum, m) => sum + (m.result.score as number), 0);
    return roundScore(total / scored.length);
  }

  // Mixed or fully explicit weights: metrics without an explicit weight
  // are excluded from a weighted average (an unweighted metric sitting
  // alongside explicitly-weighted siblings has no defined contribution —
  // treating it as 0 weight is the only interpretation that doesn't
  // silently invent a number, and it still counts as configured input the
  // caller should complete rather than a system default).
  const weighted = scored.filter((m) => m.weight !== null);
  if (weighted.length === 0 || explicitWeightSum <= 0) return null;
  const total = weighted.reduce((sum, m) => sum + (m.weight as number) * (m.result.score as number), 0);
  return roundScore(total / explicitWeightSum);
}

/**
 * Overall Warehouse Health Score: SUM(headline score × headline weight)
 * (brief §14), renormalised over only the headlines that have a score —
 * same "exclude, don't zero" rule as computeHeadlineScore, applied one
 * level up. Section weights for one scorecard_definition always sum to 1.0
 * (DB-enforced), so when every headline is scored this is exactly the
 * brief's plain weighted sum with no renormalisation needed; renormalising
 * only changes the result when some headline is Not Scored.
 */
export function computeOverallScore(headlines: HeadlineResult[]): number | null {
  const scored = headlines.filter((h): h is HeadlineResult & { score: number } => h.score !== null);
  if (scored.length === 0) return null;
  const weightSum = scored.reduce((sum, h) => sum + h.weight, 0);
  if (weightSum <= 0) return null;
  const total = scored.reduce((sum, h) => sum + h.score * h.weight, 0);
  return roundScore(total / weightSum);
}

/** Two decimal places — matches the brief's own band precision (e.g. "8.99"). */
function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Builds the six HeadlineResult rows for computeOverallScore from raw sections + per-section metric/result pairs — the one place this join happens, so the dashboard and the finalisation path can never disagree about how a headline rolls up. */
export function computeHeadlineResults(
  sections: SectionDefinition[],
  metricsBySection: Map<string, { weight: number | null; result: MetricResult | undefined }[]>
): HeadlineResult[] {
  return sections.map((section) => ({
    sectionId: section.id,
    weight: section.weight,
    score: computeHeadlineScore(metricsBySection.get(section.id) ?? []),
  }));
}
