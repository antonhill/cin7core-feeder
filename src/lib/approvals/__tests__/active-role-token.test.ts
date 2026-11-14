import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { signActiveRole, verifyActiveRole } from "../active-role-token";
import { ACTIVE_ROLE_TTL_SECONDS } from "../active-role";

beforeEach(() => { process.env.ENCRYPTION_KEY = "test-key-test-key-test-key-test-key"; });
const T0 = 1_800_000_000_000;

describe("signed active-role record", () => {
  it("round-trips for the user and organisation it was issued to", () => {
    const c = verifyActiveRole(signActiveRole({ user: "u1", org: "o1", role: "MANAGER" }, T0), T0 + 1000);
    expect(c).toMatchObject({ user: "u1", org: "o1", role: "MANAGER" });
  });
  it("rejects tampering, a different key, expiry, a future issue time and garbage", () => {
    const t = signActiveRole({ user: "u1", org: "o1", role: "REP" }, T0);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), role: "MANAGER" })).toString("base64url");
    expect(verifyActiveRole(`${forged}.${sig}`, T0)).toBeNull();
    expect(verifyActiveRole(t, T0 + ACTIVE_ROLE_TTL_SECONDS * 1000 + 1000)).toBeNull();
    expect(verifyActiveRole(t, T0 - 3_600_000)).toBeNull();
    for (const g of ["", "x", "a.b.c", "....", "a".repeat(2000), undefined, null]) expect(verifyActiveRole(g as never, T0)).toBeNull();
    process.env.ENCRYPTION_KEY = "another-key-another-key-another-key";
    expect(verifyActiveRole(t, T0)).toBeNull();
  });
  it("cannot be issued or verified without a server secret", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => signActiveRole({ user: "u", org: "o", role: "REP" })).toThrow();
    expect(verifyActiveRole("a.b")).toBeNull();
  });
});
