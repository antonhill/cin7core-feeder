import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_IDENTITY_EMAILS, DEMO_OWNER_EMAIL, DEMO_SLOTS, demoActorName, demoGate, isDemoActorName, isDemoSlot } from "../config";

vi.mock("server-only", () => ({}));
import { signDemoClaims, verifyDemoToken } from "../token";

const NQ = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const ENV = { VERCEL_ENV: "preview", NEWQUIP_DEMO_MODE_ENABLED: "true", NEWQUIP_DEMO_OWNER_EMAIL: DEMO_OWNER_EMAIL };
const ok = { orgId: NQ, email: DEMO_OWNER_EMAIL };

describe("the Demo Mode gate (default OFF, Preview only, exact owner, NewQuip test organisation only)", () => {
  it("opens only when every condition holds", () => expect(demoGate(ENV, ok)).toEqual({ allowed: true }));
  it("refuses Production, local, unknown and 'development' environments", () => {
    for (const v of ["production", undefined, "development", "", "Preview", "preview "]) expect(demoGate({ ...ENV, VERCEL_ENV: v }, ok).allowed).toBe(false);
  });
  it("is OFF by default and for anything but the exact string 'true'", () => {
    expect(demoGate({ ...ENV, NEWQUIP_DEMO_MODE_ENABLED: undefined }, ok).allowed).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", " true"]) expect(demoGate({ ...ENV, NEWQUIP_DEMO_MODE_ENABLED: v }, ok).allowed).toBe(false);
  });
  it("needs the environment to name the exact owner account (a typo or another account cannot widen it) and the signed-in user to BE that account", () => {
    expect(demoGate({ ...ENV, NEWQUIP_DEMO_OWNER_EMAIL: undefined }, ok).allowed).toBe(false);
    expect(demoGate({ ...ENV, NEWQUIP_DEMO_OWNER_EMAIL: "manager@sparkconsulting.co.za" }, { orgId: NQ, email: "manager@sparkconsulting.co.za" }).allowed).toBe(false);
    for (const email of ["rep@sparkconsulting.co.za", "estimator@sparkconsulting.co.za", "manager@sparkconsulting.co.za", "someone@else.com", null, ""]) expect(demoGate(ENV, { orgId: NQ, email }).allowed).toBe(false);
    expect(demoGate(ENV, { orgId: NQ, email: "Testing@SparkConsulting.co.za" }).allowed).toBe(true); // case-insensitive, same account
  });
  it("is restricted to the NewQuip test organisation: any other organisation is refused", () => {
    for (const orgId of ["1a1a7fd8-0000-0000-0000-000000000000", "", "00000000-0000-0000-0000-000000000000"]) expect(demoGate(ENV, { orgId, email: DEMO_OWNER_EMAIL }).allowed).toBe(false);
  });
});

describe("only slot names exist; the accounts behind them are fixed", () => {
  it("accepts exactly rep, estimator, manager and owner", () => {
    expect([...DEMO_SLOTS]).toEqual(["rep", "estimator", "manager", "owner"]);
    for (const bad of ["admin", "testing@sparkconsulting.co.za", "00000000-0000-0000-0000-0000000000a1", "REP", "", null, undefined, 1]) expect(isDemoSlot(bad)).toBe(false);
  });
  it("maps the slots to the three allowlisted test accounts only", () => {
    expect(DEMO_IDENTITY_EMAILS).toEqual({ rep: "rep@sparkconsulting.co.za", estimator: "estimator@sparkconsulting.co.za", manager: "manager@sparkconsulting.co.za" });
  });
  it("the actor name carries an explicit DEMO / impersonated marker with both identities", () => {
    const n = demoActorName({ slot: "estimator", effectiveEmail: "estimator@sparkconsulting.co.za", ownerEmail: DEMO_OWNER_EMAIL });
    expect(n).toBe("DEMO · estimator@sparkconsulting.co.za (Estimator) · impersonated by testing@sparkconsulting.co.za");
    expect(isDemoActorName(n)).toBe(true);
    expect(isDemoActorName("estimator@sparkconsulting.co.za")).toBe(false);
  });
});

describe("the signed context cannot be forged, replayed for another user or extended", () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = "k".repeat(40); });
  const claims = { owner: "u-owner", org: NQ, slot: "rep" as const };
  it("round-trips a fresh token and carries a 30-minute expiry", () => {
    const { token, claims: c } = signDemoClaims(claims, 1_000_000_000_000);
    expect(verifyDemoToken(token, 1_000_000_000_000 + 60_000)).toMatchObject({ owner: "u-owner", org: NQ, slot: "rep" });
    expect(c.exp - c.iat).toBe(1800);
  });
  it("expires: exactly at the end and after", () => {
    const { token, claims: c } = signDemoClaims(claims, 1_000_000_000_000);
    expect(verifyDemoToken(token, (c.exp - 1) * 1000)).not.toBeNull();
    expect(verifyDemoToken(token, c.exp * 1000)).toBeNull();
    expect(verifyDemoToken(token, (c.exp + 3600) * 1000)).toBeNull();
  });
  it("rejects a tampered body (a different slot, owner or longer expiry), a tampered signature, garbage and a token signed with another key", () => {
    const { token } = signDemoClaims(claims);
    const [body, sig] = token.split(".");
    const forge = (patch: object) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), ...patch })).toString("base64url") + "." + sig;
    expect(verifyDemoToken(forge({ slot: "manager" }))).toBeNull();
    expect(verifyDemoToken(forge({ owner: "someone-else" }))).toBeNull();
    expect(verifyDemoToken(forge({ exp: 9_999_999_999 }))).toBeNull();
    expect(verifyDemoToken(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    for (const junk of ["", "x", "a.b.c", "....", "{}", "null"]) expect(verifyDemoToken(junk)).toBeNull();
    expect(verifyDemoToken(undefined)).toBeNull();
    process.env.ENCRYPTION_KEY = "z".repeat(40);
    expect(verifyDemoToken(token)).toBeNull();
  });
  it("refuses to sign or accept anything without the server secret", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => signDemoClaims(claims)).toThrow(/not configured/);
    expect(verifyDemoToken("a.b")).toBeNull();
  });
  it("never accepts the owner slot inside a token (the owner identity is the ABSENCE of a context)", () => {
    const body = Buffer.from(JSON.stringify({ v: 1, owner: "u", org: NQ, slot: "owner", iat: 1, exp: 9_999_999_999, n: "x" })).toString("base64url");
    expect(verifyDemoToken(`${body}.AAAA`)).toBeNull();
  });
});
