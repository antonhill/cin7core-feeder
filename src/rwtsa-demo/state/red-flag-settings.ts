import { DEFAULT_RED_FLAG_CONFIG, type RedFlagConfigInput, type SizeCurveConfig } from "@/rwtsa-demo/engine";
import { REV2_CURVE_LABEL, REV2_CURVE_PROVENANCE, REV2_SIZE_CURVE } from "@/rwtsa-demo/engine/size-curve";

/**
 * The Scenario A controls, carried in the page URL (plain GET form, no client-side script). Invalid values are reported and
 * replaced by the default for that control; the page never throws on a bad query and never echoes the raw value back.
 */

export type ResultView = "sku" | "style";
export type CurveChoice = "none" | "demand" | "supplied" | "rev2";

export interface RedFlagSettings {
  readonly config: RedFlagConfigInput;
  readonly view: ResultView;
  readonly style: string | null;
  readonly shortageOnly: boolean;
  readonly sel: string | null;
  readonly curve: CurveChoice;
  /** True when the viewer explicitly set the control; false when the labelled default applies. Neither blocks any result. */
  readonly chosen: { readonly anchor: boolean; readonly overdue: boolean };
  /** Raw, validated control values for redisplay and for building links. */
  readonly values: Readonly<Record<"view" | "window" | "horizon" | "anchor" | "overdue" | "curve" | "mult" | "floor" | "formula", string>>;
  readonly errors: readonly string[];
}

export type RawQuery = Readonly<Record<string, string | readonly string[] | undefined>>;

function one(q: RawQuery, k: string): string | undefined {
  const v = q[k];
  return Array.isArray(v) ? (v as readonly string[])[0] : (v as string | undefined);
}

export interface SettingsOptions {
  /** A size curve supplied with the data (the synthetic source supplies one; a local workbook does not). */
  readonly suppliedCurve: Readonly<Record<string, number>> | null;
  /** True for a local workbook: the overdue default is the conservative "exclude" and the size curve defaults to the documented Rev2 curve. */
  readonly local?: boolean;
}

export function parseSettings(q: RawQuery, opts: SettingsOptions): RedFlagSettings {
  const errors: string[] = [];
  const d = DEFAULT_RED_FLAG_CONFIG;
  const pick = <T extends string>(k: string, allowed: readonly T[], dflt: T, label: string): T => {
    const v = one(q, k);
    if (v === undefined || v === "") return dflt;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    errors.push(`${label}: unsupported value, default used.`);
    return dflt;
  };
  const int = (k: string, lo: number, hi: number, dflt: number, label: string): number => {
    const v = one(q, k);
    if (v === undefined || v === "") return dflt;
    const n = Number(v);
    if (/^\d+$/.test(v) && Number.isInteger(n) && n >= lo && n <= hi) return n;
    errors.push(`${label}: must be a whole number from ${lo} to ${hi}, default used.`);
    return dflt;
  };
  const num = (k: string, lo: number, dflt: number, label: string): number => {
    const v = one(q, k);
    if (v === undefined || v === "") return dflt;
    const n = Number(v);
    if (/^\d+(\.\d+)?$/.test(v) && Number.isFinite(n) && n >= lo && n <= 1e9) return n;
    errors.push(`${label}: must be a number of at least ${lo}, default used.`);
    return dflt;
  };

  const view = pick<ResultView>("view", ["sku", "style"], "sku", "View");
  const win = int("window", 1, 36, d.forecastWindowMonths, "Forecast window");
  const horizon = pick("horizon", ["13", "26"] as const, "13", "Horizon");
  const anchor = pick("anchor", ["last", "strict"] as const, "last", "History anchor");
  const overdue = pick("overdue", ["week1", "exclude"] as const, opts.local ? "exclude" : "week1", "Overdue on-water");
  // An invalid value is reported above and counts as NOT chosen when choices are required.
  const given = (k: string, allowed: readonly string[]) => allowed.includes(one(q, k) ?? "");
  const chosen = { anchor: given("anchor", ["last", "strict"]), overdue: given("overdue", ["week1", "exclude"]) };
  const mult = num("mult", 0.01, d.anomaly.multiple, "Anomaly multiple");
  const floor = num("floor", 0, d.anomaly.floor, "Anomaly floor");
  const defaultCurve: CurveChoice = opts.suppliedCurve ? "supplied" : opts.local ? "rev2" : "none";
  const curve = pick<CurveChoice>("curve", opts.suppliedCurve ? ["none", "demand", "rev2", "supplied"] : ["none", "demand", "rev2"], defaultCurve, "Size curve");
  const formula = pick("formula", ["minimum-shortfall", "net-requirement"] as const, "minimum-shortfall", "Replenishment formula");
  const style = one(q, "style");
  const sel = one(q, "sel");

  const sizeCurve: SizeCurveConfig = curve === "supplied" && opts.suppliedCurve ? { kind: "explicit", weights: opts.suppliedCurve, label: "Size curve supplied with the synthetic data", provenance: "Synthetic fixture" } : curve === "rev2" ? { kind: "explicit", weights: REV2_SIZE_CURVE, label: REV2_CURVE_LABEL, provenance: REV2_CURVE_PROVENANCE } : curve === "demand" ? { kind: "demand-proportional" } : { kind: "none" };
  return {
    config: {
      forecastWindowMonths: win,
      horizonWeeks: horizon === "26" ? 26 : 13,
      historyAnchor: anchor === "strict" ? "strict" : "last-available",
      overdueOnWater: overdue === "exclude" ? "exclude" : "week-1",
      anomaly: { multiple: mult, floor },
      sizeCurve,
      replenishmentFormula: formula,
    },
    view,
    style: style && style !== "" ? style : null,
    shortageOnly: one(q, "only") === "shortage",
    sel: sel && sel !== "" ? sel : null,
    curve,
    chosen,
    values: { view, window: String(win), horizon, anchor, overdue, curve, mult: String(mult), floor: String(floor), formula },
    errors,
  };
}

/** The query string that reproduces these settings (used for links and for returning after an exclusion). */
export function settingsQuery(s: RedFlagSettings, extra: Readonly<Record<string, string | null>> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(s.values)) p.set(k, v);
  if (s.style) p.set("style", s.style);
  if (s.shortageOnly) p.set("only", "shortage");
  if (s.sel) p.set("sel", s.sel);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) p.delete(k);
    else p.set(k, v);
  }
  return p.toString();
}
