// NEWQUIP COMMERCIAL SETTINGS (pure; no I/O). MANAGER-ENTERED commercial inputs for automatic supplier pricing: markup, freight policy, exchange rates, cost-age escalation bands.
// NOTHING here is a default commercial rate. A freight policy and an exchange rate are NEVER defaulted to a number: until a Manager enters them they are `null` / absent and every
// price that needs them is withheld and flagged. The markup may be `null`, meaning "use the existing legacy rule value", which is labelled as NOT an approved policy.
// The escalation bands and the maximum age are the rules the OWNER approved as the proposed model (marginal bands, simple escalation, 365.25 days a year, 5-year maximum); they are
// the starting point a Manager may edit. All figures are exact integers (basis points, micro units, cents): there is no floating point anywhere in this file.

export const COMMERCIAL_SCHEMA = 1;
/** 365.25 days a year, held as an integer (days x 100) so age arithmetic stays exact. Fixed by the owner-approved model: validated, not editable. */
export const DAYS_PER_YEAR_CENTI = 36525;

export interface AgeBand {
  /** Whole years from which this band applies (inclusive). The first band starts at 0. */
  fromYears: number;
  /** Whole years at which it ends; null = no upper end (the last band). */
  toYears: number | null;
  /** Escalation per year of age spent inside this band, basis points (1000 = 10% a year). SIMPLE (not compound). */
  rateBps: number;
}
/** The owner-approved proposed bands: 0-1y 0%, 1-2y 10%, 2-3y 15%, over 3y 20% a year, marginal. */
export const OWNER_APPROVED_BANDS: readonly AgeBand[] = [
  { fromYears: 0, toYears: 1, rateBps: 0 }, { fromYears: 1, toYears: 2, rateBps: 1000 }, { fromYears: 2, toYears: 3, rateBps: 1500 }, { fromYears: 3, toYears: null, rateBps: 2000 },
];
export const OWNER_APPROVED_MAX_AGE_YEARS = 5;

export interface FreightPolicy { factorMicro: number; addOnCents: number; source: string }
export interface FxSetting {
  rateMicro: number; source: string;
  /** ISO instant the rate applies to (for a feed rate: the PROVIDER's own timestamp). */
  asOf: string;
  /** Where the rate came from: "oxr" = fetched from Open Exchange Rates; "manual" (or absent on older versions) = a Manager's own figure, an override that a feed refresh never replaces unless asked. */
  origin?: "oxr" | "manual";
  /** ISO instant WE retrieved a feed rate (feed rates only). */
  retrievedAt?: string;
}
/** Freight categories are the quotation's own item keys (for example bulk_tank, feeder). */
export const FREIGHT_CATEGORY_KEY = /^[a-z][a-z0-9_]{0,40}$/;
export const MAX_FREIGHT_CATEGORIES = 30;

export interface CommercialSettings {
  schema: typeof COMMERCIAL_SCHEMA;
  /** Markup on landed cost, bps. null = use the existing legacy POC rule value (NOT an approved policy; the UI says so). */
  markupBps: number | null;
  /** null = NOT SET. Never defaulted. */
  freight: FreightPolicy | null;
  /** Freight policies for specific product categories (the quotation item key). A category policy wins over the default `freight`; a product in no listed category uses the default, and where there is no default the product gets a clear exception (never 1.0). */
  freightByCategory: Record<string, FreightPolicy>;
  /** Foreign-currency rates (ZAR per 1 unit). A currency absent here has NO rate. */
  fx: Record<string, FxSetting>;
  /** A rate older than this many days is not used. */
  fxMaxAgeDays: number;
  ageBands: AgeBand[];
  maxAgeYears: number;
  daysPerYearCenti: number;
}

/** What a fresh settings record holds: nothing commercial is invented. The bands and maximum age are the owner-approved model; the FX maximum age is the legacy 24-hour spot rule (1 day), shown as a default. */
export function emptyCommercialSettings(): CommercialSettings {
  return { schema: COMMERCIAL_SCHEMA, markupBps: null, freight: null, freightByCategory: {}, fx: {}, fxMaxAgeDays: 1, ageBands: OWNER_APPROVED_BANDS.map((b) => ({ ...b })), maxAgeYears: OWNER_APPROVED_MAX_AGE_YEARS, daysPerYearCenti: DAYS_PER_YEAR_CENTI };
}

