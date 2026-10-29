import "server-only";
// Exchange-rate snapshots (migration 0113). An authorised user records ZAR per 1 unit of a foreign currency with its source and effective time; the newest
// effective snapshot per currency is "current". There is no hard-coded rate and no provider call here: until a provider is approved, rates are entered and
// audited. Before the migration is applied every read says "unavailable" and only ZAR supplier prices can be used.
import type { createServiceRoleClient } from "@/supabase/server";
import { BASE_CURRENCY, rateToMicro, type FxRate } from "./supplier-price";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(m: string): never { throw new Error(m); }
const missingTable = (m: string) => /does not exist|schema cache|relation/i.test(m);
const PENDING = "Exchange-rate snapshots are not available yet (database migration pending).";

export interface FxRow extends FxRate { id: string; enteredBy: string; createdAt: string }

/** The newest effective snapshot of each currency, or null when the table does not exist yet. */
export async function currentRates(db: Db, orgId: string): Promise<Record<string, FxRate> | null> {
  const r = await db.from("newquip_fx_rates").select("*").eq("org_id", orgId);
  if (r.error) { if (missingTable(r.error.message)) return null; fail(r.error.message); }
  const best: Record<string, { row: Record<string, unknown>; t: number; c: number }> = {};
  for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
    const cur = String(row.currency);
    const t = new Date(String(row.as_of)).getTime(); const c = new Date(String(row.created_at)).getTime();
    const b = best[cur];
    if (!b || t > b.t || (t === b.t && c > b.c)) best[cur] = { row, t, c };
  }
  const out: Record<string, FxRate> = {};
  for (const [cur, { row }] of Object.entries(best)) out[cur] = { currency: cur, rate: String(row.rate).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1"), source: String(row.source), asOf: new Date(String(row.as_of)).toISOString() };
  return out;
}

export async function rateHistory(db: Db, orgId: string, limit = 50): Promise<FxRow[]> {
  const r = await db.from("newquip_fx_rates").select("*").eq("org_id", orgId);
  if (r.error) { if (missingTable(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as Array<Record<string, unknown>>)
    .map((x) => ({ id: String(x.id), currency: String(x.currency), rate: String(x.rate), source: String(x.source), asOf: new Date(String(x.as_of)).toISOString(), enteredBy: String(x.entered_by_email), createdAt: String(x.created_at) }))
    .sort((a, b) => b.asOf.localeCompare(a.asOf) || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Validates and records one snapshot. Cost-viewers only (the caller passes the verdict); ZAR is always 1 and cannot be recorded. */
export async function recordRate(db: Db, gates: { canSeeCost: boolean }, email: string, input: { orgId: string; currency: string; rate: string; source: string; asOf: string }, nowIso = new Date().toISOString()): Promise<void> {
  if (!gates.canSeeCost) fail("Only someone who can see costs can record an exchange rate.");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail("The currency must be a three-letter ISO 4217 code, for example USD.");
  if (currency === BASE_CURRENCY) fail("ZAR is the base currency: its rate is always 1 and cannot be recorded.");
  if (rateToMicro(input.rate) === null) fail("The rate must be a positive number of rand per 1 unit of the currency, with at most 6 decimals (for example 17.5).");
  if (input.source.trim().length < 3) fail("Say where the rate comes from (provider, fixing or quote).");
  const t = new Date(input.asOf).getTime();
  if (!Number.isFinite(t)) fail("The effective date and time of the rate is not valid.");
  if (t > new Date(nowIso).getTime() + 5 * 60_000) fail("A rate cannot be effective in the future.");
  const ins = await db.from("newquip_fx_rates").insert({ org_id: input.orgId, currency, rate: input.rate.trim(), source: input.source.trim(), as_of: new Date(t).toISOString(), entered_by_email: email });
  if (ins.error) fail(missingTable(ins.error.message) ? PENDING : `record rate: ${ins.error.message}`);
}
