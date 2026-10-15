import { describe, it, expect } from "vitest";
import {
  applyBps,
  assertBaselineUnchanged,
  canonicalBaseline,
  checkSchedule,
  computeProgressClaim,
  percentToBps,
  priorBilledByStage,
  randsToCents,
  ProjectInvariantError,
  type ClaimInput,
  type PriorClaim,
  type StageInput,
} from "../claim-engine";

const R = (rands: number): number => rands * 100; // integer rands -> cents (test fixtures only)

const CONTRACT = R(10_000_000);
const STAGES: StageInput[] = [
  { id: "deposit", name: "Deposit / Commencement", valueCents: R(1_000_000) },
  { id: "mfg", name: "Manufacturing", valueCents: R(3_000_000) },
  { id: "ready", name: "Equipment Ready", valueCents: R(2_000_000) },
  { id: "delivery", name: "Delivery", valueCents: R(2_000_000) },
  { id: "install", name: "Installation", valueCents: R(1_500_000) },
  { id: "commission", name: "Commissioning", valueCents: R(500_000) },
];
const VAT_15 = 1500;

/** Deposit fully billed (claim #0), Manufacturing 50% billed — the golden "previously billed" state. */
const PRIOR_0: PriorClaim = {
  claimId: "claim-0",
  status: "RECONCILED",
  lines: [
    { stageId: "deposit", currentClaimCents: R(1_000_000) },
    { stageId: "mfg", currentClaimCents: R(1_500_000) },
  ],
};

function goldenInput(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    contractCents: CONTRACT,
    stages: STAGES,
    progress: [
      { stageId: "deposit", approvedBps: 10_000 },
      { stageId: "mfg", approvedBps: 6_500, reportedBps: 7_500 }, // reported 75% != approved 65%
      { stageId: "delivery", approvedBps: 2_500 },
    ],
    priorClaims: [PRIOR_0],
    taxRateBps: VAT_15,
    ...over,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProjectInvariantError) return e.code;
    throw e;
  }
  return undefined;
}

describe("schedule of values", () => {
  it("golden stages reconcile exactly to the R10m contract and display 10/30/20/20/15/5%", () => {
    const c = checkSchedule(CONTRACT, STAGES);
    expect(c.balanced).toBe(true);
    expect(c.stageTotalCents).toBe(CONTRACT);
    expect(c.displayBps).toEqual({ deposit: 1000, mfg: 3000, ready: 2000, delivery: 2000, install: 1500, commission: 500 });
  });
  it("fails closed when stages exceed the contract", () => {
    const over = STAGES.map((s) => (s.id === "mfg" ? { ...s, valueCents: s.valueCents + 1 } : s));
    expect(code(() => checkSchedule(CONTRACT, over))).toBe("SCHEDULE_NOT_BALANCED");
  });
  it("fails closed when stages fall short (no silent imbalance)", () => {
    expect(code(() => checkSchedule(CONTRACT, STAGES.slice(1)))).toBe("SCHEDULE_NOT_BALANCED");
  });
  it("rejects negative, fractional-cent, duplicate and empty schedules", () => {
    expect(code(() => checkSchedule(0, [{ id: "a", name: "A", valueCents: -5 }]))).toBe("NEGATIVE_STAGE_VALUE");
    expect(code(() => checkSchedule(100, [{ id: "a", name: "A", valueCents: 99.5 }]))).toBe("NOT_INTEGER_MONEY");
    expect(code(() => checkSchedule(200, [{ id: "a", name: "A", valueCents: 100 }, { id: "a", name: "B", valueCents: 100 }]))).toBe("DUPLICATE_STAGE");
    expect(code(() => checkSchedule(0, []))).toBe("NO_STAGES");
  });
});

