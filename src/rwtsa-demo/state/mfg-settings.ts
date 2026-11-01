import { DEFAULT_BRACKET_BREAKS } from "@/rwtsa-demo/engine/production-variance";
import type { PercentScale, SizeRule } from "@/rwtsa-demo/engine/bom-costing";
import type { RawQuery } from "@/rwtsa-demo/state/red-flag-settings";

/** Scenario B controls, carried in the URL (plain GET form). Invalid values are reported and replaced by the default; never echoed. */
export type GroupBy = "style" | "line" | "bracket";

export interface MfgSettings {
  readonly percentScale: PercentScale | null;
  readonly markup: number;
  readonly sizeRule: SizeRule;
  readonly bracketBreaks: readonly number[];
  readonly by: GroupBy;
  readonly style: string | null;
  readonly size: string | null;
  readonly values: Readonly<Record<"scale" | "markup" | "rule" | "brackets" | "by", string>>;
  readonly errors: readonly string[];
}

const one = (q: RawQuery, k: string): string | undefined => {
  const v = q[k];
  return Array.isArray(v) ? (v as readonly string[])[0] : (v as string | undefined);
};

/** `suggestedScale` is applied only when the source SUPPLIES a known scale (the synthetic fixture). A local workbook has none until the user chooses. */
export function parseMfgSettings(q: RawQuery, opts: { suggestedScale: PercentScale | null }): MfgSettings {
  const errors: string[] = [];
  let scale: PercentScale | null = opts.suggestedScale;
  const sc = one(q, "scale");
  if (sc !== undefined && sc !== "") {
    if (sc === "fraction" || sc === "percent") scale = sc;
    else if (sc === "unset") scale = null;
    else errors.push("Percentage scale: unsupported value, default used.");
  }
  let markup = 1.6;
  const mk = one(q, "markup");
  if (mk !== undefined && mk !== "") {
    const n = Number(mk);
    if (/^\d+(\.\d+)?$/.test(mk) && Number.isFinite(n) && n >= 1 && n <= 10) markup = n;
    else errors.push("Markup: a multiplier from 1 to 10, default used.");
  }
  let rule: SizeRule = "replace";
  const ru = one(q, "rule");
  if (ru !== undefined && ru !== "") {
    if (ru === "replace" || ru === "add") rule = ru;
    else errors.push("Size rule: unsupported value, default used.");
  }
  let breaks: readonly number[] = DEFAULT_BRACKET_BREAKS;
  const br = one(q, "brackets");
  if (br !== undefined && br !== "") {
    const parts = br.split(",").map((x) => x.trim());
    const nums = parts.map(Number);
    const ok = parts.every((x) => /^\d{1,7}$/.test(x)) && nums.length <= 12 && nums.every((n, i) => n > (i === 0 ? 0 : nums[i - 1]));
    if (ok) breaks = nums;
    else errors.push("Order-size brackets: whole numbers above 0 in ascending order, at most 12; default used.");
  }
  let by: GroupBy = "style";
  const b = one(q, "by");
  if (b !== undefined && b !== "") {
    if (b === "style" || b === "line" || b === "bracket") by = b;
    else errors.push("Grouping: style, line or bracket; default used.");
  }
  const style = one(q, "style");
  const size = one(q, "size");
  return {
    percentScale: scale,
    markup,
    sizeRule: rule,
    bracketBreaks: breaks,
    by,
    style: style && style !== "" ? style : null,
    size: size && size !== "" ? size : null,
    values: { scale: scale ?? "unset", markup: String(markup), rule, brackets: breaks.join(","), by },
    errors,
  };
}
