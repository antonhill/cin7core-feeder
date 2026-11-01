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
