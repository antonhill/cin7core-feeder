import "server-only";
// THE OPEN EXCHANGE RATES FEED for the Manager's commercial settings. It only ever writes a NEW settings version (append-only) and only exchange rates: USD and EUR (ZAR per 1 unit).
//  - source, the provider's own timestamp (asOf) and OUR retrieval time are recorded on every rate it writes (origin "oxr");
//  - a rate a Manager entered by hand (origin "manual", or an older version with no origin) is an OVERRIDE: it is kept unless the caller explicitly asks to replace it;
//  - a provider problem (unreachable, refused, stale, implausible) is returned as the reason and NOTHING is written: there is no fallback source and an expired rate is never quietly kept as current;
//  - forward-cover contracts live on each quotation and are never touched here.
// The credential is read from the environment, never logged, returned or stored.
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchOxrRates, OxrError, type OxrRates } from "@/newquip/pricing/fx/open-exchange-rates";
import { decimalToMicro } from "@/newquip/pricing/commercial-form";
import { emptyCommercialSettings, fxFresh, type CommercialSettings, type FxSetting } from "@/newquip/pricing/commercial-settings";
import { latestCommercialSettings, saveCommercialSettings } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;
export const FEED_CURRENCIES = ["EUR", "USD"] as const;
export const FEED_ACTOR = "Open Exchange Rates feed";

export interface FeedOutcome {
  ok: boolean;
  /** Why nothing was written (provider or configuration problem), in plain words. */
  error?: string;
  /** Currencies written from the feed / kept because a Manager's override stands / already current (nothing to do). */
  updated: string[]; keptManual: string[]; unchanged: string[];
  revision?: number;
  providerTimestamp?: string; retrievedAt?: string;
}
const fail = (error: string): FeedOutcome => ({ ok: false, error, updated: [], keptManual: [], unchanged: [] });

export const feedConfigured = (env: Record<string, string | undefined> = process.env): boolean => !!env.OPENEXCHANGERATES_APP_ID?.trim();

/** A feed reading as the settings' rate entries. The EUR rate is DERIVED from the provider's USD base (stated in its source). */
export function feedEntries(r: OxrRates): Record<"USD" | "EUR", FxSetting> {
  const usd = decimalToMicro(r.usdZar), eur = decimalToMicro(r.eurZar);
  if (usd === null || eur === null) throw new OxrError("The provider's rate cannot be held exactly");
  const base = { asOf: r.providerTimestamp, retrievedAt: r.retrievedAt, origin: "oxr" as const };
  return {
    USD: { rateMicro: usd, source: r.source, ...base },
    EUR: { rateMicro: eur, source: `${r.source}; EUR/ZAR derived from the USD base`, ...base },
  };
}

/**
 * Fetches fresh rates and saves them as a NEW settings version (FX only). `replaceManual` also replaces a Manager's own USD/EUR override. `onlyIfStale` = automatic use: do nothing unless a feed-owned (or missing) rate is stale;
 * it never replaces a manual override.
 */
export async function refreshFxFromFeed(db: Db, orgId: string, by: string, opts: { replaceManual?: boolean; onlyIfStale?: boolean; env?: Record<string, string | undefined>; fetchFn?: typeof fetch; nowIso?: string } = {}): Promise<FeedOutcome> {
  const env = opts.env ?? process.env;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const current = await latestCommercialSettings(db, orgId, nowIso);
  const base: CommercialSettings = current?.settings ?? emptyCommercialSettings();
  const stale = (c: string) => !fxFresh(base.fx[c], base.fxMaxAgeDays, Date.parse(nowIso));
  if (opts.onlyIfStale && !FEED_CURRENCIES.some((c) => (!base.fx[c] || base.fx[c].origin === "oxr") && stale(c))) return { ok: true, updated: [], keptManual: [], unchanged: [...FEED_CURRENCIES] };
  const appId = env.OPENEXCHANGERATES_APP_ID ?? "";
  if (!appId.trim()) return fail("The Open Exchange Rates feed is not configured for this deployment.");
  let rates: OxrRates;
  try { rates = await fetchOxrRates(appId, { ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}), now: () => new Date(nowIso) }); } catch (e) { return fail(e instanceof OxrError ? e.message : "The exchange-rate feed failed."); }
  let entries: Record<"USD" | "EUR", FxSetting>;
  try { entries = feedEntries(rates); } catch (e) { return fail(e instanceof OxrError ? e.message : "The exchange-rate feed returned an unusable value."); }
  const fx: Record<string, FxSetting> = { ...base.fx };
  const updated: string[] = [], keptManual: string[] = [], unchanged: string[] = [];
  for (const c of FEED_CURRENCIES) {
    const have = base.fx[c];
    const manual = !!have && have.origin !== "oxr";
    if (manual && !opts.replaceManual) { keptManual.push(c); continue; }
    if (opts.onlyIfStale && have && !stale(c)) { unchanged.push(c); continue; }
    if (have && have.origin === "oxr" && have.asOf === entries[c].asOf && have.rateMicro === entries[c].rateMicro) { unchanged.push(c); continue; }
    fx[c] = entries[c]; updated.push(c);
  }
  if (updated.length === 0) return { ok: true, updated, keptManual, unchanged, providerTimestamp: rates.providerTimestamp, retrievedAt: rates.retrievedAt };
  const saved = await saveCommercialSettings(db, orgId, { ...base, fx }, by, nowIso);
  return { ok: true, updated, keptManual, unchanged, revision: saved.revision, providerTimestamp: rates.providerTimestamp, retrievedAt: rates.retrievedAt };
}
