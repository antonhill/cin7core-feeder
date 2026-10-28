// Projects — OPENING COMMITMENTS (pure). Value already committed / certified before the project entered the Toolbox claim
// workflow. They count toward each stage's billed/committed; the claim formula (earned - committed) is untouched. They are not
// claims: no Cin7 link, no progress change, no contract change.
import type { PriorClaim } from "./claim-engine";

export interface OpeningCommitmentRow {
  id: string;
  stage_id: string;
  amount_cents: number;
  reason: string;
  recorded_by_email: string;
  recorded_at: string;
}

/** Represents the opening commitments as one reserving "prior claim" so the existing engine aggregates them unchanged. */
export function openingAsPriorClaim(rows: readonly Pick<OpeningCommitmentRow, "stage_id" | "amount_cents">[]): PriorClaim {
  return { claimId: "opening-commitments", status: "APPROVED", lines: rows.map((r) => ({ stageId: r.stage_id, currentClaimCents: r.amount_cents })) };
}
