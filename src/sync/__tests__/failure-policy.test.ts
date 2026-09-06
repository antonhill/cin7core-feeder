import { describe, expect, it } from "vitest";
import { Cin7ApiError } from "@/cin7/http";
import {
  classifyPushError,
  shouldSuppressRetry,
  failureStateUpdate,
  backoffMinutesFor,
  isSuppressibleFailureClass,
  CLEARED_FAILURE_STATE,
  MAX_RETRY_BACKOFF_MINUTES,
  type SyncFailureState,
} from "@/sync/failure-policy";

const NOW = new Date("2026-09-06T18:00:00.000Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

function failedState(over: Partial<SyncFailureState> = {}): SyncFailureState {
  return {
    last_status: "failed",
    failure_class: "reference_validation",
    failure_fingerprint: "hash-a",
    next_retry_at: inMinutes(15),
    ...over,
  };
}

describe("classifyPushError", () => {
  it("classifies a retryable Cin7 error as transient", () => {
    expect(classifyPushError(new Cin7ApiError(429, "rate limit", true))).toBe("transient");
    expect(classifyPushError(new Cin7ApiError(502, "bad gateway", true))).toBe("transient");
  });

  it("classifies a non-retryable Cin7 rejection as rejected", () => {
    expect(classifyPushError(new Cin7ApiError(400, "Specified attribute 'SKU' already exists.", false))).toBe("rejected");
  });

  it("classifies an ambiguous non-idempotent write as ambiguous, even though it is also non-retryable", () => {
    // Ambiguity is the stronger statement: the write may have committed.
    expect(classifyPushError(new Cin7ApiError(0, "connection reset", false, true))).toBe("ambiguous");
  });

  it("classifies anything it does not recognise as unknown, never as deterministic", () => {
    expect(classifyPushError(new Error("database exploded"))).toBe("unknown");
    expect(classifyPushError("a string")).toBe("unknown");
    expect(classifyPushError(undefined)).toBe("unknown");
  });
});

describe("suppressible classes", () => {
  it("suppresses only the two deterministic classes", () => {
    expect(isSuppressibleFailureClass("reference_validation")).toBe(true);
    expect(isSuppressibleFailureClass("rejected")).toBe(true);

    expect(isSuppressibleFailureClass("transient")).toBe(false);
    expect(isSuppressibleFailureClass("ambiguous")).toBe(false);
    expect(isSuppressibleFailureClass("unknown")).toBe(false);
    expect(isSuppressibleFailureClass(null)).toBe(false);
  });
});

describe("shouldSuppressRetry", () => {
  it("suppresses an unchanged deterministic failure inside its backoff", () => {
    expect(shouldSuppressRetry(failedState(), "hash-a", NOW)).toBe(true);
  });

  it("does NOT suppress once the backoff has elapsed — the bound on staying quiet", () => {
    expect(shouldSuppressRetry(failedState({ next_retry_at: inMinutes(-1) }), "hash-a", NOW)).toBe(false);
  });

  it("does NOT suppress when the product's content changed — an edit earns an immediate attempt", () => {
    // This is the recovery path a user gets without knowing the mechanism exists.
    expect(shouldSuppressRetry(failedState(), "hash-b", NOW)).toBe(false);
  });

  it("never suppresses a transient failure, however many times it recurs", () => {
    expect(shouldSuppressRetry(failedState({ failure_class: "transient" }), "hash-a", NOW)).toBe(false);
  });

  it("never suppresses an ambiguous write — reconciliation stays authoritative", () => {
    expect(shouldSuppressRetry(failedState({ failure_class: "ambiguous" }), "hash-a", NOW)).toBe(false);
  });

  it("never suppresses an unclassified failure", () => {
    expect(shouldSuppressRetry(failedState({ failure_class: "unknown" }), "hash-a", NOW)).toBe(false);
    expect(shouldSuppressRetry(failedState({ failure_class: null }), "hash-a", NOW)).toBe(false);
  });

  it("does not suppress a row whose last outcome was a success", () => {
    expect(shouldSuppressRetry(failedState({ last_status: "updated" }), "hash-a", NOW)).toBe(false);
  });

  it("does not suppress a pre-existing failure that has no policy state yet", () => {
    // Every row that existed before the migration looks like this. They must
    // stay eligible and be classified by the first run that sees them.
    expect(
      shouldSuppressRetry({ last_status: "failed", failure_class: null, failure_fingerprint: null, next_retry_at: null }, "hash-a", NOW)
    ).toBe(false);
  });

  it("does not suppress when a fingerprint exists but no retry time does", () => {
    expect(shouldSuppressRetry(failedState({ next_retry_at: null }), "hash-a", NOW)).toBe(false);
  });
});

describe("backoff", () => {
  it("starts short and caps, so suppression is always bounded", () => {
    expect(backoffMinutesFor(1)).toBe(15);
    expect(backoffMinutesFor(2)).toBe(60);
    expect(backoffMinutesFor(3)).toBe(180);
    expect(backoffMinutesFor(4)).toBe(360);
    expect(backoffMinutesFor(50)).toBe(MAX_RETRY_BACKOFF_MINUTES);
    expect(MAX_RETRY_BACKOFF_MINUTES).toBe(360);
  });
});

describe("failureStateUpdate", () => {
  it("records a deterministic failure with a future retry time", () => {
    const u = failureStateUpdate("reference_validation", "hash-a", 0, NOW);
    expect(u.failure_class).toBe("reference_validation");
    expect(u.failure_fingerprint).toBe("hash-a");
    expect(u.consecutive_failures).toBe(1);
    expect(u.next_retry_at).toBe(inMinutes(15));
  });

  it("leaves a transient failure immediately eligible", () => {
    const u = failureStateUpdate("transient", "hash-a", 4, NOW);
    expect(u.next_retry_at).toBeNull();
    expect(u.consecutive_failures).toBe(5);
  });

  it("leaves an ambiguous failure immediately eligible", () => {
    expect(failureStateUpdate("ambiguous", "hash-a", 0, NOW).next_retry_at).toBeNull();
  });

  it("never returns a synced_hash — suppression must not assert a push that did not happen", () => {
    const u = failureStateUpdate("reference_validation", "hash-a", 0, NOW) as Record<string, unknown>;
    expect(Object.keys(u)).toEqual(["failure_class", "failure_fingerprint", "consecutive_failures", "next_retry_at"]);
    expect(u).not.toHaveProperty("synced_hash");
    expect(u).not.toHaveProperty("last_status");
  });
});

describe("CLEARED_FAILURE_STATE", () => {
  it("resets every policy field so a recovered product carries no residue", () => {
    expect(CLEARED_FAILURE_STATE).toEqual({
      failure_class: null,
      failure_fingerprint: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
  });
});
