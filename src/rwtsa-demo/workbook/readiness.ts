import type { ScenarioId } from "@/rwtsa-demo/contracts/fields";
import { SCENARIO_TABS, TAB_CONTRACTS, TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import { DEFAULT_FORECAST_WINDOW_MONTHS, type ReadinessConfig, type ScenarioReadiness } from "@/rwtsa-demo/dataset";
import { RwtsaSafeError, type Finding } from "@/rwtsa-demo/findings";
import type { ParsedRow, ParsedTab } from "@/rwtsa-demo/workbook/parse-tab";
import type { ReadResult } from "@/rwtsa-demo/workbook/read";

/**
 * Per-scenario readiness. SEPARATE from structural validity (`ok`): a structurally valid workbook may have no
 * scenario ready, and a scenario is never "ready" merely because a header exists.
 *
 * Population rules for a PRESENT critical column (a valid explicit 0 or false is an observation; blank is not):
 *   Items.minLevel       every row that is not marked tender needs a value (DP-16: tender SKUs carry no standing level)
 *   Items.isTender       every row needs an explicit true/false (a blank is "unknown", never silently false)
 *   Quotes.lostReason    every LOST quote needs a reason          (CRM-06)
 *   Quotes.convertedOrder every WON quote needs its order reference (CRM-09)
 *   any other critical column: at least one non-blank value (finer per-row rules arrive with each calculation engine)
 *
 * Scenario A additionally needs, for EVERY SKU, a valid observation in each of the last `forecastWindowMonths` month
 * columns. Explicit zeros count; blank or invalid cells do not. Missing months in the window make scenario A NOT READY;
 * they are not a structural failure of the workbook.
 */

export function normaliseReadinessConfig(partial?: Partial<ReadinessConfig>): ReadinessConfig {
  const n = partial?.forecastWindowMonths ?? DEFAULT_FORECAST_WINDOW_MONTHS;
  if (!Number.isInteger(n) || n < 1 || n > 36) throw new RwtsaSafeError("invalid_cell", "The forecast window must be a whole number of months between 1 and 36.");
  return { forecastWindowMonths: n };
}

const isBlank = (v: unknown): boolean => v === null || v === undefined;

/** How many rows needed a value for `Tab.field` and had none. 0 means the column is meaningfully populated. */
export function populationGap(tab: TabName, field: string, rows: readonly ParsedRow[]): number {
  const countBlank = (rs: readonly ParsedRow[]) => rs.filter((r) => isBlank(r[field])).length;
  if (tab === "Items" && field === "minLevel") return countBlank(rows.filter((r) => r.isTender !== true));
  if (tab === "Items" && field === "isTender") return countBlank(rows);
  if (tab === "Quotes" && field === "lostReason") return countBlank(rows.filter((r) => r.status === "lost"));
  if (tab === "Quotes" && field === "convertedOrder") return countBlank(rows.filter((r) => r.status === "won"));
  return rows.length > 0 && rows.every((r) => isBlank(r[field])) ? rows.length : 0;
}

export interface ReadinessInput {
  readonly ok: boolean;
  readonly read: ReadResult;
  readonly parsed: Partial<Record<TabName, ParsedTab>>;
  readonly findings: readonly Finding[];
  readonly config: ReadinessConfig;
}

export function computeReadiness(input: ReadinessInput): ScenarioReadiness[] {
  const { ok, read, parsed, findings, config } = input;
  const emptyTabs = new Set<TabName>(TAB_NAMES.filter((t) => !read.tables[t] || read.tables[t]!.rows.length === 0));
  const absent = new Set(findings.filter((f) => f.code === "optional_header_absent" && f.severity === "warning" && f.tab && f.field).map((f) => `${f.tab}.${f.field}`));

  // Scenario A: recent-history completeness over the configured window.
  const sales = parsed.SalesHistory;
  const availableMonths = sales?.months.length ?? 0;
  const salesWindow = (() => {
    if (!sales) return { requiredMonths: config.forecastWindowMonths, availableMonths: 0, skusIncomplete: 0 };
    const n = config.forecastWindowMonths;
    const skusIncomplete = sales.monthQty.filter((series) => series.length < n || series.slice(-n).some((q) => q === null)).length;
    return { requiredMonths: n, availableMonths, skusIncomplete };
  })();

  return (Object.keys(SCENARIO_TABS) as ScenarioId[]).map((scenario): ScenarioReadiness => {
    const missingTabs = SCENARIO_TABS[scenario].filter((t) => emptyTabs.has(t));
    const critical = TAB_NAMES.flatMap((tab) => TAB_CONTRACTS[tab].fields.filter((f) => f.critical === scenario).map((f) => ({ tab, key: f.key })));
    const missingFields = critical.filter((c) => absent.has(`${c.tab}.${c.key}`)).map((c) => `${c.tab}.${c.key}`);
    const unpopulatedFields = critical
      .filter((c) => !absent.has(`${c.tab}.${c.key}`) && !emptyTabs.has(c.tab) && parsed[c.tab])
      .map((c) => ({ field: `${c.tab}.${c.key}`, missing: populationGap(c.tab, c.key, parsed[c.tab]!.rows) }))
      .filter((u) => u.missing > 0);
    const recent = scenario === "A" ? salesWindow : null;
    const windowOk = recent === null || (recent.availableMonths >= recent.requiredMonths && recent.skusIncomplete === 0 && !emptyTabs.has("SalesHistory"));
    return {
      scenario,
      ready: ok && missingTabs.length === 0 && missingFields.length === 0 && unpopulatedFields.length === 0 && windowOk,
      missingTabs,
      missingFields,
      unpopulatedFields,
      salesWindow: recent,
    };
  });
}
