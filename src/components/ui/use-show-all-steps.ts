"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

const subscribe = (notify: () => void) => { window.addEventListener("storage", notify); return () => window.removeEventListener("storage", notify); };

/**
 * "Show all steps" preference, remembered per viewer in localStorage. A convenience only: every access is in try/catch (private windows, blocked storage), the default is the
 * guided view, and the page renders correctly when storage is unavailable (the choice then lasts for the visit). The server render and hydration use the default.
 */
export function useShowAllSteps(storageKey: string): [boolean, (next: boolean) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => { try { return window.localStorage.getItem(storageKey) === "1"; } catch { return false; } },
    () => false,
  );
  const [chosen, setChosen] = useState<boolean | null>(null);
  const set = useCallback((next: boolean) => {
    setChosen(next);
    try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* not remembered */ }
  }, [storageKey]);
  return [chosen ?? stored, set];
}
