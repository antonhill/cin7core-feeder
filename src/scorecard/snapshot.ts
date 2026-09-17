import "server-only";
import type { MetricDefinition, ScorecardSnapshot, SectionDefinition } from "./types";

/**
 * Builds the immutable snapshot persisted into
 * scorecard_reviews.definition_snapshot at finalisation (brief §11). Pure —
 * takes the live definition rows already fetched by the caller and freezes
 * them into one JSON value. A later edit to scorecard_sections/
 * scorecard_metric_definitions can never reach back into an already-final
 * review, because the review no longer reads those tables at all once
 * finalised — see queries.ts's getReviewScoringInputs.
 */
export function buildScorecardSnapshot(scorecardDefinitionId: string, scorecardName: string, sections: SectionDefinition[], metrics: MetricDefinition[]): ScorecardSnapshot {
  return {
    scorecardDefinitionId,
    scorecardName,
    sections: sections
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((section) => ({
        ...section,
        metrics: metrics
          .filter((m) => m.scorecardSectionId === section.id && m.active)
          .slice()
          .sort((a, b) => a.displayOrder - b.displayOrder),
      })),
  };
}
