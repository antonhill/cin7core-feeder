import { parseIsoDate } from "./calendar";
import { DEFAULT_RED_FLAG_CONFIG, type RedFlagConfig } from "./types";

export type RedFlagConfigInput = { readonly [K in keyof RedFlagConfig]?: RedFlagConfig[K] extends object ? Partial<RedFlagConfig[K]> | RedFlagConfig[K] : RedFlagConfig[K] };

/** Merges a partial configuration over the defaults and rejects anything outside the supported ranges. Never silently coerces. */
export function resolveConfig(input: RedFlagConfigInput = {}): RedFlagConfig {
  const c = {
    ...DEFAULT_RED_FLAG_CONFIG,
    ...input,
    anomaly: { ...DEFAULT_RED_FLAG_CONFIG.anomaly, ...(input.anomaly ?? {}) },
  } as RedFlagConfig;
  if (parseIsoDate(c.stockDate) === null) throw new Error("Invalid stock date: expected a real calendar date as YYYY-MM-DD.");
  if (!Number.isInteger(c.forecastWindowMonths) || c.forecastWindowMonths < 1 || c.forecastWindowMonths > 36) throw new Error("Invalid forecast window: a whole number of months from 1 to 36.");
  if (c.horizonWeeks !== 13 && c.horizonWeeks !== 26) throw new Error("Invalid horizon: 13 or 26 weeks.");
  if (c.historyAnchor !== "last-available" && c.historyAnchor !== "strict") throw new Error("Invalid history anchor.");
  if (c.overdueOnWater !== "week-1" && c.overdueOnWater !== "exclude") throw new Error("Invalid overdue on-water treatment.");
  if (!Number.isFinite(c.anomaly.multiple) || c.anomaly.multiple <= 0) throw new Error("Invalid anomaly multiple: must be greater than 0.");
  if (!Number.isFinite(c.anomaly.floor) || c.anomaly.floor < 0) throw new Error("Invalid anomaly floor: must be 0 or more.");
  if (c.sizeCurve.kind === "explicit") {
    for (const [size, w] of Object.entries(c.sizeCurve.weights)) if (!Number.isFinite(w) || w < 0) throw new Error(`Invalid size curve weight for size ${size}.`);
  }
  return c;
}
