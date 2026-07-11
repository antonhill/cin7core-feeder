const ZAR_BASE_PRICE = 799;

export type ForeignCurrency = "USD" | "EUR" | "GBP";

/** Shown if the live rate fetch fails for any reason — each is the rate this was priced at when first set (2026-07), so it's a sane number even stale. */
const FALLBACK_ESTIMATES: Record<ForeignCurrency, number> = {
  USD: 49,
  EUR: 43,
  GBP: 36,
};

export type PriceEstimates = Record<ForeignCurrency, number>;

/** Pure — no I/O, easy to unit test independently of the network call. zarPerUnit is how many rand one unit of the foreign currency buys. */
export function estimateFromRate(zarPerUnit: number): number {
  return Math.round(ZAR_BASE_PRICE / zarPerUnit);
}

/**
 * Rounded USD/EUR/GBP equivalents of the real ZAR 799/month price, from a
 * free, keyless FX API — Lemon Squeezy's checkout auto-localizes the real
 * ZAR price to whatever currency a customer's browser suggests anyway (see
 * buildCheckoutUrl in src/lib/lemonsqueezy.ts), so these are always
 * estimates for the marketing page, never the literal amount charged.
 * Cached a day at a time (Next's fetch data cache) since pricing copy
 * doesn't need to track FX moves any faster than that, and falls back to
 * fixed estimates rather than ever failing the page render if the free API
 * is slow, down, or returns something unexpected.
 *
 * The API's rates are all "units of X per 1 USD" (base=USD), so EUR/GBP's
 * ZAR rate is derived by dividing — e.g. rates.ZAR / rates.EUR is
 * (ZAR/USD)/(EUR/USD) = ZAR/EUR — rather than a second request per currency.
 */
export async function getPriceEstimates(): Promise<PriceEstimates> {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 60 * 60 * 24 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ...FALLBACK_ESTIMATES };
    const body = (await response.json()) as { rates?: Record<string, number> };
    const rates = body.rates;
    const zarPerUsd = rates?.ZAR;
    if (!zarPerUsd || zarPerUsd <= 0) return { ...FALLBACK_ESTIMATES };

    const eurPerUsd = rates?.EUR;
    const gbpPerUsd = rates?.GBP;
    return {
      USD: estimateFromRate(zarPerUsd),
      EUR: eurPerUsd && eurPerUsd > 0 ? estimateFromRate(zarPerUsd / eurPerUsd) : FALLBACK_ESTIMATES.EUR,
      GBP: gbpPerUsd && gbpPerUsd > 0 ? estimateFromRate(zarPerUsd / gbpPerUsd) : FALLBACK_ESTIMATES.GBP,
    };
  } catch {
    return { ...FALLBACK_ESTIMATES };
  }
}
