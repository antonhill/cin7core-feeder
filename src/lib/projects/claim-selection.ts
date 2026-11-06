import { randsToCents } from "./claim-engine";

// Choosing WHICH billing stages a progress claim covers. The Projects actions require an explicit choice: a claim never silently includes
// every currently claimable stage. Pure functions, shared by the UI (to explain) and the server actions (to enforce).

export interface SelectableStage { id: string; name: string; claimableCents: number }

export function normaliseSelection(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((x) => typeof x === "string" && x.length > 0))];
}

/** Returns an error message, or null when the selection may be previewed / drafted. */
export function selectionError(stages: readonly SelectableStage[], ids: readonly string[] | undefined): string | null {
  const sel = normaliseSelection(ids);
  if (sel.length === 0) return "Choose at least one billing stage to claim.";
  const byId = new Map(stages.map((s) => [s.id, s]));
  for (const id of sel) {
    const s = byId.get(id);
    if (!s) return "A selected stage does not belong to this project.";
    if (s.claimableCents <= 0) return `"${s.name}" has nothing to claim yet.`;
  }
  return null;
}

/** Server-side guard used by the actions: the selection must be present (stage existence/claimability is then enforced by the engine). */
export function requireExplicitSelection(ids: readonly string[] | undefined): string[] {
  const sel = normaliseSelection(ids);
  if (sel.length === 0) throw new Error("Choose at least one billing stage to claim.");
  return sel;
}

/** After a preview: every stage the user chose must have produced a line, otherwise the claim would bill something other than what was selected. */
export function assertSelectionHonoured(selected: readonly string[], lines: ReadonlyArray<{ stageId: string; stageName: string }>): void {
  const got = new Set(lines.map((l) => l.stageId));
  const missing = selected.find((id) => !got.has(id));
  if (missing) throw new Error("A selected billing stage has nothing new to claim yet. Choose only stages that are claimable.");
}

/**
 * Partial amounts typed as rands per stage ("" or missing = claim the full claimable amount). Returns cents for the stages that carry an amount.
 * Only chosen stages may carry one; a bad number is refused with a plain message. The engine then enforces amount <= claimable, so this does
 * not need to know the claimable figure (the UI shows it, the server re-derives it).
 */
export function parsePartialAmounts(chosen: readonly string[], rands: Record<string, string> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [stageId, text] of Object.entries(rands ?? {})) {
    if (typeof text !== "string" || !text.trim()) continue;
    if (!chosen.includes(stageId)) throw new Error("An amount was entered for a stage that is not selected.");
    let cents: number;
    try { cents = randsToCents(text); } catch { throw new Error(`"${text.trim()}" is not a valid amount (rands, up to 2 decimals, no negatives).`); }
    if (cents <= 0) throw new Error("A partial claim amount must be more than zero. Untick the stage instead of claiming nothing.");
    out[stageId] = cents;
  }
  return out;
}
