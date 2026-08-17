import { timingSafeEqual } from "node:crypto";

/**
 * Guard for internal API routes with no browser session (Vercel Cron GET
 * triggers, plus the on-demand POST variants alongside them) — requires
 * `Authorization: Bearer <CRON_SECRET>`. Vercel automatically injects this
 * exact header when it invokes a scheduled route, so every route this
 * guards must be one Vercel Cron itself calls (see vercel.json's `crons`).
 *
 * Security re-audit P1-6: this used to check `SYNC_SHARED_SECRET`, a second
 * env var operators were instructed to set to "the SAME VALUE as
 * CRON_SECRET" (see git history) — i.e. one credential doing duty as two
 * differently-named ones, and also gating /api/import (removed — see below).
 * Now there is exactly one internal secret, used for exactly one purpose.
 */
export function assertInternalAuth(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new Error("CRON_SECRET is not configured");
  const header = req.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");

  // Security re-audit P1-6: constant-time comparison — a plain `!==` leaks
  // timing information proportional to the matching prefix length. Lengths
  // must match before timingSafeEqual is called (it throws on a length
  // mismatch rather than returning false), so compare that first; a length
  // mismatch is itself decisive (never a valid secret) and safe to
  // short-circuit on, matching the timing-safe pattern already used for the
  // Lemon Squeezy webhook signature (src/lib/lemonsqueezy.ts).
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const matches = expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) {
    throw new UnauthorizedError();
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
