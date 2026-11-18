import { describe, expect, it } from "vitest";
import { activationStatus } from "../activation-status";
import { emptyCommercialSettings, type CommercialSettings } from "../commercial-settings";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const base = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({
  ...emptyCommercialSettings(), markupBps: 2500,
  freight: { factorMicro: 1_150_000, addOnCents: 0, source: "Freight policy 2026" },
  fx: { EUR: { rateMicro: 20_000_000, source: "Bank fixing", asOf: "2026-11-17T08:00:00Z" } },
  fxMaxAgeDays: 30, ...over,
});

describe("automatic pricing activation status (server-derived)", () => {
  it("DISABLED when the switch is off, whatever else is configured (and the effective time is not reported as live)", () => {
    const a = activationStatus({ flagOn: false, cutoffMs: Date.parse("2026-11-01T00:00:00Z") }, base(), NOW);
    expect(a).toMatchObject({ state: "disabled", label: "Disabled", effectiveFrom: null });
    expect(a.summary).toMatch(/switched off/);
  });
  it("ENABLED only with the switch on, a valid effective time and ready settings; it says from when and that older quotations are never repriced", () => {
    const a = activationStatus({ flagOn: true, cutoffMs: Date.parse("2026-11-17T07:07:35Z") }, base(), NOW);
    expect(a).toMatchObject({ state: "enabled", label: "Enabled", effectiveFrom: "2026-11-17T07:07:35.000Z", issues: [] });
    expect(a.summary).toMatch(/never repriced/);
  });
  it("CONFIGURATION INCOMPLETE: switch on without a valid effective time; switch on with no freight; switch on with no exchange rate", () => {
    expect(activationStatus({ flagOn: true, cutoffMs: null }, base(), NOW)).toMatchObject({ state: "incomplete", effectiveFrom: null });
    expect(activationStatus({ flagOn: true, cutoffMs: 1 }, base({ freight: null }), NOW).state).toBe("incomplete");
    expect(activationStatus({ flagOn: true, cutoffMs: 1 }, base({ fx: {} }), NOW).issues.join(" ")).toMatch(/No exchange rate/);
    expect(activationStatus({ flagOn: true, cutoffMs: 1 }, null, NOW).state).toBe("incomplete");
  });
  it("distinguishes TEST-ONLY settings from entered settings, and never calls entered settings 'approved'", () => {
    const t = activationStatus({ flagOn: false, cutoffMs: null }, base({ freight: { factorMicro: 1_150_000, addOnCents: 0, source: "TEST-ONLY freight assumption" } }), NOW);
    expect(t.testOnly).toBe(true); expect(t.policyNote).toMatch(/not approved commercial policy/);
    const r = activationStatus({ flagOn: false, cutoffMs: null }, base(), NOW);
    expect(r.testOnly).toBe(false); expect(r.policyNote).toMatch(/does not record whether/);
    expect(JSON.stringify(r)).not.toMatch(/approved\b(?! commercial policy)/);
  });
  it("shows whether each exchange rate is current or expired, with its age in days, and warns about expired ones", () => {
    const a = activationStatus({ flagOn: false, cutoffMs: null }, base({ fxMaxAgeDays: 1, fx: { EUR: { rateMicro: 1, source: "x", asOf: "2026-11-17T08:00:00Z" }, USD: { rateMicro: 1, source: "x", asOf: "2026-11-14T08:00:00Z" } } }), NOW);
    expect(a.fx).toEqual([{ currency: "EUR", status: "current", ageDays: 0 }, { currency: "USD", status: "expired", ageDays: 3 }]);
    expect(a.issues.join(" ")).toMatch(/Expired exchange rate: USD/);
  });
  it("never carries an environment-variable name or a secret", () => {
    const s = JSON.stringify([activationStatus({ flagOn: true, cutoffMs: null }, base(), NOW), activationStatus({ flagOn: false, cutoffMs: null }, null, NOW)]);
    expect(s).not.toMatch(/NEWQUIP_|process\.env|SUPABASE|ENCRYPTION/);
  });
});