export const MARKUP_DEFAULT_LABEL = "Default from the legacy POC rule, not approved policy";

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

/** Every problem with a settings value, in plain words. Empty = valid. Pure; used by the Manager save path and by anything that reads stored settings back. */
export function validateCommercialSettings(s: CommercialSettings, nowIso: string): string[] {
  const e: string[] = [];
  if (s.schema !== COMMERCIAL_SCHEMA) e.push("The settings version is not recognised.");
  if (s.markupBps !== null && (!isInt(s.markupBps) || s.markupBps < 0 || s.markupBps > 100_000)) e.push("The markup must be between 0% and 1000%, or left on the default.");
  const checkFreight = (f: FreightPolicy, label: string) => {
    if (!isInt(f.factorMicro) || f.factorMicro < 1 || f.factorMicro > 100_000_000) e.push(`The ${label} factor must be greater than zero (1.000000 means no uplift).`);
    if (!isInt(f.addOnCents) || f.addOnCents < 0 || f.addOnCents > 10_000_000_000) e.push(`The ${label} add-on must be a whole number of cents, not negative.`);
    if (typeof f.source !== "string" || f.source.trim().length < 3 || f.source.length > 200) e.push(`The ${label} needs a source (3 to 200 characters).`);
  };
  if (s.freight !== null) checkFreight(s.freight, "freight");
  const cats = Object.entries(s.freightByCategory ?? {});
  if (cats.length > MAX_FREIGHT_CATEGORIES) e.push(`At most ${MAX_FREIGHT_CATEGORIES} freight categories.`);
  for (const [k, f] of cats) { if (RESERVED.has(k) || !FREIGHT_CATEGORY_KEY.test(k)) { e.push(`"${k.slice(0, 20)}" is not a valid freight category.`); continue; } checkFreight(f, `${k} freight`); }
  const now = Date.parse(nowIso);
  for (const [cur, q] of Object.entries(s.fx)) {
    if (RESERVED.has(cur) || !/^[A-Z]{3}$/.test(cur) || cur === "ZAR") { e.push(`"${cur.slice(0, 20)}" is not a foreign currency code (ZAR is always 1).`); continue; }
    if (!isInt(q.rateMicro) || q.rateMicro < 1 || q.rateMicro > 1_000_000_000) e.push(`The ${cur} rate must be greater than zero.`);
    if (typeof q.source !== "string" || q.source.trim().length < 3 || q.source.length > 200) e.push(`The ${cur} rate needs a source (3 to 200 characters).`);
    const t = typeof q.asOf === "string" && ISO_INSTANT.test(q.asOf) ? Date.parse(q.asOf) : NaN;
    if (q.origin !== undefined && q.origin !== "oxr" && q.origin !== "manual") e.push(`The ${cur} rate has an unknown origin.`);
    if (q.retrievedAt !== undefined && (typeof q.retrievedAt !== "string" || !ISO_INSTANT.test(q.retrievedAt))) e.push(`The ${cur} rate has an invalid retrieval time.`);
    if (!Number.isFinite(t)) e.push(`The ${cur} rate needs a valid date and time (for example 2026-11-12T08:00:00Z).`);
    else if (Number.isFinite(now) && t > now + 5 * 60_000) e.push(`The ${cur} rate cannot be dated in the future.`);
  }
  if (Object.keys(s.fx).length > 20) e.push("At most 20 currencies.");
  if (!isInt(s.fxMaxAgeDays) || s.fxMaxAgeDays < 1 || s.fxMaxAgeDays > 365) e.push("The exchange-rate maximum age must be 1 to 365 days.");
  if (!isInt(s.maxAgeYears) || s.maxAgeYears < 1 || s.maxAgeYears > 20) e.push("The maximum cost age must be 1 to 20 years.");
  if (s.daysPerYearCenti !== DAYS_PER_YEAR_CENTI) e.push("The year length is fixed at 365.25 days.");
  const b = s.ageBands;
  if (!Array.isArray(b) || b.length < 1 || b.length > 8) e.push("Give between 1 and 8 age bands.");
  else {
    let prevTo: number | null = 0;
    b.forEach((x, i) => {
      if (!isInt(x.fromYears) || x.fromYears < 0 || !isInt(x.rateBps) || x.rateBps < 0 || x.rateBps > 10_000 || (x.toYears !== null && !isInt(x.toYears))) { e.push(`Age band ${i + 1} is not valid (whole years; a yearly rate of 0% to 100%).`); prevTo = null; return; }
      if (prevTo === null) return;
      if (x.fromYears !== prevTo) e.push(`Age band ${i + 1} must start where the previous one ends (${prevTo} years).`);
      if (x.toYears !== null && x.toYears <= x.fromYears) e.push(`Age band ${i + 1} must end after it starts.`);
      if (x.toYears === null && i !== b.length - 1) e.push("Only the last age band can be open-ended.");
      prevTo = x.toYears;
    });
    if (b.length > 0 && b[b.length - 1].toYears !== null) e.push("The last age band must be open-ended (no end year).");
  }
  return e;
}

