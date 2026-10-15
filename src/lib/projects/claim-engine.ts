// Projects POC — percentage-completion progress-claim engine (PURE: no I/O, no Cin7, no DB).
//
// Billing basis is CONTRACT VALUE x APPROVED COMMERCIAL COMPLETION, never expenses x markup.
// Three notions are deliberately kept apart and never collapsed into one "% complete":
//   1. reported physical completion  (informational — never feeds this engine)
//   2. approved commercial completion (the ONLY completion input to a claim)
//   3. billed percentage              (derived from prior committed claims)
//
// MONEY: integer minor units (cents) only. PERCENTAGES: integer basis points (1 bp = 0.01%,
// so 65% = 6500, 62.5% = 6250). No floating-point arithmetic touches a money value: every
// product is an integer < 2^53 (guarded by MAX_CENTS) and rounding is explicit half-up.
// The repo's `round2` (quote-margin.ts) is a float display helper and is deliberately NOT used.

/** Money in integer cents. */
export type Cents = number;
/** Percentage in integer basis points; 10000 = 100%. */
export type Bps = number;

export const BPS_FULL = 10_000;
/** Upper bound on any money amount (R10bn) so cents x bps stays well below 2^53. */
export const MAX_CENTS = 1_000_000_000_000;

export class ProjectInvariantError extends Error {
  constructor(
    public code: ProjectInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectInvariantError";
  }
}

export type ProjectInvariantCode =
  | "NOT_INTEGER_MONEY"
  | "MONEY_OUT_OF_RANGE"
  | "NEGATIVE_STAGE_VALUE"
  | "NO_STAGES"
  | "DUPLICATE_STAGE"
  | "SCHEDULE_NOT_BALANCED"
  | "COMPLETION_OUT_OF_RANGE"
  | "BILLED_EXCEEDS_STAGE_VALUE"
  | "COMPLETION_BELOW_BILLED"
  | "CLAIM_EXCEEDS_STAGE_VALUE"
  | "CLAIM_EXCEEDS_CONTRACT"
  | "UNKNOWN_STAGE"
  | "NOTHING_TO_CLAIM"
  | "INVALID_TAX_RATE"
  | "MISSING_COMMERCIAL_DATA"
  | "BASELINE_MUTATED";

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export function assertCents(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new ProjectInvariantError("NOT_INTEGER_MONEY", `${what} must be an integer number of cents (got ${value}).`);
  }
  if (value < 0 || value > MAX_CENTS) {
    throw new ProjectInvariantError("MONEY_OUT_OF_RANGE", `${what} is outside the supported range (got ${value}).`);
  }
}

export function assertBps(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > BPS_FULL) {
    throw new ProjectInvariantError(
      "COMPLETION_OUT_OF_RANGE",
      `${what} must be an integer number of basis points between 0 and ${BPS_FULL} (got ${value}).`,
    );
  }
}

/** round_half_up(cents * bps / 10000) for non-negative integers. Exact: operands are bounded. */
export function applyBps(cents: Cents, bps: Bps): Cents {
  return Math.floor((cents * bps * 2 + BPS_FULL) / (BPS_FULL * 2));
}

/** Convert a decimal-string percentage ("65", "62.5", "0.25") to basis points without float maths. */
export function percentToBps(input: string): Bps {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) {
    throw new ProjectInvariantError("COMPLETION_OUT_OF_RANGE", `"${input}" is not a valid percentage (max 2 decimal places).`);
  }
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  assertBps(bps, "Percentage");
  return bps;
}

