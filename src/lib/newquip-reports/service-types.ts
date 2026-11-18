import type { Filters } from "./ops";
export interface CostingFilters extends Filters { basis?: string; exceptionsOnly?: boolean; csort?: "margin" | "selling" | "ref" }