/** Parses an UNTRUSTED value (a stored block or a form submission) into settings, keeping only known keys. Returns the problems instead of throwing. */
export function parseCommercialSettings(raw: unknown, nowIso: string): { ok: true; value: CommercialSettings } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ["The commercial settings are not valid."] };
  const fx: Record<string, FxSetting> = {};
  if (isObj(raw.fx)) for (const [k, v] of Object.entries(raw.fx)) { if (RESERVED.has(k) || !isObj(v)) continue; fx[k] = { rateMicro: v.rateMicro as number, source: typeof v.source === "string" ? v.source.trim() : "", asOf: typeof v.asOf === "string" ? v.asOf : "", ...(v.origin === undefined ? {} : { origin: v.origin as FxSetting["origin"] }), ...(v.retrievedAt === undefined ? {} : { retrievedAt: v.retrievedAt as string }) }; }
  else if (raw.fx !== undefined) return { ok: false, errors: ["The exchange rates are not valid."] };
  const freightByCategory: Record<string, FreightPolicy> = {};
  if (isObj(raw.freightByCategory)) for (const [k, v] of Object.entries(raw.freightByCategory)) { if (RESERVED.has(k) || !isObj(v)) continue; freightByCategory[k] = { factorMicro: v.factorMicro as number, addOnCents: (v.addOnCents ?? 0) as number, source: typeof v.source === "string" ? v.source.trim() : "" }; }
  else if (raw.freightByCategory !== undefined) return { ok: false, errors: ["The freight categories are not valid."] };
  const f = raw.freight;
  const value: CommercialSettings = {
    schema: raw.schema as typeof COMMERCIAL_SCHEMA,
    markupBps: raw.markupBps === null || raw.markupBps === undefined ? null : (raw.markupBps as number),
    freight: isObj(f) ? { factorMicro: f.factorMicro as number, addOnCents: (f.addOnCents ?? 0) as number, source: typeof f.source === "string" ? f.source.trim() : "" } : f === null || f === undefined ? null : ({ factorMicro: NaN, addOnCents: NaN, source: "" }),
    freightByCategory,
    fx,
    fxMaxAgeDays: raw.fxMaxAgeDays as number,
    ageBands: Array.isArray(raw.ageBands) ? raw.ageBands.map((x) => (isObj(x) ? { fromYears: x.fromYears as number, toYears: (x.toYears ?? null) as number | null, rateBps: x.rateBps as number } : { fromYears: NaN, toYears: null, rateBps: NaN })) : [],
    maxAgeYears: raw.maxAgeYears as number,
    daysPerYearCenti: raw.daysPerYearCenti as number,
  };
  const errors = validateCommercialSettings(value, nowIso);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ── completeness: what is still UNRESOLVED ─────────────────────────────────

export interface UnresolvedItem {
  code: "freight_not_set" | "freight_default_not_set" | "fx_none_set" | "fx_stale" | "fx_missing_currency" | "markup_default";
  /** "blocking" = prices that need it are withheld; "notice" = a default is in use and is not an approved policy. */
  severity: "blocking" | "notice";
  text: string;
}

