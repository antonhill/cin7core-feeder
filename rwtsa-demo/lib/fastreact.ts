import type { DemoState } from "@/rwtsa-demo/state/demo-state";
import { ExchangeStoreError, EMPTY_EXCHANGE, loadExchange, type ExchangeState } from "@/rwtsa-demo/state/fastreact-store";
import { stateDir } from "./exclusions";

/** Saved Fast React exchange state for the loaded data source. A problem is reported, never swallowed and never turned into "empty". */
export function readExchange(state: DemoState): { exchange: ExchangeState; error: string | null } {
  if (state.kind !== "validated") return { exchange: EMPTY_EXCHANGE, error: null };
  try {
    return { exchange: loadExchange(stateDir(), state.summary.sourceLabel), error: null };
  } catch (e) {
    if (e instanceof ExchangeStoreError) return { exchange: EMPTY_EXCHANGE, error: e.message };
    throw e;
  }
}
