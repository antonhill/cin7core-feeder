import { describe, it, expect } from "vitest";
import { computeProgressClaim, ProjectInvariantError } from "../claim-engine";
import { assertSnapshotUnchanged, freezeClaimSnapshot, hashClaimSnapshot } from "../claim-snapshot";

const stages = [
  { id: "mfg", name: "Manufacturing", valueCents: 300_000_000 },
  { id: "rest", name: "Rest", valueCents: 700_000_000 },
];
const calc = (approvedBps: number) =>
  computeProgressClaim({
    contractCents: 1_000_000_000,
    stages,
    progress: [{ stageId: "mfg", approvedBps }],
    priorClaims: [],
    taxRateBps: 1500,
  });

describe("approved claim snapshot", () => {
  it("freezes figures and is immune to later stage-percentage changes", () => {
    const snap = freezeClaimSnapshot(calc(6500), 1500);
    const hash = hashClaimSnapshot(snap);
    // later the stage is re-approved at 90% — a fresh calculation differs, the frozen one does not
    const later = freezeClaimSnapshot(calc(9000), 1500);
    expect(hashClaimSnapshot(later)).not.toBe(hash);
    expect(snap.lines[0].approvedBps).toBe(6500);
    expect(snap.lines[0].earnedToDateCents).toBe(195_000_000);
    expect(() => assertSnapshotUnchanged(hash, snap)).not.toThrow();
  });
  it("is deep-frozen in memory", () => {
    const snap = freezeClaimSnapshot(calc(6500), 1500);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.lines)).toBe(true);
    expect(Object.isFrozen(snap.lines[0])).toBe(true);
    expect(() => {
      (snap.lines[0] as { currentClaimCents: number }).currentClaimCents = 1;
    }).toThrow();
  });
  it("detects drift against the stored hash", () => {
    const snap = freezeClaimSnapshot(calc(6500), 1500);
    const hash = hashClaimSnapshot(snap);
    const tampered = { ...snap, totalCents: snap.totalCents + 1 };
    try {
      assertSnapshotUnchanged(hash, tampered);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectInvariantError);
      expect((e as ProjectInvariantError).code).toBe("SNAPSHOT_MUTATED");
    }
  });
});
