// NQ-008B FX PREFLIGHT (acceptance test only): a read-only lookup of the owner-approved reference provider, Open Exchange Rates.
// It never writes, never touches a quotation, and never falls back to another source: any provider problem is a refusal.
// The app id travels in the Authorization header (never the URL) and is never part of a result or an error message.

export const OXR_URL = "https://openexchangerates.org/api/latest.json?base=USD&symbols=EUR,ZAR";
export const OXR_SOURCE = "Open Exchange Rates (latest.json, USD base)";
const MAX_AGE_SECONDS = 2 * 60 * 60; // the free plan refreshes hourly; older than two hours is refused rather than used
const MAX_FUTURE_SECONDS = 5 * 60;
const BOUNDS = { ZAR: [5, 50], EUR: [0.5, 1.5] } as const; // sanity only: a value outside these is a provider/units fault, not a rate

export type OxrRates = {
  source: string;
  base: "USD";
  providerTimestamp: string; // ISO, from the provider's own `timestamp`
  retrievedAt: string; // ISO, our clock
  usdZar: string; // ZAR per 1 USD, exactly as the provider reports it
  eurZar: string; // DERIVED: ZAR per USD divided by EUR per USD, rounded half-up to 6 decimals
  inputs: { zarPerUsd: string; eurPerUsd: string };
};

export class OxrError extends Error {}

const B1 = BigInt(1);
const B2 = BigInt(2);
const B10 = BigInt(10);
const B1M = BigInt(1_000_000);
const SCALE = 12;
const toScaled = (n: number): bigint => {
  const s = String(n);
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new OxrError(`rate has an unsupported format: ${s}`);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * B10 ** BigInt(SCALE) + BigInt(f.padEnd(SCALE, "0"));
};
const fmt = (v: bigint, decimals: number): string => {
  const unit = B10 ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
};

export function deriveEurZar(zarPerUsd: number, eurPerUsd: number): string {
  const zar = toScaled(zarPerUsd);
  const eur = toScaled(eurPerUsd);
  // (zar / eur) in micro units, half-up, exact integer arithmetic
  const num = zar * B1M * B2;
  const q = num / eur;
  return fmt((q + B1) / B2, 6);
}

export async function fetchOxrRates(appId: string, opts: { fetchFn?: typeof fetch; now?: () => Date } = {}): Promise<OxrRates> {
  if (!appId || !appId.trim()) throw new OxrError("OPENEXCHANGERATES_APP_ID is not configured");
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date());
  let res: Response;
  try {
    res = await fetchFn(OXR_URL, { method: "GET", headers: { Authorization: `Token ${appId.trim()}`, Accept: "application/json" }, cache: "no-store" });
  } catch {
    throw new OxrError("Open Exchange Rates could not be reached");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OxrError(`Open Exchange Rates returned a non-JSON response (HTTP ${res.status})`);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!res.ok || b.error === true) throw new OxrError(`Open Exchange Rates refused the request: HTTP ${res.status} ${typeof b.message === "string" ? b.message : ""}`.trim());
  if (b.base !== "USD") throw new OxrError("Open Exchange Rates did not return a USD base");
  const ts = b.timestamp;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) throw new OxrError("Open Exchange Rates returned no valid timestamp");
  const retrieved = now();
  const ageSeconds = Math.floor(retrieved.getTime() / 1000) - ts;
  if (ageSeconds > MAX_AGE_SECONDS) throw new OxrError(`Open Exchange Rates data is stale (${Math.round(ageSeconds / 60)} minutes old)`);
  if (ageSeconds < -MAX_FUTURE_SECONDS) throw new OxrError("Open Exchange Rates timestamp is in the future");
  const rates = (b.rates ?? {}) as Record<string, unknown>;
  const pick = (cur: "ZAR" | "EUR"): number => {
    const v = rates[cur];
    const [lo, hi] = BOUNDS[cur];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new OxrError(`${cur} rate is missing or implausible`);
    return v;
  };
  const zar = pick("ZAR");
  const eur = pick("EUR");
  return {
    source: OXR_SOURCE,
    base: "USD",
    providerTimestamp: new Date(ts * 1000).toISOString(),
    retrievedAt: retrieved.toISOString(),
    usdZar: String(zar),
    eurZar: deriveEurZar(zar, eur),
    inputs: { zarPerUsd: String(zar), eurPerUsd: String(eur) },
  };
}
