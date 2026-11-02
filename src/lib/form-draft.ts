/**
 * Browser-side DRAFT PERSISTENCE for unsaved form input: pure storage logic (no React), so it can be tested exhaustively.
 *
 * Safety rules, each enforced here and tested:
 *  - sessionStorage only (per tab, gone when the tab closes), never localStorage: a shared computer does not keep a previous person's work.
 *  - the key carries the signed-in USER id and the record id (record ids are per-organisation UUIDs), so another user in the same tab never sees it.
 *  - the envelope records the server `base` the edits were made against (e.g. a content hash). A draft whose base no longer matches the server is STALE and is
 *    never restored over newer saved work: it is dropped.
 *  - drafts expire (TTL), are size-capped, versioned, and every storage call is try/caught (private windows, quota, disabled storage all degrade to "no draft").
 *  - callers pass only what the form already holds. Never pass tokens, passwords or anything not on screen.
 */
export const DRAFT_PREFIX = "nq-draft:v1:";
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
export const DRAFT_MAX_CHARS = 200_000;

export interface DraftEnvelope<T> { v: 1; base: string; savedAt: number; data: T }
export type DraftLookup<T> = { status: "none" } | { status: "stale" | "expired" | "invalid" } | { status: "fresh"; data: T; savedAt: number };
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const draftKey = (userId: string, kind: string, recordId: string) => `${DRAFT_PREFIX}${userId}:${kind}:${recordId}`;

export function defaultDraftStorage(): DraftStorage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

/** Stores the draft; false when it could not be kept (no storage, too large, quota). Never throws. */
export function saveDraft<T>(s: DraftStorage | null, key: string, base: string, data: T, now: number = Date.now()): boolean {
  if (!s) return false;
  try {
    const text = JSON.stringify({ v: 1, base, savedAt: now, data } satisfies DraftEnvelope<T>);
    if (text.length > DRAFT_MAX_CHARS) { s.removeItem(key); return false; }
    s.setItem(key, text);
    return true;
  } catch { return false; }
}

/** Reads a draft; a stale, expired or unreadable one is removed and reported as such so the UI can say why nothing is offered. */
export function loadDraft<T>(s: DraftStorage | null, key: string, base: string, now: number = Date.now(), validate?: (d: unknown) => d is T): DraftLookup<T> {
  if (!s) return { status: "none" };
  let raw: string | null;
  try { raw = s.getItem(key); } catch { return { status: "none" }; }
  if (raw == null) return { status: "none" };
  const drop = (status: "stale" | "expired" | "invalid"): DraftLookup<T> => { clearDraft(s, key); return { status }; };
  let env: Partial<DraftEnvelope<unknown>>;
  try { env = JSON.parse(raw); } catch { return drop("invalid"); }
  if (!env || env.v !== 1 || typeof env.base !== "string" || typeof env.savedAt !== "number" || env.data === undefined) return drop("invalid");
  if (now - env.savedAt > DRAFT_TTL_MS || env.savedAt > now + 60_000) return drop("expired");
  if (env.base !== base) return drop("stale");
  if (validate && !validate(env.data)) return drop("invalid");
  return { status: "fresh", data: env.data as T, savedAt: env.savedAt };
}

export function clearDraft(s: DraftStorage | null, key: string): void {
  if (!s) return;
  try { s.removeItem(key); } catch { /* nothing to clear */ }
}

/** Removes every draft this app keeps (for sign-out on a shared computer). */
export function clearAllDrafts(s: DraftStorage | null): void {
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k); }
    keys.forEach((k) => s.removeItem(k));
  } catch { /* nothing to clear */ }
}
