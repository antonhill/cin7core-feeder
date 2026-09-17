/**
 * Shared types for the generic Warehouse Performance Scorecard engine.
 * Mirrors supabase/migrations/0092_warehouse_performance_scorecard.sql's
 * enums/columns exactly — keep the two in sync by hand (no codegen here).
 */

/** Whether Toolbox computes the actual/evidence, or a reviewer enters it. Independent of ScoringMethod — see 0092's own header comment. */
export type EvidenceSource = "AUTOMATED" | "MANUAL";

/** Whether the 0-10 score is derived from a configured rule, or entered/confirmed by a reviewer. Never inferred from EvidenceSource. */
export type ScoringMethod = "RULE" | "REVIEWER";

export type MetricDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER" | "TARGET_RANGE" | "REVIEW_ONLY";

export type ReviewStatus = "draft" | "final";

export type ActionStatus = "open" | "completed";

export type ScoreStatus = "strong" | "acceptable" | "needs_attention" | "serious_weakness" | "critical" | "not_scored";

/** One band of a RULE scoring_config: "evidence at or past this threshold scores at least `score`." Direction (from the metric's own metric_direction) decides which way "threshold" compares. Unused by every KPI seeded in Phase 1 (all scoring_method = REVIEWER) — present for a future, explicitly-approved conversion. */
export interface ScoringBand {
  threshold: number;
  score: number;
}

export interface RuleScoringConfig {
  bands: ScoringBand[];
}

export interface MetricDefinition {
  id: string;
  scorecardSectionId: string;
  category: string;
  name: string;
  targetText: string | null;
  evidenceSource: EvidenceSource;
  scoringMethod: ScoringMethod;
  metricDirection: MetricDirection;
  scoringConfig: RuleScoringConfig | null;
  /** Fraction of the section's weight this KPI carries; null = equal-weight among the section's active, scored metrics. */
  weight: number | null;
  displayOrder: number;
  active: boolean;
  sourceNote: string | null;
}

export interface SectionDefinition {
  id: string;
  scorecardDefinitionId: string;
  name: string;
  /** Fraction of the overall score — sections for one scorecard_definition always sum to 1.0 (DB-enforced by 0092's trigger). */
  weight: number;
  displayOrder: number;
}

/** One KPI's captured result within a review — the unit computeHeadlineScore/computeOverallScore consume. `score: null` is "Not Scored" and must never be silently treated as 0. */
export interface MetricResult {
  metricDefinitionId: string;
  score: number | null;
}

export interface HeadlineResult {
  sectionId: string;
  weight: number;
  /** null when every metric in this section is Not Scored — must propagate as "not scored" for this headline, never as 0. */
  score: number | null;
}

/**
 * Immutable snapshot of everything a finalised review's scores depended on,
 * persisted into scorecard_reviews.definition_snapshot at finalisation
 * (brief §11 — non-negotiable). A later edit to the live
 * scorecard_metric_definitions/scorecard_sections rows must never change
 * what a finalised review reports.
 */
export interface ScorecardSnapshot {
  scorecardDefinitionId: string;
  scorecardName: string;
  sections: (SectionDefinition & {
    metrics: MetricDefinition[];
  })[];
}