describe("golden claim #1", () => {
  it("reproduces Manufacturing R450,000 + Delivery R500,000 = R950,000 ex VAT exactly", () => {
    const r = computeProgressClaim(goldenInput());
    expect(r.lines.map((l) => l.stageId)).toEqual(["mfg", "delivery"]); // deposit fully billed -> no line
    const mfg = r.lines[0];
    expect(mfg.earnedToDateCents).toBe(R(1_950_000));
    expect(mfg.previouslyBilledCents).toBe(R(1_500_000));
    expect(mfg.previouslyBilledBps).toBe(5_000);
    expect(mfg.currentClaimCents).toBe(R(450_000));
    expect(r.lines[1].currentClaimCents).toBe(R(500_000));
    expect(r.subtotalCents).toBe(R(950_000));
    expect(r.taxCents).toBe(R(142_500));
    expect(r.totalCents).toBe(R(1_092_500));
  });
  it("is deterministic and never reads reported physical completion", () => {
    const a = computeProgressClaim(goldenInput());
    const b = computeProgressClaim(goldenInput({ progress: goldenInput().progress.map((p) => ({ ...p, reportedBps: 0 })) }));
    expect(b.lines.map((l) => l.currentClaimCents)).toEqual(a.lines.map((l) => l.currentClaimCents));
    expect(a.lines[0].reportedBps).toBe(7_500); // carried for display only
  });
  it("reports cumulative billed and remaining contract value", () => {
    const r = computeProgressClaim(goldenInput());
    expect(r.cumulativeBilledCents).toBe(R(1_000_000 + 1_500_000 + 950_000));
    expect(r.remainingContractCents).toBe(CONTRACT - r.cumulativeBilledCents);
  });
});

describe("golden claim #2 subtracts claim #1 (no re-billing)", () => {
  const claim1: PriorClaim = {
    claimId: "claim-1",
    status: "CIN7_CREATED",
    lines: [
      { stageId: "mfg", currentClaimCents: R(450_000) },
      { stageId: "delivery", currentClaimCents: R(500_000) },
    ],
  };
  it("same approvals + claim #1 committed => nothing new to claim", () => {
    expect(code(() => computeProgressClaim(goldenInput({ priorClaims: [PRIOR_0, claim1] })))).toBe("NOTHING_TO_CLAIM");
  });
  it("advancing approvals bills only the increment", () => {
    const r = computeProgressClaim(
      goldenInput({
        priorClaims: [PRIOR_0, claim1],
        progress: [
          { stageId: "deposit", approvedBps: 10_000 },
          { stageId: "mfg", approvedBps: 10_000 }, // 65 -> 100%
          { stageId: "delivery", approvedBps: 6_000 }, // 25 -> 60%
          { stageId: "ready", approvedBps: 5_000 },
        ],
      }),
    );
    const by = Object.fromEntries(r.lines.map((l) => [l.stageId, l.currentClaimCents]));
    expect(by).toEqual({ mfg: R(1_050_000), ready: R(1_000_000), delivery: R(700_000) });
    expect(r.subtotalCents).toBe(R(2_750_000));
  });
  it("an APPROVED-but-not-yet-sent claim already reserves its value; FAILED/DRAFT do not", () => {
    const approved = { ...claim1, status: "APPROVED" as const };
    expect(priorBilledByStage([approved]).get("mfg")).toBe(R(450_000));
    expect(priorBilledByStage([{ ...claim1, status: "FAILED" }]).size).toBe(0);
    expect(priorBilledByStage([{ ...claim1, status: "DRAFT" }]).size).toBe(0);
    expect(priorBilledByStage([{ ...claim1, status: "CIN7_PENDING" }]).get("delivery")).toBe(R(500_000));
  });
});

