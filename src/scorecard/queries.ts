import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";
import type { ActionStatus, EvidenceSource, MetricDefinition, MetricDirection, ReviewStatus, ScorecardSnapshot, ScoringMethod, SectionDefinition } from "./types";

type Db = ReturnType<typeof createServiceRoleClient>;

interface SectionRow {
  id: string;
  scorecard_definition_id: string;
  name: string;
  weight: number;
  display_order: number;
}

interface MetricDefinitionRow {
  id: string;
  scorecard_section_id: string;
  category: string;
  name: string;
  target_text: string | null;
  evidence_source: EvidenceSource;
  scoring_method: ScoringMethod;
  metric_direction: MetricDirection;
  scoring_config: { bands: { threshold: number; score: number }[] } | null;
  weight: number | null;
  display_order: number;
  active: boolean;
  source_note: string | null;
}

function toSectionDefinition(row: SectionRow): SectionDefinition {
  return { id: row.id, scorecardDefinitionId: row.scorecard_definition_id, name: row.name, weight: row.weight, displayOrder: row.display_order };
}

function toMetricDefinition(row: MetricDefinitionRow): MetricDefinition {
  return {
    id: row.id,
    scorecardSectionId: row.scorecard_section_id,
    category: row.category,
    name: row.name,
    targetText: row.target_text,
    evidenceSource: row.evidence_source,
    scoringMethod: row.scoring_method,
    metricDirection: row.metric_direction,
    scoringConfig: row.scoring_config,
    weight: row.weight,
    displayOrder: row.display_order,
    active: row.active,
    sourceNote: row.source_note,
  };
}

export interface OrgScorecard {
  organizationScorecardId: string;
  scorecardDefinitionId: string;
  scorecardName: string;
  reviewFrequency: string;
  sections: SectionDefinition[];
  metrics: MetricDefinition[];
  /**
   * Which of this org's Cin7 instances the scorecard's automated evidence
   * (dashboard, bottleneck queues) should be scoped to — null/empty means
   * every instance on the org, which is WRONG whenever an org's Toolbox
   * tenant spans more than one real business (confirmed live: "I-Light and
   * LBL" is one org with two instances, "Lights by Linea" and "I-Light" —
   * without this, LBL's own scorecard would silently include I-Light's
   * orders too). Stored in organization_scorecards.settings rather than a
   * new column, since it's per-assignment configuration, not part of the
   * shared scorecard template.
   */
  instanceIds: string[] | null;
}

/**
 * The one place "which scorecard does this org actually have, right now"
 * is answered — every dashboard/review/queue action in
 * src/app/warehouse-performance/actions.ts calls this after its module
 * gate, and null here means "not configured for this org", the same
 * distinction Natas Sold draws between module access and its own separate
 * org-specific gate (see organization_scorecards' own migration comment).
 */
