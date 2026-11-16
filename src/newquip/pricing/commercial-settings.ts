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
export interface FxSetting { rateMicro: number; source: string; /** ISO instant the rate applies to. */ asOf: string }

export interface CommercialSettings {
  schema: typeof COMMERCIAL_SCHEMA;
  /** Markup on landed cost, bps. null = use the existing legacy POC rule value (NOT an approved policy; the UI says so). */
  markupBps: number | null;
  /** null = NOT SET. Never defaulted. */
  freight: FreightPolicy | null;
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
  return { schema: COMMERCIAL_SCHEMA, markupBps: null, freight: null, fx: {}, fxMaxAgeDays: 1, ageBands: OWNER_APPROVED_BANDS.map((b) => ({ ...b })), maxAgeYears: OWNER_APPROVED_MAX_AGE_YEARS, daysPerYearCenti: DAYS_PER_YEAR_CENTI };
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
  if (s.freight !== null) {
    const f = s.freight;
    if (!isInt(f.factorMicro) || f.factorMicro < 1 || f.factorMicro > 100_000_000) e.push("The freight factor must be greater than zero (1.000000 means no uplift).");
    if (!isInt(f.addOnCents) || f.addOnCents < 0 || f.addOnCents > 10_000_000_000) e.push("The freight add-on must be a whole number of cents, not negative.");
    if (typeof f.source !== "string" || f.source.trim().length < 3 || f.source.length > 200) e.push("The freight policy needs a source (3 to 200 characters).");
  }
  const now = Date.parse(nowIso);
  for (const [cur, q] of Object.entries(s.fx)) {
    if (RESERVED.has(cur) || !/^[A-Z]{3}$/.test(cur) || cur === "ZAR") { e.push(`"${cur.slice(0, 20)}" is not a foreign currency code (ZAR is always 1).`); continue; }
    if (!isInt(q.rateMicro) || q.rateMicro < 1 || q.rateMicro > 1_000_000_000) e.push(`The ${cur} rate must be greater than zero.`);
    if (typeof q.source !== "string" || q.source.trim().length < 3 || q.source.length > 200) e.push(`The ${cur} rate needs a source (3 to 200 characters).`);
    const t = typeof q.asOf === "string" && ISO_INSTANT.test(q.asOf) ? Date.parse(q.asOf) : NaN;
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
  if (isObj(raw.fx)) for (const [k, v] of Object.entries(raw.fx)) { if (RESERVED.has(k) || !isObj(v)) continue; fx[k] = { rateMicro: v.rateMicro as number, source: typeof v.source === "string" ? v.source.trim() : "", asOf: typeof v.asOf === "string" ? v.asOf : "" }; }
  else if (raw.fx !== undefined) return { ok: false, errors: ["The exchange rates are not valid."] };
  const f = raw.freight;
  const value: CommercialSettings = {
    schema: raw.schema as typeof COMMERCIAL_SCHEMA,
    markupBps: raw.markupBps === null || raw.markupBps === undefined ? null : (raw.markupBps as number),
    freight: isObj(f) ? { factorMicro: f.factorMicro as number, addOnCents: (f.addOnCents ?? 0) as number, source: typeof f.source === "string" ? f.source.trim() : "" } : f === null || f === undefined ? null : ({ factorMicro: NaN, addOnCents: NaN, source: "" }),
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
  code: "freight_not_set" | "fx_none_set" | "fx_stale" | "fx_missing_currency" | "markup_default";
  /** "blocking" = prices that need it are withheld; "notice" = a default is in use and is not an approved policy. */
  severity: "blocking" | "notice";
  text: string;
}

/** Everything a Manager still has to resolve before automatic prices can be produced. NEVER fills a gap with a number. `currencies` = foreign currencies known to be needed (optional). */
export function unresolvedItems(s: CommercialSettings | null, nowIso: string, currencies: readonly string[] = []): UnresolvedItem[] {
  const x = s ?? emptyCommercialSettings();
  const out: UnresolvedItem[] = [];
  if (x.freight === null) out.push({ code: "freight_not_set", severity: "blocking", text: "Freight policy not set. No automatic price can be produced until a Manager enters it." });
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
export const canPriceAnything = (s: CommercialSettings | null): boolean => !!s && s.freight !== null;
