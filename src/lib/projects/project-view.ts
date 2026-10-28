// Projects POC — read model for the project screens (PURE). Derives the commercial position from
// stored rows. Three notions stay separate in the output: reported PHYSICAL %, APPROVED commercial %
// and BILLED/COMMITTED. Nothing here writes, and nothing here reads Cin7.
import { BPS_FULL, applyBps, reservesValue, isClaimStatus, type Bps, type Cents } from "./claim-engine";
import type { OpeningCommitmentRow } from "./opening-commitments";
import { cin7PocRepresentation, contractPosition, type CommitmentRepresentation, type VariationRow } from "./variations";

export interface ProjectRow {
  id: string;
  org_id: string;
  project_reference: string;
  name: string;
  customer_name: string;
  originating_quote_ref: string | null;
  original_contract_cents: number;
  currency: string;
  tax_rule: string | null;
  tax_rate_bps: number;
  salesperson: string | null;
  project_manager: string | null;
  start_date: string | null;
  target_completion_date: string | null;
  status: string;
  /** BASE, or VARIATION for a variation billing project (migration 0105). Absent on rows read before the migration: treat as BASE. */
  billing_scope?: "BASE" | "VARIATION";
  parent_project_id?: string | null;
  variation_id?: string | null;
}
export interface StageRow { id: string; sort_order: number; name: string; description: string | null; value_cents: number }
export interface ProgressEventRow {
  id: string; stage_id: string; reported_bps: number; approved_bps: number;
  previous_reported_bps: number | null; previous_approved_bps: number | null;
  comment: string | null; recorded_by_email: string; created_at: string;
}
export interface ClaimRow {
  id: string; claim_seq: number; claim_number: string; claim_date: string; status: string;
  subtotal_cents: number; tax_cents: number; total_cents: number;
  /** Audit lineage: the stale draft this claim superseded, if any. */
  supersedes_claim_id?: string | null;
}
export interface ClaimLineRow { claim_id: string; stage_id: string; current_claim_cents: number }
export interface AllocationRow {
  id: string; stage_id: string; baseline_line_ref: string; sku: string | null; description: string;
  quantity: number; sales_value_cents: number; estimated_cost_cents: number | null; allocation_bps: number;
}
export interface Cin7LinkRow { claim_id: string; cin7_invoice_number: string | null; cin7_status: string | null; reconciled_at: string | null }

export interface StageView {
  id: string;
  name: string;
  description: string | null;
  valueCents: Cents;
  shareBps: Bps;
  /** PHYSICAL progress as reported by the project team — informational, never billed from. */
  reportedBps: Bps;
  /** COMMERCIAL approval — the only completion figure that drives billing. */
  approvedBps: Bps;
  earnedCents: Cents;
  /** BILLED / COMMITTED: value held by claims that reserve it (approved, sent, uncertain). */
  committedCents: Cents;
  committedBps: Bps;
  claimableCents: Cents;
  remainingCents: Cents;
  /** Approved completion currently sits BELOW what is committed (needs a credit adjustment — future scope). */
  belowCommitted: boolean;
  history: ProgressEventRow[];
}

export interface ProjectView {
  project: ProjectRow;
  commercial: {
    originalContractCents: Cents;
    /** SUM of APPROVED variations only — draft and rejected variations never count. */
    approvedVariationsCents: Cents;
    revisedContractCents: Cents;
    earnedCents: Cents;
    committedCents: Cents;
    claimableCents: Cents;
    remainingCents: Cents;
    approvedCompletionBps: Bps; // earned / contract
    scheduleBalanced: boolean;
    uncertainClaimBlocking: boolean;
  };
  stages: StageView[];
  claims: Array<ClaimRow & { reserves: boolean; cin7: Cin7LinkRow | null }>;
  allocations: AllocationRow[];
  variations: VariationRow[];
  /** Value committed before the Toolbox claim workflow (already included in each stage's committed amount). */
  openingCommitments: OpeningCommitmentRow[];
  /** Opening commitments may be set/edited only while the project has no claims. */
  openingCommitmentsLocked: boolean;
  /** Display-only representation of the intended Cin7 documents (nothing is sent). */
  cin7Representation: CommitmentRepresentation[];
}

const half = (num: number, den: number): number => (den === 0 ? 0 : Math.floor((num * 2 + den) / (den * 2)));