export async function getEnabledOrgScorecard(db: Db, orgId: string): Promise<OrgScorecard | null> {
  const { data: assignment, error: assignmentError } = await db
    .from("organization_scorecards")
    .select("id, scorecard_definition_id, settings")
    .eq("organization_id", orgId)
    .eq("enabled", true)
    .maybeSingle();
  if (assignmentError) throw new Error(assignmentError.message);
  if (!assignment) return null;

  const settings = (assignment.settings ?? {}) as { instanceIds?: string[] };
  const instanceIds = Array.isArray(settings.instanceIds) && settings.instanceIds.length > 0 ? settings.instanceIds : null;

  const { data: definition, error: definitionError } = await db
    .from("scorecard_definitions")
    .select("id, name, review_frequency, active")
    .eq("id", assignment.scorecard_definition_id)
    .maybeSingle();
  if (definitionError) throw new Error(definitionError.message);
  if (!definition || !definition.active) return null;

  const { data: sectionRows, error: sectionsError } = await db
    .from("scorecard_sections")
    .select("id, scorecard_definition_id, name, weight, display_order")
    .eq("scorecard_definition_id", definition.id)
    .order("display_order");
  if (sectionsError) throw new Error(sectionsError.message);

  const sectionIds = (sectionRows ?? []).map((s) => s.id);
  const { data: metricRows, error: metricsError } = await db
    .from("scorecard_metric_definitions")
    .select(
      "id, scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, scoring_config, weight, display_order, active, source_note"
    )
    .in("scorecard_section_id", sectionIds.length > 0 ? sectionIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("active", true)
    .order("display_order");
  if (metricsError) throw new Error(metricsError.message);

  return {
    organizationScorecardId: assignment.id,
    scorecardDefinitionId: definition.id,
    scorecardName: definition.name,
    reviewFrequency: definition.review_frequency,
    sections: (sectionRows ?? []).map(toSectionDefinition),
    metrics: (metricRows ?? []).map(toMetricDefinition),
    instanceIds,
  };
}

export interface ReviewRow {
  id: string;
  organization_id: string;
  scorecard_definition_id: string;
  review_period: string;
  status: ReviewStatus;
  overall_score: number | null;
  definition_snapshot: ScorecardSnapshot | null;
  created_by: string | null;
  finalised_by: string | null;
  finalised_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetricResultRow {
  id: string;
  review_id: string;
  metric_definition_id: string;
  actual_numeric: number | null;
  actual_text: string | null;
  evidence: unknown;
  score: number | null;
  status: string;
  comment: string | null;
  owner: string | null;
  reviewer_id: string | null;
  calculated_at: string | null;
}

/** Normalises "2026-09-17" or a Date into the first-of-month string a review_period column expects. */
export function normaliseReviewPeriod(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function getOrCreateDraftReview(db: Db, orgId: string, scorecardDefinitionId: string, reviewPeriod: string, createdBy: string): Promise<ReviewRow> {
  const { data: existing, error: existingError } = await db
    .from("scorecard_reviews")
    .select("*")
    .eq("organization_id", orgId)
    .eq("scorecard_definition_id", scorecardDefinitionId)
    .eq("review_period", reviewPeriod)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) return existing as ReviewRow;

  const { data: created, error: createError } = await db
    .from("scorecard_reviews")
    .insert({ organization_id: orgId, scorecard_definition_id: scorecardDefinitionId, review_period: reviewPeriod, status: "draft", created_by: createdBy })
    .select("*")
    .single();
  if (createError) throw new Error(createError.message);
  return created as ReviewRow;
}

export async function listReviews(db: Db, orgId: string, scorecardDefinitionId: string, limit = 24): Promise<ReviewRow[]> {
  const { data, error } = await db
    .from("scorecard_reviews")
    .select("*")
    .eq("organization_id", orgId)
    .eq("scorecard_definition_id", scorecardDefinitionId)
    .order("review_period", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as ReviewRow[];
}

export async function getReview(db: Db, reviewId: string, orgId: string): Promise<ReviewRow | null> {
  const { data, error } = await db.from("scorecard_reviews").select("*").eq("id", reviewId).eq("organization_id", orgId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ReviewRow | null) ?? null;
}

export async function listMetricResults(db: Db, reviewId: string): Promise<MetricResultRow[]> {
  const { data, error } = await db.from("scorecard_metric_results").select("*").eq("review_id", reviewId);
  if (error) throw new Error(error.message);
  return (data ?? []) as MetricResultRow[];
}

export interface ActionRow {
  id: string;
  organization_id: string;
  review_id: string | null;
  metric_result_id: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  due_date: string | null;
  status: ActionStatus;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
}

export async function listActions(db: Db, orgId: string, statusFilter?: ActionStatus): Promise<ActionRow[]> {
  let query = db.from("scorecard_actions").select("*").eq("organization_id", orgId).order("due_date", { ascending: true, nullsFirst: false });
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ActionRow[];
}
