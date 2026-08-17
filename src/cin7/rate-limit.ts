import "server-only";
import { createHash } from "node:crypto";
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

/**
 * Security re-audit P0-3: Cin7's 60/min limit is per API APPLICATION, not
 * per account — an account can have more than one Application (API key)
 * configured, each with its own independent budget. Keying the bucket by
 * accountId alone could wrongly share (or wrongly separate) budget across
 * applications. Fingerprinted as sha256(accountId:applicationKey) — a
 * stable, non-reversible identifier; the raw applicationKey itself must
 * never land in a table an ops tool might casually browse.
 */
function bucketKey(accountId: string, applicationKey: string): string {
  return createHash("sha256").update(`${accountId}:${applicationKey}`).digest("hex");
}

// A single sleep is capped so a clock oddity or huge computed wait can't strand
// a call. The attempt count alone doesn't bound total time, though: a
// misconfigured near-zero RATE_LIMIT_RPS (floored at 0.1/s by refillPerSec())
// can make MAX_SLEEP_MS the common case, not the rare one. MAX_TOTAL_WAIT_MS
// is a genuine wall-clock deadline (checked every attempt, not just an
// attempt counter) — whichever bound is hit first ends acquireCin7Slot's own
// internal loop. This is deliberately much smaller than it used to be:
// acquireCin7Slot no longer owns the "what happens if we still can't get a
// token" decision (see AcquireOutcome below) — cin7Request's own
// maxRetries/backoff loop does, so this only needs to cover a short internal
// wait before handing back control.
const MAX_SLEEP_MS = 15_000;
const MAX_ACQUIRE_ATTEMPTS = 10;
const MAX_TOTAL_WAIT_MS = 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Once we learn the acquire function isn't there (migration not applied
// yet), stop firing a doomed RPC on every Cin7 call for the rest of this
// process's life and fall straight through. Reset only by a fresh process
// (i.e. a deploy after the migration is applied).
let distributedLimiterUnavailable = false;

/**
 * Security re-audit P0-3: the old "exhausted the attempt budget -> proceed
 * anyway" behaviour let ANY call (including a real Cin7 WRITE) bypass the
 * distributed coordinator entirely under contention — exactly the failure
 * mode a shared rate limiter exists to prevent. This is now the caller's own
 * decision, made explicit by `opts.allowDegrade`:
 *
 *   "granted" — a token was acquired; proceed, and do NOT also wait on the
 *               in-memory throttle.
 *   "degrade" — the coordinator is unavailable OR still contended after
 *               acquireCin7Slot's own short internal budget, AND the caller
 *               opted into degrading (a read). Fall back to the in-memory
 *               per-invocation throttle and proceed.
 *   "blocked" — same as "degrade", but the caller did NOT opt into
 *               degrading (a write). The call must NOT proceed on this
 *               attempt — the coordinator is the only thing allowed to pace
 *               a write, so the caller must retry the WHOLE attempt (a
 *               fresh acquireCin7Slot call, not just a local sleep) through
 *               its own bounded retry loop, or fail outright once that's
 *               exhausted. See http.ts's handling of this outcome.
 */
export type AcquireOutcome = "granted" | "degrade" | "blocked";

function unavailableOutcome(allowDegrade: boolean): AcquireOutcome {
  return allowDegrade ? "degrade" : "blocked";
}

/**
 * Distributed token-bucket acquire, keyed by a fingerprint of
 * (accountId, applicationKey), coordinated in Postgres (migration 0075's
 * `cin7_rate_limit_acquire`) so concurrent serverless invocations share ONE
 * 60/min budget per Cin7 Application.
 */
export async function acquireCin7Slot(
  accountId: string,
  applicationKey: string,
  opts: { allowDegrade: boolean }
): Promise<AcquireOutcome> {
  if (distributedLimiterUnavailable) return unavailableOutcome(opts.allowDegrade);

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    console.error("cin7 rate-limit client creation failed:", err);
    return unavailableOutcome(opts.allowDegrade);
  }

  const key = bucketKey(accountId, applicationKey);
  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const { data, error } = await db.rpc("cin7_rate_limit_acquire", {
      p_bucket_key: key,
      p_capacity: capacity(),
      p_refill_per_sec: refillPerSec(),
    });

    if (error) {
      // 42883 = undefined_function → migration not applied yet. Disable the
      // distributed path process-wide rather than erroring on every call.
      if (error.code === "42883") distributedLimiterUnavailable = true;
      else console.error("cin7 rate-limit acquire failed:", error.message);
      return unavailableOutcome(opts.allowDegrade);
    }

    const waitMs = Number(data ?? 0);
    if (waitMs <= 0) return "granted";

    // Don't sleep past the deadline just because a single MAX_SLEEP_MS-capped
    // sleep would still fit — check the wall clock, not just the attempt
    // count.
    if (Date.now() + Math.min(waitMs, MAX_SLEEP_MS) >= deadline) break;

    // Jitter so waiters woken together don't all retry in lockstep.
    await sleep(Math.min(waitMs, MAX_SLEEP_MS) + Math.floor(Math.random() * 50));
  }

  return unavailableOutcome(opts.allowDegrade);
}

/**
 * Security re-audit P0-3: called after a real Cin7 503 (or the
 * /purchase-family's non-standard "reached 60 calls per 60 seconds"
 * 200-with-message variant — see http.ts) so every OTHER invocation sharing
 * this bucket backs off immediately too, instead of each independently
 * colliding with the same limit and discovering it on its own. Best-effort:
 * swallows its own errors (never throws, never blocks the caller's own
 * error handling for the 503 it just got).
 */
export async function reportCin7RateLimitCooldown(accountId: string, applicationKey: string, cooldownMs: number): Promise<void> {
  if (distributedLimiterUnavailable) return;

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch {
    return;
  }

  const key = bucketKey(accountId, applicationKey);
  const { error } = await db.rpc("cin7_rate_limit_report_cooldown", { p_bucket_key: key, p_cooldown_ms: cooldownMs });
  if (error && error.code !== "42883") {
    console.error("cin7 rate-limit cooldown report failed (non-fatal):", error.message);
  }
}

/** Test-only: clear the process-wide "limiter unavailable" latch. */
export function __resetDistributedLimiterForTests() {
  distributedLimiterUnavailable = false;
}
