import { validateSchedule, splitContractBySchedule, type ScheduleStageTemplate } from "./billing-schedule";

// NewQuip PROJECT TEMPLATES (pure). A template is a named, versioned list of billing stages; applying one only seeds the stages of a NEW project through
// the same schedule maths as the standard 40/55/5 (billing-schedule.ts). There is no second billing engine here: percentages are whole basis points, the
// total must be exactly 10,000, and the last stage absorbs rounding so a split always reconciles to the contract to the cent.

export interface TemplateStageInput { name: string; /** As typed: up to 2 decimals, e.g. "27.5". */ percent: string; description?: string; trigger?: string }

/** "27.5" -> 2750. Null for anything that is not a plain number with at most 2 decimals. Same rule as the billing schedule's percentToBps. */
export function percentTextToBps(text: string): number | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0")); // integer arithmetic only: no float rounding
}

export const bpsToPercentText = (bps: number): string => (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0+$/, ""));

export type StagesResult = { ok: true; stages: ScheduleStageTemplate[] } | { ok: false; errors: string[] };

/** Turns the editor's rows into validated stages (claim order = row order), or the reasons it cannot be saved. */
export function stagesFromInput(rows: readonly TemplateStageInput[]): StagesResult {
  const errors: string[] = [];
  const stages: ScheduleStageTemplate[] = [];
  for (const r of rows) {
    const bps = percentTextToBps(r.percent);
    if (bps === null) { errors.push(`"${r.name.trim() || "(unnamed)"}": "${r.percent}" is not a valid percentage (up to 2 decimals).`); continue; }
    const name = r.name.trim();
    stages.push({ name, bps, description: (r.description ?? "").trim() || name, trigger: (r.trigger ?? "").trim() || "Manager-confirmed milestone" });
  }
  if (errors.length) return { ok: false, errors };
  const v = validateSchedule(stages);
  return v.ok ? { ok: true, stages } : { ok: false, errors: v.errors };
}

/** Defensive parse of stored stages (jsonb) - the database also validates, but the application never trusts a shape. */
export function stagesFromStored(raw: unknown): ScheduleStageTemplate[] {
  if (!Array.isArray(raw)) throw new Error("Stored template stages are malformed.");
  const out = raw.map((s) => {
    const o = s as { name?: unknown; bps?: unknown; description?: unknown; trigger?: unknown };
    if (typeof o?.name !== "string" || typeof o.bps !== "number") throw new Error("Stored template stages are malformed.");
    return { name: o.name, bps: o.bps, description: typeof o.description === "string" ? o.description : o.name, trigger: typeof o.trigger === "string" ? o.trigger : "Manager-confirmed milestone" };
  });
  const v = validateSchedule(out);
  if (!v.ok) throw new Error(`Stored template is invalid: ${v.errors.join(" ")}`);
  return out;
}

export const sameSchedule = (a: readonly Pick<ScheduleStageTemplate, "name" | "bps">[], b: readonly Pick<ScheduleStageTemplate, "name" | "bps">[]): boolean =>
  a.length === b.length && a.every((s, i) => s.name.trim() === b[i].name.trim() && s.bps === b[i].bps);

/** Where a project's schedule came from. Recorded in the project's provenance; the project's stages themselves are its own frozen copy. */
export interface ScheduleSource {
  kind: "STANDARD" | "SIX_STAGE" | "CUSTOM" | "TEMPLATE";
  templateId?: string; templateName?: string; templateVersion?: number;
  /** True when the template's stages were changed for this one project. */
  customised?: boolean;
}

/** Moves a row one place; out-of-range moves are ignored. Used by the editor's reorder buttons. */
export function moveRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const copy = [...rows];
  [copy[index], copy[to]] = [copy[to], copy[index]];
  return copy;
}

export { splitContractBySchedule };
