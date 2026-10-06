"use server";

import { mapDashboardQueueRows, type ClosedShippedUninvoiced, type DashboardQueueRow } from "@/scorecard/queue-summary";
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { WAREHOUSE_PERFORMANCE_MODULE } from "@/app/module-nav";
import { getEnabledOrgScorecard, getOrCreateDraftReview, getReview, listActions, listMetricResults, listReviews, normaliseReviewPeriod, type ActionRow, type MetricResultRow, type ReviewRow } from "@/scorecard/queries";
import { computeHeadlineResults, computeOverallScore, deriveStatus } from "@/scorecard/scoring";
import { buildScorecardSnapshot } from "@/scorecard/snapshot";
import type { ActionStatus, HeadlineResult, MetricDefinition, MetricResult, ScoreStatus, SectionDefinition } from "@/scorecard/types";

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface HeadlineSummary {
  sectionId: string;
  name: string;
  weight: number;
  score: number | null;
  status: ScoreStatus;
}

export interface DashboardSummary {
  scorecardName: string;
  currentReview: { id: string; reviewPeriod: string; status: "draft" | "final"; overallScore: number | null; status_: ScoreStatus } | null;
  headlines: HeadlineSummary[];
  previousOverallScore: number | null;
  changeFromPrevious: number | null;
  /** Orders with an invoiced fulfilment whose Ship state cannot be classified — EXCLUDED from every bottleneck total above, shown separately until resolved. */
  shipmentStateUnclear: { currentCount: number; oldestAgeDays: number | null; unclearQty: number };
  /** Commercial control, NOT a warehouse KPI queue: Cin7-closed/shipped orders whose packed quantity exceeds invoiced quantity. */
  closedShippedUninvoiced: ClosedShippedUninvoiced;
  bottleneckSummary: { queue: string; currentCount: number; oldestAgeDays: number | null; outsideSlaCount: number | null; totalValue: number | null }[];
  openActionsCount: number;
  overdueActionsCount: number;
}

function groupMetricsBySection(metrics: MetricDefinition[]): Map<string, MetricDefinition[]> {
  const map = new Map<string, MetricDefinition[]>();
  for (const m of metrics) {
    const list = map.get(m.scorecardSectionId) ?? [];
    list.push(m);
    map.set(m.scorecardSectionId, list);
  }
  return map;
}

function resultsByMetric(results: MetricResultRow[]): Map<string, MetricResult> {
  const map = new Map<string, MetricResult>();
  for (const r of results) map.set(r.metric_definition_id, { metricDefinitionId: r.metric_definition_id, score: r.score });
  return map;
}

function computeHeadlines(sections: SectionDefinition[], metrics: MetricDefinition[], results: MetricResultRow[]): HeadlineResult[] {
  const bySection = groupMetricsBySection(metrics);
  const byMetric = resultsByMetric(results);
  const metricsBySection = new Map<string, { weight: number | null; result: MetricResult | undefined }[]>();
  for (const section of sections) {
    const sectionMetrics = bySection.get(section.id) ?? [];
    metricsBySection.set(
      section.id,
      sectionMetrics.map((m) => ({ weight: m.weight, result: byMetric.get(m.id) }))
    );
  }
  return computeHeadlineResults(sections, metricsBySection);
}

/**
 * The module's landing-page data: overall score, six headlines, bottleneck
 * cards, and open/overdue action counts. Reads the CURRENT calendar month's
 * review (creating a blank draft the first time it's opened in a given
 * month — nothing is scored until a reviewer or an automated evidence pull
 * enters something) plus the prior month's finalised review for
 * comparison, matching the brief's "current score / previous month /
 * change" dashboard requirement.
 */
