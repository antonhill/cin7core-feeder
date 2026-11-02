"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearDraft, defaultDraftStorage, draftKey, loadDraft, saveDraft, type DraftStorage } from "./form-draft";
import { createBrowserSupabaseClient } from "@/supabase/browser";

export interface FormDraftOptions<T> {
  kind: string;
  recordId: string;
  /** The server version the form was loaded from (a hash/updated_at). `null` while the record is still loading: nothing is read or written. */
  base: string | null;
  /** True while the form holds unsaved edits. Persisting starts when it turns true; the stored draft is cleared when it turns false again (saved, cancelled, reloaded). */
  dirty: boolean;
  value: T;
  validate?: (d: unknown) => d is T;
  /** Test seams. */
  getUserId?: () => Promise<string | null>;
  storage?: DraftStorage | null;
  delayMs?: number;
}
export interface FormDraftApi<T> {
  /** An unsaved draft from an earlier visit that can be restored (fresh and based on the CURRENT server version), else null. */
  restorable: { data: T; savedAt: number } | null;
  /** Why an earlier draft was NOT offered (the server version moved on, or it expired), until dismissed. */
  dropped: "stale" | "expired" | "invalid" | null;
  /** Hands back the draft and removes it from storage (the caller applies it to the form and marks the form dirty, which starts persisting again). */
  restore: () => T | null;
  discard: () => void;
  dismissDropped: () => void;
}

async function browserUserId(): Promise<string | null> {
  try { return (await createBrowserSupabaseClient().auth.getUser()).data.user?.id ?? null; } catch { return null; }
}

export function useFormDraft<T>(o: FormDraftOptions<T>): FormDraftApi<T> {
  const { kind, recordId, base, dirty, value, validate, delayMs = 400 } = o;
  const getUserId = o.getUserId ?? browserUserId;
  const [userId, setUserId] = useState<string | null>(null);
  const [restorable, setRestorable] = useState<{ data: T; savedAt: number } | null>(null);
  const [dropped, setDropped] = useState<"stale" | "expired" | "invalid" | null>(null);
  const wasDirty = useRef(false);
  const storage = o.storage !== undefined ? o.storage : defaultDraftStorage();
  const key = userId ? draftKey(userId, kind, recordId) : null;

  useEffect(() => { let live = true; void getUserId().then((u) => { if (live) setUserId(u); }); return () => { live = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An offered draft is only valid for the exact server version it was found against, and only while the form is untouched. Editing (dirty), saving (base moves on) or
  // any version change withdraws the offer, so "Restore my edits" can never overwrite newer work. Declared BEFORE the lookup below so a lookup for the new version can re-offer.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- withdraws an offer when its preconditions (clean form, same server version) stop holding
    setRestorable(null);
  }, [dirty, base]);

  // Look for an earlier draft once the user and the server version are known (never while the form is already being edited).
  const looked = useRef<string | null>(null);
  useEffect(() => {
    if (!key || base == null || looked.current === `${key}|${base}`) return;
    looked.current = `${key}|${base}`;
    if (dirty) return;
    const r = loadDraft<T>(storage, key, base, Date.now(), validate);
    /* eslint-disable react-hooks/set-state-in-effect -- reads an external store (sessionStorage) once per record/version; there is no render-time equivalent on the server */
    if (r.status === "fresh") setRestorable({ data: r.data, savedAt: r.savedAt });
    else if (r.status !== "none") setDropped(r.status);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [key, base, dirty, storage, validate]);

  // Persist while dirty (debounced); clear when dirty returns to false.
  useEffect(() => {
    if (!key || base == null) return;
    if (!dirty) { if (wasDirty.current) { clearDraft(storage, key); wasDirty.current = false; } return; }
    wasDirty.current = true;
    const t = setTimeout(() => { saveDraft(storage, key, base, value); }, delayMs);
    return () => clearTimeout(t);
  }, [key, base, dirty, value, storage, delayMs]);

  const restore = useCallback(() => { const r = restorable; setRestorable(null); if (key) clearDraft(storage, key); return r ? r.data : null; }, [restorable, key, storage]);
  const discard = useCallback(() => { setRestorable(null); if (key) clearDraft(storage, key); }, [key, storage]);
  const dismissDropped = useCallback(() => setDropped(null), []);
  return { restorable, dropped, restore, discard, dismissDropped };
}