/** Convert a decimal-string amount ("1950000", "450000.50") to cents without float maths. */
export function randsToCents(input: string): Cents {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new ProjectInvariantError("NOT_INTEGER_MONEY", `"${input}" is not a valid amount (max 2 decimal places).`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  assertCents(cents, "Amount");
  return cents;
}

// ---------------------------------------------------------------------------------------------
// Schedule of values
// ---------------------------------------------------------------------------------------------

export interface StageInput {
  id: string;
  name: string;
  description?: string | null;
  /** Agreed commercial value of this stage, ex tax, in cents. */
  valueCents: Cents;
}

export interface ScheduleCheck {
  stageTotalCents: Cents;
  contractCents: Cents;
  differenceCents: Cents; // contract - stages (0 when balanced)
  balanced: boolean;
  /** Each stage's share of the contract in bps, rounded half-up — DISPLAY ONLY, never billed from. */
  displayBps: Record<string, Bps>;
}

/** Validate the Schedule of Values. Throws — it never silently tolerates an imbalance. */
export function checkSchedule(contractCents: Cents, stages: StageInput[]): ScheduleCheck {
  assertCents(contractCents, "Contract value");
  if (stages.length === 0) throw new ProjectInvariantError("NO_STAGES", "A project needs at least one stage.");
  const seen = new Set<string>();
  let total = 0;
  for (const s of stages) {
    if (!s.id || !s.name.trim()) {
      throw new ProjectInvariantError("MISSING_COMMERCIAL_DATA", "Every stage needs an id and a name.");
    }
    if (seen.has(s.id)) throw new ProjectInvariantError("DUPLICATE_STAGE", `Duplicate stage id "${s.id}".`);
    seen.add(s.id);
    if (Number.isSafeInteger(s.valueCents) && s.valueCents < 0) {
      throw new ProjectInvariantError("NEGATIVE_STAGE_VALUE", `Stage "${s.name}" has a negative value.`);
    }
    assertCents(s.valueCents, `Stage "${s.name}" value`);
    total += s.valueCents;
  }
  const difference = contractCents - total;
  if (difference !== 0) {
    throw new ProjectInvariantError(
      "SCHEDULE_NOT_BALANCED",
      total > contractCents
        ? `Stage values exceed the contract baseline by ${total - contractCents} cents.`
        : `Stage values fall short of the contract baseline by ${difference} cents.`,
    );
  }
  const displayBps: Record<string, Bps> = {};
  for (const s of stages) displayBps[s.id] = contractCents === 0 ? 0 : Math.floor((s.valueCents * BPS_FULL * 2 + contractCents) / (contractCents * 2));
  return { stageTotalCents: total, contractCents, differenceCents: 0, balanced: true, displayBps };
}

// ---------------------------------------------------------------------------------------------
// Prior billing
// ---------------------------------------------------------------------------------------------

/**
 * Claim states whose amounts count as ALREADY BILLED (reserved) against a stage. APPROVED counts
 * as soon as it is approved — otherwise a second claim drafted before the first is sent would
 * re-bill the same value. CIN7_PENDING stays counted while its outcome is ambiguous. FAILED is
 * excluded: a claim may only be moved to FAILED once reconciliation has PROVEN no Cin7 invoice
 * exists (the same "never assume a failed request created nothing" rule as quote/PO creation).
 */
export const COMMITTED_CLAIM_STATUSES = ["APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED"] as const;
export type ClaimStatus =
  | "DRAFT"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "CIN7_PENDING"
  | "CIN7_CREATED"
  | "RECONCILED"
  | "FAILED";

export interface CommittedClaimLine {
  stageId: string;
  currentClaimCents: Cents;
}
export interface PriorClaim {
  claimId: string;
  status: ClaimStatus;
  lines: CommittedClaimLine[];
}

export function priorBilledByStage(priorClaims: PriorClaim[]): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const c of priorClaims) {
    if (!(COMMITTED_CLAIM_STATUSES as readonly string[]).includes(c.status)) continue;
    for (const l of c.lines) {
      assertCents(l.currentClaimCents, "Prior claim line");
      out.set(l.stageId, (out.get(l.stageId) ?? 0) + l.currentClaimCents);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Claim calculation
// ---------------------------------------------------------------------------------------------

export interface StageProgressInput {
  stageId: string;
  /** APPROVED commercial completion — the only completion figure that drives billing. */
  approvedBps: Bps;
  /** Reported physical completion — carried for display/audit, NEVER used in any calculation. */
  reportedBps?: Bps | null;
}

export interface StageClaimLine {
  stageId: string;
  stageName: string;
  stageValueCents: Cents;
  approvedBps: Bps;
  reportedBps: Bps | null;
  earnedToDateCents: Cents;
  previouslyBilledCents: Cents;
  /** Billed-to-date as bps of stage value (round half-up) — for "from 50% to 65%" presentation. */
  previouslyBilledBps: Bps;
  currentClaimCents: Cents;
  taxCents: Cents;
  remainingUnbilledCents: Cents; // stage value - (previously billed + current)
}

export interface ProgressClaimCalc {
  lines: StageClaimLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  /** Cumulative billed across the project INCLUDING this claim. */
  cumulativeBilledCents: Cents;
  remainingContractCents: Cents;
}

export interface ClaimInput {
  contractCents: Cents;
  stages: StageInput[];
  progress: StageProgressInput[];
  priorClaims: PriorClaim[];
  /** Tax rate in bps (15% = 1500). Tax is rounded half-up PER LINE, matching how Cin7 takes a per-line Tax figure. */
  taxRateBps: Bps;
  /** Restrict the claim to these stages; default = every stage with a positive current claim. */
  selectedStageIds?: string[];
}

/** Per-stage maths: earned = value x approved; current = earned - previously billed. */
export function computeStageClaim(valueCents: Cents, approvedBps: Bps, previouslyBilledCents: Cents) {
  assertCents(valueCents, "Stage value");
  assertBps(approvedBps, "Approved completion");
  assertCents(previouslyBilledCents, "Previously billed");
  if (previouslyBilledCents > valueCents) {
    throw new ProjectInvariantError("BILLED_EXCEEDS_STAGE_VALUE", "Previously billed already exceeds the stage value.");
  }
  const earned = applyBps(valueCents, approvedBps);
  const current = earned - previouslyBilledCents;
  if (current < 0) {
    // Approved completion was lowered below what has already been billed. Un-billing is a credit
    // note (out of POC scope) — fail closed rather than emit a negative claim line.
    throw new ProjectInvariantError(
      "COMPLETION_BELOW_BILLED",
      "Approved completion is below the amount already billed; a credit adjustment is required (future scope).",
    );
  }
  return { earnedToDateCents: earned, currentClaimCents: current };
}

export function computeProgressClaim(input: ClaimInput): ProgressClaimCalc {
  const { contractCents, stages, progress, priorClaims, taxRateBps } = input;
  checkSchedule(contractCents, stages);
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > BPS_FULL) {
    throw new ProjectInvariantError("INVALID_TAX_RATE", `Tax rate must be 0–100% in basis points (got ${taxRateBps}).`);
  }
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const progressById = new Map<string, StageProgressInput>();
  for (const p of progress) {
    if (!stageById.has(p.stageId)) throw new ProjectInvariantError("UNKNOWN_STAGE", `Progress references unknown stage "${p.stageId}".`);
    if (progressById.has(p.stageId)) throw new ProjectInvariantError("DUPLICATE_STAGE", `Duplicate progress for stage "${p.stageId}".`);
    assertBps(p.approvedBps, "Approved completion");
    if (p.reportedBps != null) assertBps(p.reportedBps, "Reported completion");
    progressById.set(p.stageId, p);
  }
  const selected = input.selectedStageIds ? new Set(input.selectedStageIds) : null;
  if (selected) for (const id of selected) if (!stageById.has(id)) throw new ProjectInvariantError("UNKNOWN_STAGE", `Selected stage "${id}" does not exist.`);

  const billed = priorBilledByStage(priorClaims);
  for (const id of billed.keys()) if (!stageById.has(id)) throw new ProjectInvariantError("UNKNOWN_STAGE", `A prior claim references unknown stage "${id}".`);

  const lines: StageClaimLine[] = [];
  let subtotal = 0;
  let tax = 0;
  let cumulativeBilled = 0;
  for (const stage of stages) {
    const prior = billed.get(stage.id) ?? 0;
    cumulativeBilled += prior;
    if (selected && !selected.has(stage.id)) continue;
    const p = progressById.get(stage.id);
    // A stage with no recorded approved completion has earned nothing new; prior billing still stands.
    const approvedBps = p?.approvedBps ?? 0;
    const { earnedToDateCents, currentClaimCents } = computeStageClaim(stage.valueCents, approvedBps, prior);
    if (currentClaimCents === 0) continue;
    const lineTax = applyBps(currentClaimCents, taxRateBps);
    if (prior + currentClaimCents > stage.valueCents) {
      throw new ProjectInvariantError("CLAIM_EXCEEDS_STAGE_VALUE", `Cumulative claims for "${stage.name}" would exceed its stage value.`);
    }
    lines.push({
      stageId: stage.id,
      stageName: stage.name,
      stageValueCents: stage.valueCents,
      approvedBps,
      reportedBps: p?.reportedBps ?? null,
      earnedToDateCents,
      previouslyBilledCents: prior,
      previouslyBilledBps: Math.floor((prior * BPS_FULL * 2 + stage.valueCents) / (stage.valueCents * 2)),
      currentClaimCents,
      taxCents: lineTax,
      remainingUnbilledCents: stage.valueCents - prior - currentClaimCents,
    });
    subtotal += currentClaimCents;
    tax += lineTax;
    cumulativeBilled += currentClaimCents;
  }
  if (lines.length === 0) throw new ProjectInvariantError("NOTHING_TO_CLAIM", "There is nothing new to claim for the selected stages.");
  if (cumulativeBilled > contractCents) {
    throw new ProjectInvariantError("CLAIM_EXCEEDS_CONTRACT", "Cumulative claims would exceed the project contract value.");
  }
  return {
    lines,
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: subtotal + tax,
    cumulativeBilledCents: cumulativeBilled,
    remainingContractCents: contractCents - cumulativeBilled,
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline immutability
// ---------------------------------------------------------------------------------------------

/**
 * Canonical string of the commercial baseline (contract + customer + org + ordered stages). A hash
 * of this is stored when the first claim commits; any later difference means the baseline mutated
 * under a committed claim and the next claim must fail closed. Variations will be additive rows,
 * never an edit of this snapshot.
 */
export function canonicalBaseline(b: { orgId: string; customerId: string; contractCents: Cents; stages: StageInput[] }): string {
  return JSON.stringify({
    o: b.orgId,
    c: b.customerId,
    v: b.contractCents,
    s: b.stages.map((s) => [s.id, s.name, s.valueCents]),
  });
}

export function assertBaselineUnchanged(committedCanonical: string, current: string): void {
  if (committedCanonical !== current) {
    throw new ProjectInvariantError("BASELINE_MUTATED", "The project baseline changed after a claim was committed; claiming is blocked.");
  }
}