export async function getWarehousePerformanceDashboardAction(): Promise<ActionResult<DashboardSummary>> {
  try {
    const { orgId, userId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    const db = createServiceRoleClient();

    const scorecard = await getEnabledOrgScorecard(db, orgId);
    if (!scorecard) return { ok: false, error: "Warehouse Performance is not configured for your organization." };

    const period = normaliseReviewPeriod(new Date());
    const currentReview = await getOrCreateDraftReview(db, orgId, scorecard.scorecardDefinitionId, period, userId);
    const results = currentReview.status === "draft" ? await listMetricResults(db, currentReview.id) : await listMetricResults(db, currentReview.id);

    const headlineResults = computeHeadlines(scorecard.sections, scorecard.metrics, results);
    const overall = currentReview.status === "final" ? currentReview.overall_score : computeOverallScore(headlineResults);

    const reviews = await listReviews(db, orgId, scorecard.scorecardDefinitionId, 3);
    const previousFinal = reviews.find((r) => r.id !== currentReview.id && r.status === "final") ?? null;

    // ONE call for the whole queue panel (the four KPI queues + the shipment-unclear
    // count): the queue view is evaluated once instead of once per RPC, which is what
    // keeps this page inside PostgREST's 8 s statement timeout on a cold cache.
    const { data: queueRows, error: queueError } = await db.rpc("report_scorecard_bottleneck_dashboard", {
      p_org_id: orgId,
      p_instance_ids: scorecard.instanceIds,
    });
    if (queueError) throw new Error(queueError.message);
    const { bottleneckSummary, shipmentStateUnclear, closedShippedUninvoiced } = mapDashboardQueueRows(queueRows as DashboardQueueRow[] | null);

    const actionsOpen = await listActions(db, orgId, "open");
    const today = new Date().toISOString().slice(0, 10);

    const headlines: HeadlineSummary[] = scorecard.sections.map((section) => {
      const hr = headlineResults.find((h) => h.sectionId === section.id);
      return { sectionId: section.id, name: section.name, weight: section.weight, score: hr?.score ?? null, status: deriveStatus(hr?.score ?? null) };
    });

    return {
      ok: true,
      data: {
        scorecardName: scorecard.scorecardName,
        currentReview: { id: currentReview.id, reviewPeriod: currentReview.review_period, status: currentReview.status, overallScore: overall, status_: deriveStatus(overall) },
        headlines,
        previousOverallScore: previousFinal?.overall_score ?? null,
        changeFromPrevious: overall !== null && previousFinal?.overall_score != null ? Math.round((overall - previousFinal.overall_score) * 100) / 100 : null,
        shipmentStateUnclear,
        closedShippedUninvoiced,
        bottleneckSummary,
        openActionsCount: actionsOpen.length,
        overdueActionsCount: actionsOpen.filter((a) => a.due_date && a.due_date < today).length,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface MetricRow {
  metricDefinitionId: string;
  sectionName: string;
  category: string;
  name: string;
  targetText: string | null;
  evidenceSource: string;
  scoringMethod: string;
  metricDirection: string;
  actualNumeric: number | null;
  actualText: string | null;
  score: number | null;
  status: ScoreStatus;
  comment: string | null;
  owner: string | null;
  sourceNote: string | null;
}

export interface ReviewDetail {
  reviewId: string;
  reviewPeriod: string;
  status: "draft" | "final";
  overallScore: number | null;
  metrics: MetricRow[];
}

/** The full 33-KPI review screen for a given period (defaults to the current month). */
export async function getReviewDetailAction(reviewPeriod?: string): Promise<ActionResult<ReviewDetail>> {
  try {
    const { orgId, userId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    const db = createServiceRoleClient();

    const scorecard = await getEnabledOrgScorecard(db, orgId);
    if (!scorecard) return { ok: false, error: "Warehouse Performance is not configured for your organization." };

    const period = normaliseReviewPeriod(reviewPeriod ?? new Date());
    const review = await getOrCreateDraftReview(db, orgId, scorecard.scorecardDefinitionId, period, userId);
    const results = await listMetricResults(db, review.id);
    const byMetric = new Map(results.map((r) => [r.metric_definition_id, r]));

    const sectionNames = new Map(scorecard.sections.map((s) => [s.id, s.name]));
    const metrics: MetricRow[] = scorecard.metrics.map((m) => {
      const r = byMetric.get(m.id);
      return {
        metricDefinitionId: m.id,
        sectionName: sectionNames.get(m.scorecardSectionId) ?? "",
        category: m.category,
        name: m.name,
        targetText: m.targetText,
        evidenceSource: m.evidenceSource,
        scoringMethod: m.scoringMethod,
        metricDirection: m.metricDirection,
        actualNumeric: r?.actual_numeric ?? null,
        actualText: r?.actual_text ?? null,
        score: r?.score ?? null,
        status: deriveStatus(r?.score ?? null),
        comment: r?.comment ?? null,
        owner: r?.owner ?? null,
        sourceNote: m.sourceNote,
      };
    });

    return { ok: true, data: { reviewId: review.id, reviewPeriod: review.review_period, status: review.status, overallScore: review.overall_score, metrics } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Saves one KPI's actual/score/comment/owner within a still-draft review.
 * Owner/admin only (brief §12: entering reviewer scores/comments is an
 * owner/admin capability, viewing is any module-permitted member) — module
 * access alone is NOT enough to write a result.
 */
export async function saveMetricResultAction(
  reviewId: string,
  metricDefinitionId: string,
  input: { actualNumeric?: number | null; actualText?: string | null; score: number | null; comment?: string | null; owner?: string | null }
): Promise<ActionResult<null>> {
  try {
    const { orgId, userId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    await requireOrgAdmin("complete a Warehouse Performance review");

    if (input.score !== null && input.score !== undefined && (input.score < 0 || input.score > 10)) return { ok: false, error: "Score must be between 0 and 10." };

    const db = createServiceRoleClient();

    const review = await getReview(db, reviewId, orgId);
    if (!review) return { ok: false, error: "Review not found." };
    if (review.status === "final") return { ok: false, error: "This review is finalised and cannot be edited." };

    const { error } = await db.from("scorecard_metric_results").upsert(
      {
        review_id: reviewId,
        metric_definition_id: metricDefinitionId,
        actual_numeric: input.actualNumeric ?? null,
        actual_text: input.actualText ?? null,
        score: input.score,
        status: deriveStatus(input.score),
        comment: input.comment ?? null,
        owner: input.owner ?? null,
        reviewer_id: userId,
        calculated_at: new Date().toISOString(),
      },
      { onConflict: "review_id,metric_definition_id" }
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Finalises a review: computes headline + overall scores from its current
 * results, snapshots the live scorecard definition, and flips status to
 * 'final'. Irreversible from here — the DB triggers in 0092 then block any
 * further mutation of this review or its results (brief §11).
 */
export async function finalizeReviewAction(reviewId: string): Promise<ActionResult<{ overallScore: number | null }>> {
  try {
    const { orgId, userId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    await requireOrgAdmin("finalise a Warehouse Performance review");
    const db = createServiceRoleClient();

    const review = await getReview(db, reviewId, orgId);
    if (!review) return { ok: false, error: "Review not found." };
    if (review.status === "final") return { ok: false, error: "This review is already finalised." };

    const scorecard = await getEnabledOrgScorecard(db, orgId);
    if (!scorecard || scorecard.scorecardDefinitionId !== review.scorecard_definition_id) {
      return { ok: false, error: "Warehouse Performance is not configured for your organization." };
    }

    const results = await listMetricResults(db, reviewId);
    const headlineResults = computeHeadlines(scorecard.sections, scorecard.metrics, results);
    const overallScore = computeOverallScore(headlineResults);
    const snapshot = buildScorecardSnapshot(scorecard.scorecardDefinitionId, scorecard.scorecardName, scorecard.sections, scorecard.metrics);

    const { error } = await db
      .from("scorecard_reviews")
      .update({ status: "final", overall_score: overallScore, definition_snapshot: snapshot, finalised_by: userId, finalised_at: new Date().toISOString() })
      .eq("id", reviewId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);

    return { ok: true, data: { overallScore } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ReviewHistoryEntry {
  reviewId: string;
  reviewPeriod: string;
  status: "draft" | "final";
  overallScore: number | null;
}

export async function listReviewHistoryAction(): Promise<ActionResult<ReviewHistoryEntry[]>> {
  try {
    const { orgId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    const db = createServiceRoleClient();
    const scorecard = await getEnabledOrgScorecard(db, orgId);
    if (!scorecard) return { ok: false, error: "Warehouse Performance is not configured for your organization." };
    const reviews = await listReviews(db, orgId, scorecard.scorecardDefinitionId, 13);
    return { ok: true, data: reviews.map((r: ReviewRow) => ({ reviewId: r.id, reviewPeriod: r.review_period, status: r.status, overallScore: r.overall_score })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ── Bottleneck queues ───────────────────────────────────────────────────

export interface BottleneckOrderRow {
  cin7SaleId: string;
  instanceId: string;
  orderNumber: string | null;
  customerName: string | null;
  orderDate: string | null;
  shipBy: string | null;
  ageDays: number | null;
  relevantQty: number | null;
  invoiceAmount: number | null;
  hasOpenPo: boolean;
}

const VALID_QUEUES = ["ready_to_pick", "packed_not_invoiced", "invoiced_not_shipped", "backorders_awaiting_stock", "shipment_state_unclear", "closed_shipped_uninvoiced"] as const;

export async function listBottleneckOrdersAction(queue: string): Promise<ActionResult<BottleneckOrderRow[]>> {
  try {
    if (!VALID_QUEUES.includes(queue as (typeof VALID_QUEUES)[number])) return { ok: false, error: "Unknown queue." };
    const { orgId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    const db = createServiceRoleClient();
    const scorecard = await getEnabledOrgScorecard(db, orgId);
    if (!scorecard) return { ok: false, error: "Warehouse Performance is not configured for your organization." };
    const { data, error } = await db.rpc("report_scorecard_bottleneck_orders", { p_org_id: orgId, p_queue: queue, p_instance_ids: scorecard.instanceIds });
    if (error) throw new Error(error.message);
    return {
      ok: true,
      data: (data ?? []).map(
        (r: {
          cin7_sale_id: string;
          instance_id: string;
          order_number: string | null;
          customer_name: string | null;
          order_date: string | null;
          ship_by: string | null;
          age_days: number | null;
          relevant_qty: number | null;
          invoice_amount: number | null;
          has_open_po: boolean;
        }) => ({
          cin7SaleId: r.cin7_sale_id,
          instanceId: r.instance_id,
          orderNumber: r.order_number,
          customerName: r.customer_name,
          orderDate: r.order_date,
          shipBy: r.ship_by,
          ageDays: r.age_days,
          relevantQty: r.relevant_qty,
          invoiceAmount: r.invoice_amount,
          hasOpenPo: r.has_open_po,
        })
      ),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// ── Corrective actions ──────────────────────────────────────────────────

export interface CorrectiveActionRow {
  id: string;
  title: string;
  description: string | null;
  owner: string | null;
  dueDate: string | null;
  status: ActionStatus;
  completedAt: string | null;
  overdue: boolean;
}

export async function listCorrectiveActionsAction(statusFilter?: ActionStatus): Promise<ActionResult<CorrectiveActionRow[]>> {
  try {
    const { orgId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    const db = createServiceRoleClient();
    const rows = await listActions(db, orgId, statusFilter);
    const today = new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      data: rows.map((r: ActionRow) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        owner: r.owner,
        dueDate: r.due_date,
        status: r.status,
        completedAt: r.completed_at,
        overdue: r.status === "open" && !!r.due_date && r.due_date < today,
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function createCorrectiveActionAction(input: {
  title: string;
  description?: string | null;
  owner?: string | null;
  dueDate?: string | null;
  reviewId?: string | null;
  metricResultId?: string | null;
}): Promise<ActionResult<null>> {
  try {
    if (!input.title.trim()) return { ok: false, error: "Title is required." };
    const { orgId, userId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    await requireOrgAdmin("create a Warehouse Performance corrective action");
    const db = createServiceRoleClient();
    const { error } = await db.from("scorecard_actions").insert({
      organization_id: orgId,
      review_id: input.reviewId ?? null,
      metric_result_id: input.metricResultId ?? null,
      title: input.title.trim(),
      description: input.description ?? null,
      owner: input.owner ?? null,
      due_date: input.dueDate ?? null,
      created_by: userId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function completeCorrectiveActionAction(actionId: string): Promise<ActionResult<null>> {
  try {
    const { orgId } = await requireModuleAccess(WAREHOUSE_PERFORMANCE_MODULE.href);
    await requireOrgAdmin("complete a Warehouse Performance corrective action");
    const db = createServiceRoleClient();
    const { error } = await db
      .from("scorecard_actions")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
