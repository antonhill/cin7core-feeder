import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { parseIsoDate } from "@/rwtsa-demo/engine/calendar";
import { validateLocalMake } from "@/rwtsa-demo/engine/local-make";
import { PlannerStoreError, loadPlanner, updatePlanner, type PlannerState } from "@/rwtsa-demo/state/planner-store";

/**
 * Applies a planner form (classification, temporary minimum, order override, local-make assumption) to the local planner state.
 * Pure of HTTP: takes plain fields and returns a short outcome code, never free text from the request.
 */

export type PlannerOutcome =
  | "classified"
  | "classification-cleared"
  | "min-set"
  | "min-removed"
  | "override-set"
  | "override-reversed"
  | "make-set"
  | "make-removed"
  | "planner-reason"
  | "planner-not-eligible"
  | "planner-unknown"
  | "planner-invalid"
  | "planner-store";

export const PLANNER_MESSAGES: Readonly<Record<PlannerOutcome, { tone: "success" | "danger"; text: string }>> = {
  classified: { tone: "success", text: "Classification saved, and the projection recalculated." },
  "classification-cleared": { tone: "success", text: "Planner classification removed: the workbook's value (or unclassified) applies again." },
  "min-set": { tone: "success", text: "Temporary minimum saved. The workbook's original minimum is unchanged." },
  "min-removed": { tone: "success", text: "Temporary minimum removed: the original minimum applies again." },
  "override-set": { tone: "success", text: "Order override saved. No purchase order was created anywhere." },
  "override-reversed": { tone: "success", text: "Order override reversed: the calculated proposal applies again." },
  "make-set": { tone: "success", text: "Local-make assumption saved (labelled a demonstration assumption)." },
  "make-removed": { tone: "success", text: "Local-make assumption removed." },
  "planner-reason": { tone: "danger", text: "A reason is required. Nothing was changed." },
  "planner-not-eligible": { tone: "danger", text: "Only an ordinary replenishment SKU can have an order override. Classify it first. Nothing was changed." },
  "planner-unknown": { tone: "danger", text: "That SKU is not in the loaded data. Nothing was changed." },
  "planner-invalid": { tone: "danger", text: "The request was not understood or a value is out of range. Nothing was changed." },
  "planner-store": { tone: "danger", text: "The local planner file could not be used. Nothing was changed." },
};

export function isPlannerOutcome(v: string | null | undefined): v is PlannerOutcome {
  return v !== null && v !== undefined && Object.prototype.hasOwnProperty.call(PLANNER_MESSAGES, v);
}

export interface PlannerForm {
  readonly action: string | null;
  readonly sku: string | null;
  readonly value: string | null;
  readonly reason: string | null;
  readonly replacement: string | null;
  readonly effectiveFrom: string | null;
  readonly expires: string | null;
  readonly untilRemoved: boolean;
  readonly quantity: string | null;
  readonly calculated: string | null;
  readonly capacity: string | null;
  readonly leadTime: string | null;
  readonly completionWeek: string | null;
}

const num = (v: string | null): number | null => (v !== null && /^\d{1,9}(\.\d{1,6})?$/.test(v.trim()) ? Number(v.trim()) : null);
const int = (v: string | null): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

/** The classification the engine will use for a SKU, given the planner state (planner > workbook > unclassified). */
export function effectiveClassification(dataset: RwtsaDataset, planner: PlannerState, sku: string): "ordinary" | "tender" | "unclassified" | null {
  const item = dataset.tables.items.find((i) => i.sku === sku);
  if (!item) return null;
  const p = planner.classification.find((c) => c.sku === sku);
  if (p) return p.value;
  return item.isTender === true ? "tender" : item.isTender === false ? "ordinary" : "unclassified";
}

export function applyPlannerForm(dir: string, sourceLabel: string, dataset: RwtsaDataset, form: PlannerForm, now: Date = new Date()): PlannerOutcome {
  const at = now.toISOString();
  const sku = form.sku;
  if (sku === null || sku === "" || sku.length > 200) return "planner-invalid";
  const item = dataset.tables.items.find((i) => i.sku === sku);
  if (!item) return "planner-unknown";
  const reason = (form.reason ?? "").trim();
  try {
    switch (form.action) {
      case "classify": {
        if (form.value === "clear") {
          updatePlanner(dir, sourceLabel, (s) => ({ ...s, classification: s.classification.filter((c) => c.sku !== sku) }));
          return "classification-cleared";
        }
        if (form.value !== "ordinary" && form.value !== "tender") return "planner-invalid";
        const value = form.value;
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, classification: [...s.classification.filter((c) => c.sku !== sku), { sku, value, reason: reason === "" ? null : reason.slice(0, 500), at }] }));
        return "classified";
      }
      case "min-set": {
        const replacement = num(form.replacement);
        if (replacement === null) return "planner-invalid";
        if (reason === "") return "planner-reason";
        const from = form.effectiveFrom ?? "";
        if (parseIsoDate(from) === null) return "planner-invalid";
        // Exactly one of: an expiry date, or an explicit "until removed".
        const expires = form.untilRemoved ? null : (form.expires ?? "");
        if (form.untilRemoved && form.expires !== null && form.expires !== "") return "planner-invalid";
        if (expires !== null && (parseIsoDate(expires) === null || expires < from)) return "planner-invalid";
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, minOverrides: [...s.minOverrides.filter((m) => m.sku !== sku), { sku, originalMin: item.minLevel, replacement, effectiveFrom: from, expires, reason, at }] }));
        return "min-set";
      }
      case "min-remove":
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, minOverrides: s.minOverrides.filter((m) => m.sku !== sku) }));
        return "min-removed";
      case "override-set": {
        const quantity = int(form.quantity);
        if (quantity === null) return "planner-invalid";
        if (reason === "") return "planner-reason";
        // An override cannot bypass eligibility: only an ORDINARY SKU (classified by the planner or the workbook) can carry one.
        if (effectiveClassification(dataset, loadPlanner(dir, sourceLabel), sku) !== "ordinary") return "planner-not-eligible";
        const calc = form.calculated === null || form.calculated === "" ? null : int(form.calculated);
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, orderOverrides: [...s.orderOverrides.filter((o) => o.sku !== sku), { sku, quantity, calculatedAtOverride: calc, reason, at }] }));
        return "override-set";
      }
      case "override-reverse":
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, orderOverrides: s.orderOverrides.filter((o) => o.sku !== sku) }));
        return "override-reversed";
      case "make-set": {
        const e = { quantity: int(form.quantity), capacityUnits: int(form.capacity), leadTimeWeeks: int(form.leadTime), completionWeek: int(form.completionWeek) };
        if (e.quantity === null || e.capacityUnits === null || e.leadTimeWeeks === null || e.completionWeek === null) return "planner-invalid";
        const entry = { quantity: e.quantity, capacityUnits: e.capacityUnits, leadTimeWeeks: e.leadTimeWeeks, completionWeek: e.completionWeek };
        if (validateLocalMake(entry) !== null) return "planner-invalid";
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, localMake: [...s.localMake.filter((m) => m.sku !== sku), { sku, ...entry, at }] }));
        return "make-set";
      }
      case "make-remove":
        updatePlanner(dir, sourceLabel, (s) => ({ ...s, localMake: s.localMake.filter((m) => m.sku !== sku) }));
        return "make-removed";
      default:
        return "planner-invalid";
    }
  } catch (e) {
    if (e instanceof PlannerStoreError) return "planner-store";
    throw e;
  }
}
