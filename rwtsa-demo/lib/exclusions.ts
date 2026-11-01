import { defaultStateDir, loadExclusions, ExclusionStoreError } from "@/rwtsa-demo/state/exclusions-store";
import type { Exclusion } from "@/rwtsa-demo/engine";
import type { DemoState } from "@/rwtsa-demo/state/demo-state";

/** The local state directory: RWTSA_STATE_DIR, or ~/.rwtsa-demo. Always outside every git working tree (the store enforces it). */
export function stateDir(): string {
  const d = process.env.RWTSA_STATE_DIR;
  return d && d.trim() !== "" ? d.trim() : defaultStateDir();
}

/** Saved exclusions for the loaded data source. A problem is reported, never swallowed and never turned into "no exclusions". */
export function readExclusions(state: DemoState): { exclusions: Exclusion[]; error: string | null } {
  if (state.kind !== "validated") return { exclusions: [], error: null };
  try {
    return { exclusions: loadExclusions(stateDir(), state.summary.sourceLabel), error: null };
  } catch (e) {
    if (e instanceof ExclusionStoreError) return { exclusions: [], error: e.message };
    throw e;
  }
}
