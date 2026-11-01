import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { ExclusionStoreError, removeExclusions, saveExclusions } from "@/rwtsa-demo/state/exclusions-store";

/**
 * Applies a planner's exclude / reverse form to the local exclusion store. Pure of HTTP: takes plain fields, returns a short
 * outcome code (never free text from the request) so a page can show a fixed message.
 */

export type FormOutcome = "excluded" | "reversed" | "reason" | "unknown" | "invalid" | "store";

export interface ExclusionForm {
  readonly action: string | null;
  readonly skus: readonly string[];
  readonly month: string | null;
  readonly reason: string | null;
}

export const OUTCOME_MESSAGES: Readonly<Record<FormOutcome, { tone: "success" | "danger"; text: string }>> = {
  excluded: { tone: "success", text: "Month excluded from the demand forecast, and the projection recalculated." },
  reversed: { tone: "success", text: "Exclusion reversed, and the projection recalculated." },
  reason: { tone: "danger", text: "A reason is required to exclude a month. Nothing was changed." },
  unknown: { tone: "danger", text: "That SKU or month is not in the loaded data. Nothing was changed." },
  invalid: { tone: "danger", text: "The request was not understood. Nothing was changed." },
  store: { tone: "danger", text: "The local exclusion file could not be used. Nothing was changed." },
};

export function isOutcome(v: string | null | undefined): v is FormOutcome {
  return v !== null && v !== undefined && Object.prototype.hasOwnProperty.call(OUTCOME_MESSAGES, v);
}

export function applyExclusionForm(dir: string, sourceLabel: string, dataset: RwtsaDataset, form: ExclusionForm): FormOutcome {
  if (form.action !== "exclude" && form.action !== "reverse") return "invalid";
  if (form.skus.length === 0 || form.skus.length > 500 || form.month === null) return "invalid";
  const known = new Set(dataset.tables.items.map((i) => i.sku));
  if (!dataset.months.includes(form.month) || form.skus.some((s) => !known.has(s))) return "unknown";
  if (form.action === "exclude") {
    const have = new Set(dataset.tables.salesHistory.filter((p) => p.month === form.month && p.qty !== null).map((p) => p.sku));
    if (form.skus.some((s) => !have.has(s))) return "unknown";
  }
  try {
    if (form.action === "reverse") {
      removeExclusions(dir, sourceLabel, form.skus.map((sku) => ({ sku, month: form.month as string })));
      return "reversed";
    }
    const reason = (form.reason ?? "").trim();
    if (reason === "") return "reason";
    if (reason.length > 500) return "invalid";
    saveExclusions(dir, sourceLabel, form.skus.map((sku) => ({ sku, month: form.month as string, reason })));
    return "excluded";
  } catch (e) {
    if (e instanceof ExclusionStoreError) return "store";
    throw e;
  }
}
