// Projects POC — frozen financial snapshot of an approved claim (PURE).
//
// Once a claim is APPROVED its figures are a historical record: stage value, approved %, earned,
// previously-committed, current, tax, total. They are stored on the claim lines and NEVER recomputed
// from current stage percentages. `hashClaimSnapshot` yields a stable digest that is persisted with
// the claim; `assertSnapshotUnchanged` fails closed if anything drifts afterwards.
import { createHash } from "node:crypto";
import { ProjectInvariantError, type ProgressClaimCalc } from "./claim-engine";

export interface ClaimSnapshot {
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lines: Array<{
    stageId: string;
    stageValueCents: number;
    approvedBps: number;
    earnedToDateCents: number;
    previouslyBilledCents: number;
    currentClaimCents: number;
    taxCents: number;
  }>;
}

/** Deep-frozen snapshot of a calculation, so in-process code cannot mutate it after approval. */
export function freezeClaimSnapshot(calc: ProgressClaimCalc, taxRateBps: number): Readonly<ClaimSnapshot> {
  const snap: ClaimSnapshot = {
    taxRateBps,
    subtotalCents: calc.subtotalCents,
    taxCents: calc.taxCents,
    totalCents: calc.totalCents,
    lines: calc.lines.map((l) => ({
      stageId: l.stageId,
      stageValueCents: l.stageValueCents,
      approvedBps: l.approvedBps,
      earnedToDateCents: l.earnedToDateCents,
      previouslyBilledCents: l.previouslyBilledCents,
      currentClaimCents: l.currentClaimCents,
      taxCents: l.taxCents,
    })),
  };
  for (const l of snap.lines) Object.freeze(l);
  Object.freeze(snap.lines);
  return Object.freeze(snap);
}

export function hashClaimSnapshot(s: ClaimSnapshot): string {
  const canonical = JSON.stringify([
    s.taxRateBps,
    s.subtotalCents,
    s.taxCents,
    s.totalCents,
    s.lines.map((l) => [l.stageId, l.stageValueCents, l.approvedBps, l.earnedToDateCents, l.previouslyBilledCents, l.currentClaimCents, l.taxCents]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function assertSnapshotUnchanged(storedHash: string, current: ClaimSnapshot): void {
  if (storedHash !== hashClaimSnapshot(current)) {
    throw new ProjectInvariantError("SNAPSHOT_MUTATED", "An approved claim's financial snapshot no longer matches its stored hash.");
  }
}
