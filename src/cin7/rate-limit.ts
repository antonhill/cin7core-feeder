import "server-only";
import { createServiceRoleClient } from "@/supabase/server";

// Refill rate reuses RATE_LIMIT_RPS (the same knob the legacy in-memory
// throttle used) so behaviour/tuning is consistent; default 0.8/s ≈ 48/min,
// safely under Cin7's hard 60/min. CIN7_RATE_LIMIT_BURST is the bucket
// capacity — a small allowance for short bursts without letting sustained rate
// exceed the refill.
const DEFAULT_RPS = 0.8;
const DEFAULT_BURST = 5;

function refillPerSec(): number {
  return Math.max(Number(process.env.RATE_LIMIT_RPS ?? DEFAULT_RPS), 0.1);
}
function capacity(): number {
  return Math.max(Number(process.env.CIN7_RATE_LIMIT_BURST ?? DEFAULT_BURST), 1);
}

// A single sleep is capped so a clock oddity or huge computed wait can't strand
// a call. The attempt count alone doesn't bound total time, though: a
// misconfigured near-zero RATE_LIMIT_RPS (floored at 0.1/s by refillPerSec())
// can make MAX_SLEEP_MS the common case, not the rare one — 40 attempts at
// 30s each is 20 minutes, easily enough to consume an entire Vercel
// invocation's duration budget on ONE acquireCin7Slot call, on the very
// first Cin7 request of the run. Security re-audit P0-3: MAX_TOTAL_WAIT_MS
// is a genuine wall-clock deadline (checked every attempt, not just an
// attempt counter) — whichever bound is hit first ends the loop.
const MAX_SLEEP_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 40;
const MAX_TOTAL_WAIT_MS = 45_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Once we learn the acquire function isn't there (migration 0054 not applied
// yet), stop firing a doomed RPC on every Cin7 call for the rest of this
// process's life and fall straight through to the in-memory throttle. Reset
// only by a fresh process (i.e. a deploy after the migration is applied).
let distributedLimiterUnavailable = false;

/**
 * Distributed token-bucket acquire, keyed by Cin7 accountId, coordinated in
 * Postgres (migration 0054 `cin7_rate_limit_acquire`) so concurrent serverless
 * invocations share ONE 60/min budget. Resolves once a token is granted,
 * sleeping as the function instructs between attempts.
 *
 * Returns true if the distributed limiter paced this call (the caller should
 * then NOT also wait on the in-memory throttle); false if it's unavailable —
 * DB unreachable, or the migration hasn't been applied — so the caller falls
 * back to the in-memory throttle. Never throws: a limiter/DB outage must never
 * halt Cin7 traffic.
 */
export async function acquireCin7Slot(accountId: string): Promise<boolean> {
  if (distributedLimiterUnavailable) return false;

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    console.error("cin7 rate-limit client creation failed; using in-memory throttle:", err);
    return false;
  }

  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const { data, error } = await db.rpc("cin7_rate_limit_acquire", {
      p_account_id: accountId,
      p_capacity: capacity(),
      p_refill_per_sec: refillPerSec(),
    });

    if (error) {
      // 42883 = undefined_function → migration not applied yet. Disable the
      // distributed path process-wide rather than erroring on every call.
      if (error.code === "42883") distributedLimiterUnavailable = true;
      else console.error("cin7 rate-limit acquire failed; using in-memory throttle:", error.message);
      return false;
    }

    const waitMs = Number(data ?? 0);
    if (waitMs <= 0) return true; // token granted

    // Security re-audit P0-3: don't sleep past the deadline just because a
    // single MAX_SLEEP_MS-capped sleep would still fit — check the wall
    // clock, not just the attempt count, so a degraded refill rate can't
    // silently consume the whole budget one 30s sleep at a time.
    if (Date.now() + Math.min(waitMs, MAX_SLEEP_MS) >= deadline) break;

    // Jitter so waiters woken together don't all retry in lockstep.
    await sleep(Math.min(waitMs, MAX_SLEEP_MS) + Math.floor(Math.random() * 50));
  }

  // Exhausted the attempt budget OR the wall-clock deadline under heavy
  // contention. Proceed anyway (the 503 backoff in http.ts is the backstop)
  // — and report "handled" so we don't pile the in-memory throttle's wait on
  // top of everything we just waited.
  return true;
}

/** Test-only: clear the process-wide "limiter unavailable" latch. */
export function __resetDistributedLimiterForTests() {
  distributedLimiterUnavailable = false;
}
