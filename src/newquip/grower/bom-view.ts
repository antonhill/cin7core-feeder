import type { GeneratedLine } from "./types";

// Pure presentation rules for the generated BOM, kept out of the React component so they are testable.

/** Unselected optional equipment stays out of the primary BOM; its definition and rule are untouched. */
export function splitBomLines(lines: GeneratedLine[]): { primary: GeneratedLine[]; optionalNotSelected: number } {
  const primary = lines.filter((l) => l.basis !== "not_selected");
  return { primary, optionalNotSelected: lines.length - primary.length };
}

export type QuantityProvenance =
  | "verified_calculation" // a verified rule produced it
  | "manual_topigs_reference" // estimator chose to use the historic Topigs figure
  | "manual_entry" // estimator typed a figure
  | "awaiting_validation"; // no trustworthy quantity

/**
 * Where a displayed quantity came from. A manual value — even one copied from the Topigs reference —
 * can NEVER read as a verified calculation: only basis "system_calculated" yields verified_calculation.
 */
export function quantityProvenance(line: GeneratedLine, overrideSource: "historic" | "typed" | undefined): QuantityProvenance {
  if (line.basis === "system_calculated") return "verified_calculation";
  if (line.basis === "manual_override") return overrideSource === "historic" ? "manual_topigs_reference" : "manual_entry";
  return "awaiting_validation";
}

export type RefLookupStatus = "idle" | "loading" | "ready" | "failed";
export type PriceTierPanelState = "choose_instance" | "loading" | "failed" | "no_tiers" | "ready";

/**
 * What the Project panel shows for the price tier. "loading" is only ever returned while a lookup is
 * genuinely in flight; the page bounds that with a timeout, so there is no permanent Loading… state.
 */
export function priceTierPanelState(a: { hasInstance: boolean; status: RefLookupStatus; tierCount: number }): PriceTierPanelState {
  if (!a.hasInstance) return "choose_instance";
  if (a.status === "failed") return "failed";
  if (a.status === "idle" || a.status === "loading") return "loading";
  return a.tierCount === 0 ? "no_tiers" : "ready";
}
