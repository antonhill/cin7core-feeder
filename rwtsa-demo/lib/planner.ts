import { loadPlanner, PlannerStoreError, EMPTY_PLANNER, type PlannerState } from "@/rwtsa-demo/state/planner-store";
import type { DemoState } from "@/rwtsa-demo/state/demo-state";
import { stateDir } from "./exclusions";

/** Saved planner decisions for the loaded data source. A problem is reported, never swallowed and never turned into "no decisions". */
export function readPlanner(state: DemoState): { planner: PlannerState; error: string | null } {
  if (state.kind !== "validated") return { planner: EMPTY_PLANNER, error: null };
  try {
    return { planner: loadPlanner(stateDir(), state.summary.sourceLabel), error: null };
  } catch (e) {
    if (e instanceof PlannerStoreError) return { planner: EMPTY_PLANNER, error: e.message };
    throw e;
  }
}
