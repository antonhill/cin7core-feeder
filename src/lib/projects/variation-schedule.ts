// Projects - a VARIATION's own percentage billing schedule (pure). Generic; nothing here knows about NewQuip or Cin7.
//
// A schedule is a list of named stages, each a whole number of basis points (10000 = 100%); the stages must total exactly 100%.
// The variation's cents are split across the stages DETERMINISTICALLY (largest remainder, ties to the earliest stage), so the stage
// values always sum to the approved variation amount to the cent. `splitCents` is the TypeScript twin of the database function
// variation_stage_cents() (migration 0105); both are tested against the same worked examples.
import { BPS_FULL, MAX_CENTS, percentToBps, type Bps, type Cents } from "./claim-engine";

export interface ScheduleStageInput { name: string; bps: Bps }
export const DEFAULT_VARIATION_STAGE_NAME = "Variation";
/** The default schedule: one 100% milestone. */
export const defaultVariationSchedule = (): ScheduleStageInput[] => [{ name: DEFAULT_VARIATION_STAGE_NAME, bps: BPS_FULL }];

/** Parses user-entered percentages ("33.33") into a schedule, failing closed on anything that is not a clean positive percentage. */
export function scheduleFromPercents(rows: ReadonlyArray<{ name: string; percent: string }>): ScheduleStageInput[] {
  return rows.map((r) => ({ name: r.name.trim(), bps: percentToBps(r.percent) }));
}

export type ScheduleCheckResult = { ok: true } | { ok: false; error: string };

export function validateVariationSchedule(stages: readonly ScheduleStageInput[]): ScheduleCheckResult {
  if (stages.length === 0) return { ok: false, error: "A variation needs at least one billing stage." };
  const names = new Set<string>();
  let total = 0;
  for (const s of stages) {
    if (!s.name.trim()) return { ok: false, error: "Every billing stage needs a name." };
    const key = s.name.trim().toLowerCase();
    if (names.has(key)) return { ok: false, error: `Stage name "${s.name.trim()}" is used twice.` };
    names.add(key);
    if (!Number.isInteger(s.bps) || s.bps < 1 || s.bps > BPS_FULL) return { ok: false, error: `"${s.name.trim()}" must be between 0.01% and 100%.` };
    total += s.bps;
  }
  if (total !== BPS_FULL) return { ok: false, error: `The stages total ${(total / 100).toFixed(2)}%; they must total exactly 100%.` };
  return { ok: true };
}

/**
 * Splits `amountCents` across `bps` by largest remainder: floor each share, then give the spare cents one at a time to the largest
 * remainders (ties to the earliest stage). Pure integer arithmetic; the result always sums to `amountCents`.
 */
export function splitCents(amountCents: Cents, bps: readonly Bps[]): Cents[] {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > MAX_CENTS) throw new Error("The amount to split must be a whole, non-negative number of cents.");
  if (bps.length === 0 || bps.some((b) => !Number.isInteger(b) || b < 1 || b > BPS_FULL) || bps.reduce((n, b) => n + b, 0) !== BPS_FULL) {
    throw new Error("The stage percentages must be whole basis points totalling exactly 100%.");
  }
  // amount*bps can exceed 2^53 (MAX_CENTS x 10000), so split amount = q*10000 + r first: floor(amount*b/10000) = q*b + floor(r*b/10000).
  const q = Math.floor(amountCents / 10_000);
  const r = amountCents % 10_000;
  const out = bps.map((b) => q * b + Math.floor((r * b) / 10_000));
  const rems = bps.map((b) => (r * b) % 10_000);
  let spare = amountCents - out.reduce((n, f) => n + f, 0);
  const order = rems.map((rem, i) => ({ rem, i })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : b.rem - a.rem));
  for (const { i } of order) {
    if (spare <= 0) break;
    out[i] += 1;
    spare -= 1;
  }
  return out;
}

export interface BilledStage { name: string; bps: Bps; valueCents: Cents }
export function scheduleToStages(amountCents: Cents, stages: readonly ScheduleStageInput[]): BilledStage[] {
  const check = validateVariationSchedule(stages);
  if (!check.ok) throw new Error(check.error);
  const cents = splitCents(amountCents, stages.map((s) => s.bps));
  return stages.map((s, i) => ({ name: s.name.trim(), bps: s.bps, valueCents: cents[i] }));
}
