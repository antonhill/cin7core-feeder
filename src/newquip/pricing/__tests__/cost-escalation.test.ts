import { describe, expect, it } from "vitest";
import { escalateCostE7, escalationFor } from "../cost-escalation";
import { OWNER_APPROVED_BANDS } from "../commercial-settings";

const TODAY = "2026-11-16T09:00:00Z";
const ago = (days: number): string => new Date(Date.parse("2026-11-16T00:00:00Z") - days * 86_400_000).toISOString().slice(0, 10);
const esc = (d: string | null) => escalationFor(d, TODAY, OWNER_APPROVED_BANDS, 5);

describe("exact integer cost-age escalation (owner-approved marginal simple bands, 365.25-day year, 5-year maximum)", () => {
  it("is 0 for anything up to a year: 365 days is inside the 365.25-day first band", () => {
    expect(esc(ago(0))).toMatchObject({ status: "ok", escalationBps: 0, factorBps: 10_000 });
    expect(esc(ago(365))).toMatchObject({ status: "ok", escalationBps: 0 });
  });
  it("is continuous across the 1-year boundary (no cliff): 366 days = 75/100 of a day into the 10% band", () => {
    expect(esc(ago(366))).toMatchObject({ escalationBps: 2 }); // 1000 x 75 / 36525 = 2.05 -> 2
  });
  it("2 years (730 days is 0.5 day short of 730.5): 999 bps; 731 days: 1002 bps", () => {
    expect(esc(ago(730))).toMatchObject({ escalationBps: 999 }); // 1000 x 36475 / 36525 = 998.63 -> 999
    expect(esc(ago(731))).toMatchObject({ escalationBps: 1002 }); // 1000 + 1500 x 50 / 36525 (2.05) = 1002
  });
  it("3 years (1096 days = 25 hundredths of a day past 1095.75): 2501 bps", () => {
    expect(esc(ago(1096))).toMatchObject({ escalationBps: 2501 });
  });
  it("the last allowed day (1826 of 1826.25) is 6499 bps and one more day is over the maximum: NO factor", () => {
    expect(esc(ago(1826))).toMatchObject({ status: "ok", escalationBps: 6499, factorBps: 16_499 });
    expect(esc(ago(1827))).toEqual({ status: "older_than_maximum", ageDays: 1827 });
  });
  it("future-dated and undated or malformed dates get no factor", () => {
    expect(esc("2026-11-17")).toEqual({ status: "future_dated", ageDays: null });
    expect(esc(null)).toEqual({ status: "undated", ageDays: null });
    expect(esc("")).toEqual({ status: "undated", ageDays: null });
    expect(esc("2026-02-30")).toEqual({ status: "undated", ageDays: null });
  });
  it("reports which bands were applied (provenance)", () => {
    const r = esc(ago(800));
    expect(r.status).toBe("ok");
    if (r.status === "ok") { expect(r.bands.map((b) => b.rateBps)).toEqual([0, 1000, 1500]); expect(r.ageDays).toBe(800); }
  });
  it("uses the Manager's configured bands and maximum, not constants", () => {
    const flat = [{ fromYears: 0, toYears: null, rateBps: 1000 }];
    const r = escalationFor(ago(731), TODAY, flat, 2);
    expect(r).toEqual({ status: "older_than_maximum", ageDays: 731 });
    expect(escalationFor(ago(730), TODAY, flat, 2)).toMatchObject({ status: "ok", escalationBps: 1999 }); // 1000 x 73000 / 36525 = 1998.6
  });
  it("escalating a cost is exact half-up integer arithmetic on E7 units", () => {
    expect(escalateCostE7(100_000_000, 12_500)).toBe(125_000_000); // 10 x 1.25
    expect(escalateCostE7(1, 15_000)).toBe(2); // 1.5 -> half up
    expect(escalateCostE7(65_454_755, 10_000)).toBe(65_454_755);
  });
});

describe("worked example for the acceptance report", () => {
  it("a cost last supplied 2023-05-17, priced on 2026-11-17, with the owner-approved bands (0/10/15/20% by year, simple)", async () => {
    const { escalationFor } = await import("../cost-escalation");
    const bands = [{ fromYears: 0, toYears: 1, rateBps: 0 }, { fromYears: 1, toYears: 2, rateBps: 1000 }, { fromYears: 2, toYears: 3, rateBps: 1500 }, { fromYears: 3, toYears: null, rateBps: 2000 }];
    const r = escalationFor("2023-05-17", "2026-11-17", bands, 5);
    expect(r).toMatchObject({ status: "ok", ageDays: 1280 });
    expect(r.status === "ok" && r.escalationBps).toBe(3509); // 1y x 10% + 1y x 15% + 0.5045y x 20% = 35.09%
  });
});
