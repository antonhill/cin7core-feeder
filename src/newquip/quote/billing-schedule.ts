import type { SuggestedStage } from "@/lib/projects/baseline";

// NewQuip's confirmed STANDARD commercial billing schedule, and the schedule maths. The billing engine never sees these
// percentages: they only seed the stages of a NEW project (the stages are then ordinary, editable project data). Existing
// projects keep the stages they were created with.

export interface ScheduleStageTemplate {
  name: string;
  /** Basis points of the ex-VAT contract value (10,000 = 100%). */
  bps: number;
  description: string;
  /** What commercially triggers the claim (recorded as guidance; confirmation is a manager action with evidence). */
  trigger: string;
}

export const NEWQUIP_STANDARD_SCHEDULE: readonly ScheduleStageTemplate[] = [
  { name: "Deposit", bps: 4000, description: "Contract approved, before procurement", trigger: "Contract approved, before procurement" },
  { name: "Delivery", bps: 5500, description: "Approximately 90% of equipment delivered", trigger: "Approximately 90% of equipment delivered" },
  { name: "Installation", bps: 500, description: "Installation completed and accepted", trigger: "Installation completed and accepted" },
];

/** The earlier POC six-stage schedule (10/30/20/20/15/5). Kept as a selectable alternative; no longer the default. */
export const POC_SIX_STAGE_SCHEDULE: readonly ScheduleStageTemplate[] = [
  { name: "Deposit", bps: 1000, description: "Payable on contract commencement", trigger: "Contract commencement" },
  { name: "Manufacturing", bps: 3000, description: "Fabrication of equipment", trigger: "Manufacturing progress" },
  { name: "Equipment Ready", bps: 2000, description: "Equipment complete and ready for dispatch", trigger: "Equipment ready" },
  { name: "Delivery", bps: 2000, description: "Delivery to site", trigger: "Delivery" },
  { name: "Installation", bps: 1500, description: "Installation on site", trigger: "Installation" },
  { name: "Commissioning", bps: 500, description: "Commissioning and handover", trigger: "Commissioning and handover" },
];

/** A variation's default schedule: one 100% stage, independently configurable. */
export const VARIATION_DEFAULT_SCHEDULE: readonly ScheduleStageTemplate[] = [
  { name: "Variation", bps: 10_000, description: "Variation billed in full", trigger: "Variation approved" },
];

export interface ScheduleValidation { ok: boolean; totalBps: number; errors: string[] }

/** A schedule is valid only if it has stages, every stage is named and positive, names are unique, and the total is exactly 100%. */
export function validateSchedule(schedule: readonly Pick<ScheduleStageTemplate, "name" | "bps">[]): ScheduleValidation {
  const errors: string[] = [];
  if (schedule.length === 0) errors.push("A billing schedule needs at least one stage.");
  const seen = new Set<string>();
  let total = 0;
  for (const s of schedule) {
    const key = s.name.trim().toLowerCase();
    if (!key) errors.push("Every stage needs a name.");
    else if (seen.has(key)) errors.push(`Duplicate stage name "${s.name}".`);
    seen.add(key);
    if (!Number.isInteger(s.bps) || s.bps <= 0) errors.push(`Stage "${s.name}" must have a positive whole-basis-point share.`);
    else total += s.bps;
  }
  if (total !== 10_000) errors.push(`Stage percentages total ${(total / 100).toFixed(2)}%, not 100%.`);
  return { ok: errors.length === 0, totalBps: total, errors };
}

/** Splits an ex-VAT contract (integer cents) across a schedule; the final stage absorbs rounding so the total is exact. */
export function splitContractBySchedule(contractCents: number, schedule: readonly ScheduleStageTemplate[] = NEWQUIP_STANDARD_SCHEDULE): SuggestedStage[] {
  const v = validateSchedule(schedule);
  if (!v.ok) throw new Error(`Invalid billing schedule: ${v.errors.join(" ")}`);
  let allocated = 0;
  return schedule.map((s, i) => {
    const valueCents = i === schedule.length - 1 ? contractCents - allocated : Math.floor((contractCents * s.bps) / 10_000);
    allocated += valueCents;
    return { name: s.name, description: s.description, valueCents };
  });
}

export type SchedulePreset = "STANDARD" | "SIX_STAGE" | "CUSTOM";
export interface ScheduleChoice { preset: SchedulePreset; /** CUSTOM only: stage names with a percentage as typed (up to 2 decimals), e.g. "40" or "27.5". */ stages?: Array<{ name: string; percent: string }> }

/** "27.5" -> 2750 basis points. Null for anything that is not a plain number with at most 2 decimals. */
export function percentToBps(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Turns the manager's choice into a VALIDATED schedule, or the reasons it cannot be used. The default (no choice) is the NewQuip standard. */
export function resolveScheduleChoice(choice?: ScheduleChoice | null): { ok: true; schedule: readonly ScheduleStageTemplate[]; label: string } | { ok: false; errors: string[] } {
  if (!choice || choice.preset === "STANDARD") return { ok: true, schedule: NEWQUIP_STANDARD_SCHEDULE, label: "NewQuip standard 40/55/5" };
  if (choice.preset === "SIX_STAGE") return { ok: true, schedule: POC_SIX_STAGE_SCHEDULE, label: "Six-stage (10/30/20/20/15/5)" };
  if (choice.preset !== "CUSTOM") return { ok: false, errors: ["Unknown schedule option."] };
  const errors: string[] = [];
  const stages: ScheduleStageTemplate[] = [];
  for (const s of choice.stages ?? []) {
    const bps = percentToBps(s.percent);
    if (bps === null) { errors.push(`"${s.name || "(unnamed)"}": "${s.percent}" is not a valid percentage.`); continue; }
    stages.push({ name: s.name.trim(), bps, description: s.name.trim(), trigger: "Manager-confirmed milestone" });
  }
  if (errors.length) return { ok: false, errors };
  const v = validateSchedule(stages);
  return v.ok ? { ok: true, schedule: stages, label: "Custom schedule" } : { ok: false, errors: v.errors };
}
