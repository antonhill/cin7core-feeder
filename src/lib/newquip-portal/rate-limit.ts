// A small, bounded, in-memory limiter for the PUBLIC response endpoints. Per-instance only (a serverless fleet shares nothing), so it is a speed bump against a single
// client hammering one instance - NOT the security boundary. The boundaries are the 256-bit token, the per-link attempt counter stored in the database, the one-response-per-link
// unique index, and (owner-controlled) platform firewall rules.
const buckets = new Map<string, number[]>();
const MAX_KEYS = 5000;

/** Returns true when the call is allowed. `limit` calls per `windowMs` per key. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const cut = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cut);
  if (hits.length >= limit) { buckets.set(key, hits); return false; }
  hits.push(now); buckets.set(key, hits);
  if (buckets.size > MAX_KEYS) { // evict the oldest keys; the map can never grow without bound
    for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size <= MAX_KEYS * 0.8) break; }
  }
  return true;
}
export const resetRateLimits = (): void => buckets.clear();
