import type { QuoteDraft } from "./draft";

/** Stands in for a reason that has not been typed yet. Never saved: the server refuses a blank reason (see `blankExclusions`). */
export const PENDING_EXCLUSION_REASON = "(reason pending)";

/** Exclusions that are ticked but have no reason yet. The engine honours an exclusion only with a reason, so these cannot be SAVED. */
export function blankExclusions(draft: QuoteDraft): string[] {
  return Object.entries(draft.config.exclusions ?? {}).filter(([, reason]) => !reason?.trim()).map(([key]) => key);
}

/**
 * The draft as the LIVE PREVIEW should evaluate it: a ticked exclusion applies at once, before its reason is typed, so the owner sees the price effect of the click.
 * It is only a stand-in for the READ-ONLY preview and the same single calculation engine evaluates it; nothing here is persisted, and a blank reason cannot be
 * saved. So once a reason is entered the saved figures are exactly the previewed ones.
 */
export function previewDraftOf(draft: QuoteDraft): QuoteDraft {
  const blank = blankExclusions(draft);
  if (blank.length === 0) return draft;
  const exclusions = { ...draft.config.exclusions };
  for (const k of blank) (exclusions as Record<string, string>)[k] = PENDING_EXCLUSION_REASON;
  return { ...draft, config: { ...draft.config, exclusions } };
}

/** "Latest request wins": every new edit (or save, or reload) takes a ticket; an answer is applied only if its ticket is still the newest. */
export function latestOnly() {
  let n = 0;
  return { next: (): number => ++n, isCurrent: (ticket: number): boolean => ticket === n };
}
