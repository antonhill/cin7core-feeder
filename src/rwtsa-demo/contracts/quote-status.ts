/**
 * Quote status normalisation for Scenario D. Pure and explicit: a status is WON, LOST or OPEN only if its text is in the
 * table below (compared after lower-casing and collapsing spaces, hyphens and underscores). Everything else, including a
 * blank, is UNCLASSIFIED. An unrecognised status is NEVER treated as OPEN.
 *
 * Deliberately NOT recognised (ambiguous, so they stay UNCLASSIFIED and are reported): draft, expired, cancelled, on hold,
 * superseded, revised.
 */
export type QuoteStatus = "WON" | "LOST" | "OPEN" | "UNCLASSIFIED";

export const RECOGNISED_STATUSES = {
  WON: ["won", "closed won", "accepted"],
  LOST: ["lost", "closed lost", "declined", "rejected"],
  OPEN: ["open", "pending", "sent", "quoted"],
} as const;

const LOOKUP: ReadonlyMap<string, QuoteStatus> = new Map(
  (Object.entries(RECOGNISED_STATUSES) as [QuoteStatus, readonly string[]][]).flatMap(([status, values]) => values.map((v) => [v, status] as const)),
);

export function normaliseQuoteStatus(raw: unknown): QuoteStatus {
  if (typeof raw !== "string") return "UNCLASSIFIED";
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return LOOKUP.get(key) ?? "UNCLASSIFIED";
}