/** Everything a Manager still has to resolve before automatic prices can be produced. NEVER fills a gap with a number. `currencies` = foreign currencies known to be needed (optional). */
export function unresolvedItems(s: CommercialSettings | null, nowIso: string, currencies: readonly string[] = []): UnresolvedItem[] {
  const x = s ?? emptyCommercialSettings();
  const out: UnresolvedItem[] = [];
  if (x.freight === null && Object.keys(x.freightByCategory ?? {}).length === 0) out.push({ code: "freight_not_set", severity: "blocking", text: "Freight policy not set. No automatic price can be produced until a Manager enters it." });
  else if (x.freight === null) out.push({ code: "freight_default_not_set", severity: "notice", text: "No default freight policy: only products in a category with its own freight policy can be priced; every other product gets an exception." });
  const cur = Object.keys(x.fx);
  if (cur.length === 0 && currencies.length === 0) out.push({ code: "fx_none_set", severity: "blocking", text: "No exchange rates set. Products costed in a foreign currency cannot be priced." });
  const now = Date.parse(nowIso);
  for (const c of cur.sort()) if (!fxFresh(x.fx[c], x.fxMaxAgeDays, now)) out.push({ code: "fx_stale", severity: "blocking", text: `${c} exchange rate is older than ${x.fxMaxAgeDays} day${x.fxMaxAgeDays === 1 ? "" : "s"}.` });
  for (const c of [...new Set(currencies)].sort()) if (c !== "ZAR" && !x.fx[c]) out.push({ code: "fx_missing_currency", severity: "blocking", text: `${c} exchange rate not set.` });
  if (x.markupBps === null) out.push({ code: "markup_default", severity: "notice", text: `Markup is on the ${MARKUP_DEFAULT_LABEL.toLowerCase()}. A Manager should confirm or enter one.` });
  return out;
}

export function fxFresh(q: FxSetting | undefined, maxAgeDays: number, nowMs: number): boolean {
  if (!q) return false;
  const t = Date.parse(q.asOf);
  return Number.isFinite(t) && Number.isFinite(nowMs) && nowMs - t <= maxAgeDays * DAY_MS;
}

/** True when automatic pricing can price at least a ZAR-costed product: a freight policy exists. (FX is judged per currency.) */
export const canPriceAnything = (s: CommercialSettings | null): boolean => !!s && (s.freight !== null || Object.keys(s.freightByCategory ?? {}).length > 0);

/** The freight policy for a product used by these categories (quotation item keys): a category policy wins; otherwise the default; otherwise NONE (the caller flags it: freight is never silently 1.0).
 *  Two categories with DIFFERENT policies for one product is a conflict a person must resolve. */
export type FreightResolution = { ok: true; policy: FreightPolicy; category: string | null } | { ok: false; reason: "not_set" | "conflict"; categories: string[] };
export function resolveFreight(s: CommercialSettings, categories: readonly string[]): FreightResolution {
  const all = [...new Set(categories)];
  const hits = all.filter((c) => Object.prototype.hasOwnProperty.call(s.freightByCategory ?? {}, c)).sort();
  if (hits.length > 0) {
    const first = s.freightByCategory[hits[0]];
    const differs = (f: FreightPolicy) => f.factorMicro !== first.factorMicro || f.addOnCents !== first.addOnCents;
    if (hits.some((c) => differs(s.freightByCategory[c]))) return { ok: false, reason: "conflict", categories: hits };
    // The product is ALSO used by an item with no category policy of its own: that use would fall back to the default (or to nothing), so unless the default is the same policy a person must decide.
    const unlisted = all.filter((c) => !hits.includes(c));
    if (unlisted.length > 0 && (s.freight === null || differs(s.freight))) return { ok: false, reason: "conflict", categories: [...hits, ...unlisted.sort()] };
    return { ok: true, policy: first, category: hits[0] };
  }
  if (s.freight !== null) return { ok: true, policy: s.freight, category: null };
  return { ok: false, reason: "not_set", categories: [...new Set(categories)].sort() };
}
