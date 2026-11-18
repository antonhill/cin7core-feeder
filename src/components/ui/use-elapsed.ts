"use client";

import { useEffect, useState } from "react";

/**
 * Whole seconds since `active` last became true (0 while inactive). Re-keys when `resetKey` changes so a different operation starts counting again.
 * It reports only wall-clock time actually waited; it never estimates progress.
 */
export function useElapsedSeconds(active: boolean, resetKey: string = ""): number {
  const [state, setState] = useState<{ key: string; s: number }>({ key: resetKey, s: 0 });
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const id = window.setInterval(() => setState({ key: resetKey, s: Math.floor((Date.now() - start) / 1000) }), 500);
    return () => { window.clearInterval(id); setState({ key: resetKey, s: 0 }); };
  }, [active, resetKey]);
  return active && state.key === resetKey ? state.s : 0;
}
