import type { QuoteDraft } from "../grower/draft";
import { stableStringify } from "../quote/baseline";
import type { QuoteState } from "../quote/workflow";

// WHO CHANGED WHAT, AFTER THE HANDOFF (NQ-008A). Pure. Once a quotation is with the Estimator, every change to a price-affecting input is stamped by the SERVER with the
// actor and the time, in the same save that stores the change (so it can never be applied without its attribution, and a client can never write its own).
// Same pattern as stampPriceResolutions / stampCostOverrides. The stamp keeps only the LATEST change to each input; the full original-versus-current picture comes from
// the immutable indicative snapshot, so the comparison is always "what the Rep handed off" against "now", attributed to whoever last touched each input.
//
// A stamp carries the revision it was made in: a returned quotation is handed off again as a new revision with a new snapshot, and the older stamps no longer apply.

export interface ChangeStamp { by: string; at: string; rev: number }
export type ChangeStamps = Record<string, ChangeStamp>;

/** Maps whose entries are tracked one by one: [where in the draft, stamp key prefix, human label]. */
const TRACKED_MAPS: { section: "estimator" | "config"; field: string; prefix: string; label: string }[] = [
  { section: "estimator", field: "charges", prefix: "charges", label: "Charge" },
  { section: "estimator", field: "unitPrices", prefix: "unitPrices", label: "Estimator price" },
  { section: "estimator", field: "confirmedMappings", prefix: "confirmedMappings", label: "Product mapping" },
  { section: "config", field: "estimatorQuantities", prefix: "estimatorQuantities", label: "Quantity" },
  { section: "config", field: "quantityOverrides", prefix: "quantityOverrides", label: "Quantity override" },
  { section: "config", field: "exclusions", prefix: "exclusions", label: "Exclusion" },
  { section: "config", field: "optionalEquipment", prefix: "optionalEquipment", label: "Optional equipment" },
];
/** Single values tracked as one input each. */
const TRACKED_SCALARS: { key: string; label: string; read: (d: QuoteDraft) => unknown }[] = [
  { key: "quoteType", label: "Quotation type", read: (d) => d.quoteType },
  { key: "penningPigSize", label: "Penning pig size", read: (d) => d.config.penningPigSize ?? null },
  { key: "penningRunningMetresPerRoom", label: "Penning running metres", read: (d) => d.config.penningRunningMetresPerRoom ?? null },
  { key: "feederVariant", label: "Feeder variant", read: (d) => d.config.feederVariant ?? null },
];
const TRACKED_CONFIG_FIELDS = new Set(["estimatorQuantities", "quantityOverrides", "quantityOverrideReasons", "exclusions", "optionalEquipment", "penningPigSize", "penningRunningMetresPerRoom", "feederVariant"]);
/** Everything else in the configuration (dimensions, rooms, pens, pigs, selections): one combined input. */
const LAYOUT_KEY = "layout";

const mapOf = (d: QuoteDraft, section: "estimator" | "config", field: string): Record<string, unknown> =>
  ((d[section] as unknown as Record<string, unknown>)[field] as Record<string, unknown> | undefined) ?? {};

function layoutOf(d: QuoteDraft): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.config)) if (!TRACKED_CONFIG_FIELDS.has(k)) rest[k] = v;
  return stableStringify(rest);
}

/** The current value of every tracked input, keyed by stamp key. Absent and null are the same ("not set"). */
export function trackedValues(d: QuoteDraft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of TRACKED_MAPS) for (const [k, v] of Object.entries(mapOf(d, m.section, m.field))) out[`${m.prefix}.${k}`] = stableStringify(v ?? null);
  for (const s of TRACKED_SCALARS) out[s.key] = stableStringify(s.read(d) ?? null);
  out[LAYOUT_KEY] = layoutOf(d);
  return out;
}

export function changeStampLabel(key: string): string {
  const scalar = TRACKED_SCALARS.find((s) => s.key === key);
  if (scalar) return scalar.label;
  if (key === LAYOUT_KEY) return "Building layout / configuration";
  const dot = key.indexOf(".");
  const m = TRACKED_MAPS.find((t) => t.prefix === key.slice(0, dot));
  return m ? `${m.label}: ${key.slice(dot + 1)}` : key;
}

export interface StampContext { state: QuoteState; revision: number; email: string; nowIso: string }

/**
 * Returns the draft with its change stamps decided by the server. Whatever stamps the submitted draft carries are discarded: the stored (prior) stamps are kept and
 * extended ONLY for inputs whose value actually changed, and only while the quotation is with the Estimator. A draft with no stamps carries no `changeStamps` key at all,
 * so a quotation nobody has changed hashes exactly as before.
 */
export function stampChanges(submitted: QuoteDraft, prior: QuoteDraft | undefined, ctx: StampContext): QuoteDraft {
  const keep = prior?.estimator.changeStamps ?? {};
  const next = structuredClone(submitted);
  const stamps: ChangeStamps = {};
  for (const [k, v] of Object.entries(keep)) if (v && typeof v.by === "string" && typeof v.at === "string" && Number.isInteger(v.rev)) stamps[k] = { by: v.by, at: v.at, rev: v.rev };

  if (prior && ctx.state === "ESTIMATOR_REVIEW") {
    const before = trackedValues(prior);
    const after = trackedValues(next);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if ((before[key] ?? stableStringify(null)) !== (after[key] ?? stableStringify(null))) stamps[key] = { by: ctx.email, at: ctx.nowIso, rev: ctx.revision };
    }
  }
  if (Object.keys(stamps).length > 0) next.estimator.changeStamps = stamps; else delete next.estimator.changeStamps;
  return next;
}

/** The stamps that apply to a handoff: made in the same revision, after the snapshot was captured. */
export function stampsSince(stamps: ChangeStamps | undefined, revision: number, capturedAtIso: string): ChangeStamps {
  const out: ChangeStamps = {};
  const since = Date.parse(capturedAtIso); // compared as instants: the database and the server format timestamps differently
  for (const [k, v] of Object.entries(stamps ?? {})) if (v.rev === revision && Date.parse(v.at) >= since) out[k] = v;
  return out;
}