describe("hard invariants fail closed", () => {
  it("rejects approved completion < 0% and > 100%", () => {
    expect(code(() => computeProgressClaim(goldenInput({ progress: [{ stageId: "mfg", approvedBps: -1 }] })))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(code(() => computeProgressClaim(goldenInput({ progress: [{ stageId: "mfg", approvedBps: 10_001 }] })))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(code(() => computeProgressClaim(goldenInput({ progress: [{ stageId: "mfg", approvedBps: 65.5 }] })))).toBe("COMPLETION_OUT_OF_RANGE");
  });
  it("100% stage cap: claims can never exceed stage value", () => {
    const r = computeProgressClaim(goldenInput({ progress: [{ stageId: "mfg", approvedBps: 10_000 }, { stageId: "deposit", approvedBps: 10_000 }] }));
    expect(r.lines[0].remainingUnbilledCents).toBe(0);
    const overbilled: PriorClaim = { claimId: "x", status: "RECONCILED", lines: [{ stageId: "mfg", currentClaimCents: R(3_000_001) }] };
    expect(code(() => computeProgressClaim(goldenInput({ priorClaims: [overbilled] })))).toBe("BILLED_EXCEEDS_STAGE_VALUE");
  });
  it("project contract cap: cumulative billing cannot exceed the contract", () => {
    // every stage individually within its value, but a prior claim on an unknown/extra stage must not slip through
    const ghost: PriorClaim = { claimId: "g", status: "RECONCILED", lines: [{ stageId: "ghost", currentClaimCents: 1 }] };
    expect(code(() => computeProgressClaim(goldenInput({ priorClaims: [ghost] })))).toBe("UNKNOWN_STAGE");
  });
  it("lowering approved completion below billed fails closed (credit adjustment is future scope)", () => {
    expect(code(() => computeProgressClaim(goldenInput({ progress: [{ stageId: "mfg", approvedBps: 4_000 }] })))).toBe("COMPLETION_BELOW_BILLED");
  });
  it("rejects a bad tax rate and unknown stages", () => {
    expect(code(() => computeProgressClaim(goldenInput({ taxRateBps: 10_001 })))).toBe("INVALID_TAX_RATE");
    expect(code(() => computeProgressClaim(goldenInput({ selectedStageIds: ["nope"] })))).toBe("UNKNOWN_STAGE");
  });
  it("selectedStageIds narrows the claim to the chosen stages only", () => {
    const r = computeProgressClaim(goldenInput({ selectedStageIds: ["delivery"] }));
    expect(r.lines.map((l) => l.stageId)).toEqual(["delivery"]);
    expect(r.subtotalCents).toBe(R(500_000));
  });
  it("an unbalanced schedule blocks claiming entirely", () => {
    expect(code(() => computeProgressClaim(goldenInput({ contractCents: CONTRACT + 1 })))).toBe("SCHEDULE_NOT_BALANCED");
  });
});

describe("baseline immutability", () => {
  const base = { orgId: "org-1", customerId: "cust-1", contractCents: CONTRACT, stages: STAGES };
  it("identical baseline passes", () => {
    expect(() => assertBaselineUnchanged(canonicalBaseline(base), canonicalBaseline({ ...base }))).not.toThrow();
  });
  it.each([
    ["contract value", { ...base, contractCents: CONTRACT + 100 }],
    ["customer", { ...base, customerId: "cust-2" }],
    ["organisation", { ...base, orgId: "org-2" }],
    ["a stage value", { ...base, stages: STAGES.map((s) => (s.id === "mfg" ? { ...s, valueCents: s.valueCents + 1 } : s)) }],
  ])("mutating %s after commit is detected", (_n, mutated) => {
    expect(code(() => assertBaselineUnchanged(canonicalBaseline(base), canonicalBaseline(mutated)))).toBe("BASELINE_MUTATED");
  });
});

describe("money & percent arithmetic", () => {
  it("rounds half-up on exact boundaries and never drifts like floats", () => {
    expect(applyBps(1, 5000)).toBe(1); // 0.5 -> 1
    expect(applyBps(1, 4999)).toBe(0);
    expect(applyBps(10_100, 1500)).toBe(1515); // 151.50 -> exact
    expect(applyBps(3, 3333)).toBe(1); // 0.9999 -> 1
    // classic float trap: 0.07 * 100 = 7.000000000000001
    expect(applyBps(100, 700)).toBe(7);
  });
  it("tax is rounded per line and summed", () => {
    const stages: StageInput[] = [{ id: "a", name: "A", valueCents: 1_000_01 }, { id: "b", name: "B", valueCents: 1_000_01 }];
    const r = computeProgressClaim({
      contractCents: 2_000_02,
      stages,
      progress: [{ stageId: "a", approvedBps: 5000 }, { stageId: "b", approvedBps: 5000 }],
      priorClaims: [],
      taxRateBps: 1500,
    });
    // each line: 50,000.5 -> 50,001 cents (half-up); tax 15% of 50,001 = 7,500.15 -> 7,500
    expect(r.lines.map((l) => l.currentClaimCents)).toEqual([50_001, 50_001]);
    expect(r.taxCents).toBe(15_000);
    expect(r.totalCents).toBe(r.subtotalCents + r.taxCents);
  });
  it("parses decimal strings without floating point", () => {
    expect(percentToBps("65")).toBe(6500);
    expect(percentToBps("62.5")).toBe(6250);
    expect(percentToBps("0.05")).toBe(5);
    expect(code(() => percentToBps("100.01"))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(code(() => percentToBps("-1"))).toBe("COMPLETION_OUT_OF_RANGE");
    expect(randsToCents("450000.5")).toBe(45_000_050);
    expect(code(() => randsToCents("1.234"))).toBe("NOT_INTEGER_MONEY");
  });
});
