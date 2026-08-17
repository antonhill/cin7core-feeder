import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

export interface Cin7TestResult {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * Minimal read-only connectivity check: lists 1 product. Confirms the
 * account ID / application key headers authenticate against a live Cin7 Core
 * instance — see docs/cin7-api-findings.md for the verified auth scheme and
 * rate-limit behaviour (60/min, 503 on exceed).
 *
 * Security re-audit P0-1: routed through the shared cin7Request gateway
 * (canonical origin, rate-limited, redirect-safe) instead of a standalone
 * raw fetch() — this used to be a second, independent place capable of
 * transmitting Cin7 credentials. `maxRetries: 0` keeps this a single fast
 * attempt, matching the old behaviour of answering immediately rather than
 * making a "Test connection" click sit through several minutes of backoff.
 */
export async function testConnection(creds: Cin7Credentials): Promise<Cin7TestResult> {
  try {
    await cin7Request(creds, "/Product", { query: { page: 1, limit: 1 }, maxRetries: 0 });
    return { ok: true, status: 200, message: "Connected successfully." };
  } catch (e) {
    if (e instanceof Cin7ApiError) {
      if (e.status === 503) return { ok: false, status: 503, message: "Rate limited (60 calls/min) — try again shortly." };
      if (e.status === 403) return { ok: false, status: 403, message: "Authentication failed — check the account ID and application key." };
      if (e.status === 0) return { ok: false, status: 0, message: `Network error: ${e.message}` };
      return { ok: false, status: e.status, message: `Unexpected response: ${e.message.slice(0, 200)}` };
    }
    return { ok: false, status: 0, message: `Network error: ${e instanceof Error ? e.message : "unknown"}` };
  }
}
