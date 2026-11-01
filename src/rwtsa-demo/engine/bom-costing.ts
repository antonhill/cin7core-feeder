import { SIZE_ORDER } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { scaleCents, toCents, type Cents } from "./money";

/**
 * Scenario B product cost by style and size, in integer cents.
 *
 *   materials, trims, thread, print, packaging = BOM quantity x unit cost (size-specific rows applied per size)
 *   labour (cut / make / trim)                 = SMV x cost per minute, per routing operation
 *   efficiency allowance                       = labour / efficiency - labour, per operation
 *   overhead                                   = overhead % of the efficiency-adjusted labour, per operation
 *   selling price                              = cost x markup (default 1.6)
 *
 * Nothing is invented: a missing price, rate or percentage leaves the cost INCOMPLETE and names what is missing. The percentage
 * scale of overhead and efficiency (0.15 versus 15) is never assumed: it must be chosen, and an unchosen scale makes the
 * percentage-dependent lines unresolved.
 */

export type PercentScale = "fraction" | "percent";
export type SizeRule = "replace" | "add";

export interface CostingConfig {
  readonly percentScale: PercentScale | null;
  readonly markup?: number;
  readonly sizeRule?: SizeRule;
}

export interface CostLine {
  readonly code: string;
  readonly label: string;
  readonly category: "fabric-materials" | "trims-thread" | "print-packaging" | "other" | "labour" | "efficiency" | "overhead";
  readonly cents: Cents;
  /** BOM lines only: quantity per unit and unit cost, as read from the workbook. */
  readonly qty?: number | null;
  readonly unitCost?: number | null;
}

export interface SizeCosting {
  readonly size: string;
  readonly sku: string | null;
  readonly lines: readonly CostLine[];
  readonly groups: {
    readonly fabricMaterialsCents: Cents | null;
    readonly trimsThreadCents: Cents | null;
    readonly printPackagingCents: Cents | null;
    readonly otherCents: Cents | null;
  };
  readonly cmt: { readonly cutCents: Cents | null; readonly makeCents: Cents | null; readonly trimCents: Cents | null; readonly otherCents: Cents | null };
  readonly labourBaseCents: Cents | null;
  readonly efficiencyAllowanceCents: Cents | null;
  readonly overheadCents: Cents | null;
  readonly totalCents: Cents | null;
  readonly sellingCents: Cents | null;
  readonly referenceCents: Cents | null;
  /** calculated - reference. */
  readonly diffCents: Cents | null;
  readonly diffPct: number | null;
  /** This size's total minus the smallest size's total. */
  readonly deltaVsBaseCents: Cents | null;
  readonly substitutions: readonly { readonly replaced: string; readonly by: string; readonly group: string }[];
  readonly missing: readonly string[];
  readonly status: "complete" | "incomplete";
}

export interface StyleCosting {
  readonly styleCode: string;
  readonly sizes: readonly SizeCosting[];
  readonly bomRows: number;
  readonly operations: number;
}

export interface CostingCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface CostingAssumption {
  readonly id: string;
  readonly text: string;
}
export interface ScaleObservation {
  readonly hint: "none" | "fraction-or-small-percent" | "percent" | "mixed";
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
}

export interface CostingResult {
  readonly config: { readonly percentScale: PercentScale | null; readonly markup: number; readonly sizeRule: SizeRule };
  readonly scale: PercentScale | null;
  /** What the overhead / efficiency / margin columns look like. A hint only: it is never applied. */
  readonly scaleObservation: ScaleObservation;
  readonly styles: readonly StyleCosting[];
  readonly checks: readonly CostingCheck[];
  readonly assumptions: readonly CostingAssumption[];
  readonly warnings: readonly string[];
}

/** Describes the range of percentage-like values. 0.15 could be 15% or 0.15%, so values that all sit at or below 1 are never called fractions with certainty. */
export function detectPercentScale(values: readonly (number | null)[]): ScaleObservation {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return { hint: "none", count: 0, min: null, max: null };
  const min = Math.min(...v);
  const max = Math.max(...v);
  const hint = max <= 1 ? "fraction-or-small-percent" : min > 1 ? "percent" : "mixed";
  return { hint, count: v.length, min, max };
}

const sizeIndex = (s: string): number => (SIZE_ORDER as readonly string[]).indexOf(s);

