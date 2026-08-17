import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

function reqWithAuth(header: string | null) {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("https://example.test/api/sync", { headers });
}

const ORIGINAL_ENV = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = "correct-secret";
});

afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL_ENV;
});

describe("assertInternalAuth", () => {
  it("passes with the correct bearer token", () => {
    expect(() => assertInternalAuth(reqWithAuth("Bearer correct-secret"))).not.toThrow();
  });

  it("throws UnauthorizedError with a wrong token", () => {
    expect(() => assertInternalAuth(reqWithAuth("Bearer wrong-secret"))).toThrow(UnauthorizedError);
  });

  it("throws UnauthorizedError with no authorization header", () => {
    expect(() => assertInternalAuth(reqWithAuth(null))).toThrow(UnauthorizedError);
  });

  it("throws UnauthorizedError with an empty bearer token", () => {
    expect(() => assertInternalAuth(reqWithAuth("Bearer "))).toThrow(UnauthorizedError);
  });

  it("throws a configuration error (not UnauthorizedError) when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(() => assertInternalAuth(reqWithAuth("Bearer anything"))).toThrow("CRON_SECRET is not configured");
  });

  it("security re-audit P1-6: rejects a token that's a length-mismatched prefix of the real one, without throwing from timingSafeEqual itself", () => {
    // timingSafeEqual throws on unequal-length buffers rather than returning
    // false — this proves the length check that guards it is in place, not
    // just that mismatches are rejected.
    expect(() => assertInternalAuth(reqWithAuth("Bearer correct"))).toThrow(UnauthorizedError);
  });
});