export function buildProjectView(input: {
  project: ProjectRow;
  stages: StageRow[];
  events: ProgressEventRow[];
  claims: ClaimRow[];
  claimLines: ClaimLineRow[];
  allocations: AllocationRow[];
  links: Cin7LinkRow[];
  variations?: VariationRow[];
  openingCommitments?: OpeningCommitmentRow[];
}): ProjectView {
  const { project } = input;
  const stages = [...input.stages].sort((a, b) => a.sort_order - b.sort_order);
  const stageTotal = stages.reduce((n, s) => n + s.value_cents, 0);

  const reservingClaimIds = new Set(input.claims.filter((c) => isClaimStatus(c.status) && reservesValue(c.status)).map((c) => c.id));
  const committedByStage = new Map<string, number>();
  for (const l of input.claimLines) {
    if (!reservingClaimIds.has(l.claim_id)) continue;
    committedByStage.set(l.stage_id, (committedByStage.get(l.stage_id) ?? 0) + l.current_claim_cents);
  }
  const openingRows = input.openingCommitments ?? [];
  for (const o of openingRows) committedByStage.set(o.stage_id, (committedByStage.get(o.stage_id) ?? 0) + o.amount_cents);

  const stageViews: StageView[] = stages.map((s) => {
    const history = input.events
      .filter((e) => e.stage_id === s.id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const latest = history[0];
    const approvedBps = latest?.approved_bps ?? 0;
    const reportedBps = latest?.reported_bps ?? 0;
    const earned = applyBps(s.value_cents, approvedBps);
    const committed = committedByStage.get(s.id) ?? 0;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      valueCents: s.value_cents,
      shareBps: half(s.value_cents * BPS_FULL, project.original_contract_cents),
      reportedBps,
      approvedBps,
      earnedCents: earned,
      committedCents: committed,
      committedBps: half(committed * BPS_FULL, s.value_cents),
      claimableCents: Math.max(0, earned - committed),
      remainingCents: s.value_cents - committed,
      belowCommitted: earned < committed,
      history,
    };
  });

  const earned = stageViews.reduce((n, s) => n + s.earnedCents, 0);
  const committed = stageViews.reduce((n, s) => n + s.committedCents, 0);
  const claimable = stageViews.reduce((n, s) => n + s.claimableCents, 0);
  const linkByClaim = new Map(input.links.map((l) => [l.claim_id, l]));
  const variationRows = input.variations ?? [];
  const position = contractPosition(project.original_contract_cents, variationRows);
  const variations = position.approvedVariationsCents;

  return {
    project,
    commercial: {
      originalContractCents: project.original_contract_cents,
      approvedVariationsCents: variations,
      revisedContractCents: position.revisedContractCents,
      earnedCents: earned,
      committedCents: committed,
      claimableCents: claimable,
      remainingCents: project.original_contract_cents + variations - committed,
      approvedCompletionBps: half(earned * BPS_FULL, project.original_contract_cents),
      scheduleBalanced: stageTotal === project.original_contract_cents,
      uncertainClaimBlocking: input.claims.some((c) => c.status === "FAILED_UNCERTAIN"),
    },
    stages: stageViews,
    claims: [...input.claims]
      .sort((a, b) => b.claim_seq - a.claim_seq)
      .map((c) => ({ ...c, reserves: isClaimStatus(c.status) && reservesValue(c.status), cin7: linkByClaim.get(c.id) ?? null })),
    allocations: input.allocations,
    openingCommitments: openingRows,
    openingCommitmentsLocked: input.claims.length > 0,
    variations: [...variationRows].sort((a, b) => (a.code < b.code ? -1 : 1)),
    cin7Representation: cin7PocRepresentation(project.original_contract_cents, variationRows),
  };
}

/** Formatting helper for UI/tests: integer cents -> "R 1,950,000.00" without floating-point. */
export function formatCents(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const c = (abs % 100).toString().padStart(2, "0");
  // U+00A0 (non-breaking) so the currency symbol can never wrap away from the amount.
  return `${neg ? "-" : ""}R\u00A0${rands}.${c}`;
}

/** bps -> "65%" / "62.5%" / "0.25%" (trims trailing zeros). */
export function formatBps(bps: Bps): string {
  const whole = Math.floor(bps / 100);
  const frac = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}%`;
}