function categoryOf(type: string | null): CostLine["category"] {
  const t = (type ?? "").toLowerCase();
  if (/fabric|material/.test(t)) return "fabric-materials";
  if (/trim|thread/.test(t)) return "trims-thread";
  if (/print|pack/.test(t)) return "print-packaging";
  return "other";
}
function cmtOf(op: string): "cut" | "make" | "trim" | "other" {
  const o = op.toLowerCase();
  if (/cut/.test(o)) return "cut";
  if (/sew|make|machin|stitch/.test(o)) return "make";
  if (/trim|pack|finish/.test(o)) return "trim";
  return "other";
}
/** Substitution group: the component type and the part of its name before any bracket ("Zip (short)" -> "zip"). */
function groupOf(type: string | null, name: string | null, code: string): string {
  return `${(type ?? "").toLowerCase().trim()}|${(name ?? code).split("(")[0].trim().toLowerCase()}`;
}
const stemOf = (name: string | null, code: string): string => (name ?? code).split("(")[0].trim().toLowerCase();

export function runCosting(ds: RwtsaDataset, config: CostingConfig): CostingResult {
  const markup = config.markup ?? 1.6;
  const sizeRule = config.sizeRule ?? "replace";
  if (!Number.isFinite(markup) || markup < 1) throw new Error("Invalid markup: a multiplier of at least 1.");
  if (sizeRule !== "replace" && sizeRule !== "add") throw new Error("Invalid size rule.");
  const scale = config.percentScale;
  if (scale !== null && scale !== "fraction" && scale !== "percent") throw new Error("Invalid percentage scale.");

  const bomBy = new Map<string, typeof ds.tables.bom[number][]>();
  for (const b of ds.tables.bom) bomBy.set(b.styleCode, [...(bomBy.get(b.styleCode) ?? []), b]);
  const opsBy = new Map<string, typeof ds.tables.routing[number][]>();
  for (const r of ds.tables.routing) opsBy.set(r.styleCode, [...(opsBy.get(r.styleCode) ?? []), r]);
  const itemsBy = new Map<string, typeof ds.tables.items[number][]>();
  const styleOrder: string[] = [];
  for (const i of ds.tables.items) {
    if (!itemsBy.has(i.styleCode)) {
      itemsBy.set(i.styleCode, []);
      styleOrder.push(i.styleCode);
    }
    (itemsBy.get(i.styleCode) as typeof ds.tables.items[number][]).push(i);
  }

  const warnings: string[] = [];
  const unclassified = new Set<string>();
  const added = new Set<string>();

  /** Converts a stored percentage to a fraction under the chosen scale, or returns why it cannot. */
  const toFraction = (v: number | null, what: "overhead" | "efficiency"): { f: number } | { why: string } => {
    if (v === null) return { why: `${what} (blank in Routing_SMV)` };
    if (scale === null) return { why: "percentage scale not chosen" };
    const f = scale === "percent" ? v / 100 : v;
    const max = what === "efficiency" ? 1 : 5;
    if (!Number.isFinite(f) || f < 0 || f > max || (what === "efficiency" && f === 0)) return { why: `${what} value out of range for the ${scale} scale` };
    return { f };
  };

  const styles: StyleCosting[] = styleOrder.map((styleCode) => {
    const items = [...(itemsBy.get(styleCode) as typeof ds.tables.items[number][])].sort((a, b) => (sizeIndex(a.size) < 0 ? 99 : sizeIndex(a.size)) - (sizeIndex(b.size) < 0 ? 99 : sizeIndex(b.size)));
    const bom = bomBy.get(styleCode) ?? [];
    const ops = opsBy.get(styleCode) ?? [];

    const sizes: SizeCosting[] = items.map((item) => {
      const missing: string[] = [];
      const lines: CostLine[] = [];
      const subs: { replaced: string; by: string; group: string }[] = [];
      if (bom.length === 0) missing.push("bill of material for this style");
      if (ops.length === 0) missing.push("routing operations for this style");

      // --- which BOM rows apply to this size ---
      const idx = sizeIndex(item.size);
      const restricted = (b: typeof bom[number]) => b.size !== null || b.sizeFrom !== null;
      const applies = (b: typeof bom[number]): boolean | null => {
        if (b.size !== null && b.sizeFrom !== null) return null;
        if (b.size !== null) return b.size === item.size;
        if (b.sizeFrom !== null) {
          const from = sizeIndex(b.sizeFrom);
          if (idx < 0 || from < 0) return null;
          return idx >= from;
        }
        return true;
      };
      let rows: typeof bom = [];
      const applicable: typeof bom = [];
      for (const b of bom) {
        const a = applies(b);
        if (a === null) {
          missing.push(`size rule for ${b.componentCode} cannot be resolved for size ${item.size}`);
          continue;
        }
        if (a) applicable.push(b);
      }
      if (sizeRule === "replace") {
        const specific = applicable.filter(restricted);
        const specificGroups = new Map(specific.map((b) => [groupOf(b.componentType, b.componentName, b.componentCode), b]));
        for (const b of applicable) {
          if (restricted(b)) {
            rows.push(b);
            continue;
          }
          const repl = specificGroups.get(groupOf(b.componentType, b.componentName, b.componentCode));
          if (repl) subs.push({ replaced: b.componentCode, by: repl.componentCode, group: stemOf(b.componentName, b.componentCode) });
          else rows.push(b);
        }
        for (const b of specific) {
          const hasBase = bom.some((u) => !restricted(u) && groupOf(u.componentType, u.componentName, u.componentCode) === groupOf(b.componentType, b.componentName, b.componentCode));
          if (!hasBase) added.add(`${styleCode}:${b.componentCode}`);
        }
      } else {
        rows = applicable;
      }

      // --- component lines ---
      const groupMissing: Record<string, boolean> = {};
      for (const b of rows) {
        const cat = categoryOf(b.componentType);
        if (cat === "other") unclassified.add(`${styleCode}:${b.componentCode}`);
        if (b.unitCost === null) {
          missing.push(`unit cost of ${b.componentCode}`);
          groupMissing[cat] = true;
          continue;
        }
        lines.push({ code: b.componentCode, label: b.componentName ?? b.componentCode, category: cat, cents: toCents(b.qtyPerUnit * b.unitCost), qty: b.qtyPerUnit, unitCost: b.unitCost });
      }
      const groupSum = (cat: CostLine["category"]): Cents | null => (groupMissing[cat] ? null : lines.filter((l) => l.category === cat).reduce((a, l) => a + l.cents, 0));

      // --- labour, efficiency allowance and overhead, per operation ---
      const cmt = { cut: 0, make: 0, trim: 0, other: 0 };
      let base = 0;
      let allowance = 0;
      let overhead = 0;
      let pctOk = ops.length > 0;
      const pctWhy = new Set<string>();
      for (const o of ops) {
        const opBase = toCents(o.smv * o.costPerMinute);
        base += opBase;
        cmt[cmtOf(o.operation)] += opBase;
        lines.push({ code: `labour:${o.operation}`, label: `Labour: ${o.operation}`, category: "labour", cents: opBase });
        const eff = toFraction(o.efficiency, "efficiency");
        const ovh = toFraction(o.overhead, "overhead");
        if ("why" in eff) pctWhy.add(eff.why);
        if ("why" in ovh) pctWhy.add(ovh.why);
        if ("why" in eff || "why" in ovh) {
          pctOk = false;
          continue;
        }
        const adjusted = scaleCents(opBase, 1 / eff.f);
        const allow = adjusted - opBase;
        const ovhCents = scaleCents(adjusted, ovh.f);
        allowance += allow;
        overhead += ovhCents;
        lines.push({ code: `efficiency:${o.operation}`, label: `Efficiency allowance: ${o.operation}`, category: "efficiency", cents: allow });
        lines.push({ code: `overhead:${o.operation}`, label: `Overhead: ${o.operation}`, category: "overhead", cents: ovhCents });
      }
      if (!pctOk && ops.length > 0) for (const w of pctWhy) missing.push(w.startsWith("percentage scale") ? "percentage scale (overhead and efficiency need it)" : w);

      const total = missing.length === 0 ? lines.reduce((a, l) => a + l.cents, 0) : null;
      const sell = total === null ? null : scaleCents(total, markup);
      const reference = toCents(item.standardCost);
      const diff = total === null ? null : total - reference;
      return {
        size: item.size,
        sku: item.sku,
        lines,
        groups: { fabricMaterialsCents: groupSum("fabric-materials"), trimsThreadCents: groupSum("trims-thread"), printPackagingCents: groupSum("print-packaging"), otherCents: groupSum("other") },
        cmt: ops.length === 0 ? { cutCents: null, makeCents: null, trimCents: null, otherCents: null } : { cutCents: cmt.cut, makeCents: cmt.make, trimCents: cmt.trim, otherCents: cmt.other },
        labourBaseCents: ops.length > 0 ? base : null,
        efficiencyAllowanceCents: pctOk && ops.length > 0 ? allowance : null,
        overheadCents: pctOk && ops.length > 0 ? overhead : null,
        totalCents: total,
        sellingCents: sell,
        referenceCents: reference,
        diffCents: diff,
        diffPct: diff !== null && reference !== 0 ? (diff / reference) * 100 : null,
        deltaVsBaseCents: null,
        substitutions: subs,
        missing: [...new Set(missing)],
        status: missing.length === 0 ? "complete" : "incomplete",
      } satisfies SizeCosting;
    });

    const baseSize = sizes.find((s) => s.totalCents !== null);
    const withDelta = sizes.map((s) => ({ ...s, deltaVsBaseCents: s.totalCents !== null && baseSize ? s.totalCents - (baseSize.totalCents as number) : null }));
    return { styleCode, sizes: withDelta, bomRows: bom.length, operations: ops.length };
  });

  const all = styles.flatMap((s) => s.sizes);
  const complete = all.filter((s) => s.status === "complete");
  const linesOk = complete.every((s) => s.lines.reduce((a, l) => a + l.cents, 0) === s.totalCents);
  const groupsOk = complete.every(
    (s) =>
      (s.groups.fabricMaterialsCents ?? 0) + (s.groups.trimsThreadCents ?? 0) + (s.groups.printPackagingCents ?? 0) + (s.groups.otherCents ?? 0) + (s.labourBaseCents ?? 0) + (s.efficiencyAllowanceCents ?? 0) + (s.overheadCents ?? 0) === s.totalCents &&
      (s.cmt.cutCents ?? 0) + (s.cmt.makeCents ?? 0) + (s.cmt.trimCents ?? 0) + (s.cmt.otherCents ?? 0) === s.labourBaseCents
  );
  const diffs = complete.filter((s) => (s.diffCents ?? 0) !== 0).length;
  const checks: CostingCheck[] = [
    { id: "lines", label: "Each size's cost lines add up to its total, to the cent", ok: linesOk, detail: `${complete.length} complete size(s) checked.` },
    { id: "groups", label: "Material groups, cut-make-trim, allowance and overhead add up to the total", ok: groupsOk, detail: `${complete.length} complete size(s) checked.` },
    { id: "reference", label: "Calculated cost agrees with the workbook's reference cost (Items.standardCost)", ok: complete.length > 0 && diffs === 0, detail: complete.length === 0 ? "No complete size to compare." : diffs === 0 ? "No difference." : `${diffs} of ${complete.length} complete size(s) differ.` },
    { id: "complete", label: "Every style and size has all the inputs for a cost", ok: all.length > 0 && complete.length === all.length, detail: `${complete.length} of ${all.length} size(s) complete.` },
  ];

  if (all.length > complete.length) warnings.push(`${all.length - complete.length} style/size cost(s) are incomplete; their totals are withheld rather than estimated.`);
  if (unclassified.size > 0) warnings.push(`${unclassified.size} BOM component(s) have an unclassified type; they are included in the cost under "Other".`);
  if (added.size > 0) warnings.push(`${added.size} size-specific BOM row(s) have no matching base component, so they are added rather than substituted.`);

  const routingPcts = ds.tables.routing.flatMap((r) => [r.overhead, r.efficiency, r.margin]);
  const assumptions: CostingAssumption[] = [
    { id: "size-substitution", text: sizeRule === "replace" ? "A BOM row restricted to a size (size, or size from) REPLACES the base component of the same type and name (before any bracket), for the sizes it applies to. No supplied link says which component replaces which, so this match is an assumption; switch to 'add' to keep both." : "A size-restricted BOM row is ADDED to the base components for the sizes it applies to (nothing is substituted)." },
    { id: "labour-size", text: "Routing_SMV has no size column, so labour minutes are the same for every size of a style." },
    { id: "efficiency", text: "Efficiency is a level (labour / efficiency); the allowance is the extra over the plain SMV x cost per minute. Applied per operation. Unconfirmed until the workbook is inspected." },
    { id: "overhead", text: "Overhead is a percentage of the efficiency-adjusted labour, per operation. Unconfirmed until the workbook is inspected." },
    { id: "selling-price", text: `Selling price = cost x ${markup}. The Routing_SMV margin column is NOT used for it.` },
    { id: "percent-scale", text: scale === null ? "The percentage scale of overhead and efficiency has NOT been chosen, so those lines are unresolved. 15, 0.15 and 15% are not assumed to mean the same." : `Overhead and efficiency are read on the ${scale === "percent" ? "percent (15 means 15%)" : "fraction (0.15 means 15%)"} scale because it was chosen, not because the workbook says so.` },
  ];

  return { config: { percentScale: scale, markup, sizeRule }, scale, scaleObservation: detectPercentScale(routingPcts), styles, checks, assumptions, warnings };
}
