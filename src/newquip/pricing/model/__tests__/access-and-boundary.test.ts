import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { baseScenario, FIXTURE_ACTOR, FIXTURE_PRICING_DATE, missingCostLine } from "../fixtures";
import { calculatePricing, canEnterPricingInputs, emptyInputRecord, FIXTURE_DRAFT_RULE_VERSION as RULES, micro, stampPricingInputs, viewPricing, type PricingInputRecord, type QuoteRoleSet, type Viewer } from "..";

const roles = (...r: Array<"rep" | "estimator" | "manager">): QuoteRoleSet => new Set(r);
const REP: Viewer = { roles: roles("rep"), canSeeCost: false };
const EST_NO_COST: Viewer = { roles: roles("rep", "estimator"), canSeeCost: false };
const EST: Viewer = { roles: roles("rep", "estimator"), canSeeCost: true };
const MGR: Viewer = { roles: roles("rep", "estimator", "manager"), canSeeCost: true };
const AT = FIXTURE_PRICING_DATE;
const NOW = "2026-11-12T09:00:00.000Z";

const rich = () => calculatePricing(baseScenario({
  lines: [...baseScenario().lines, missingCostLine()],
  forwardCover: { EUR: { rateMicro: micro("19.5"), coverDays: 90, reason: "Secret forward contract", by: "x@y", at: AT } },
  itemOverrides: { drinker: { price: { unitPriceCents: 125_000, reason: "Secret competitor match", by: "x@y", at: AT } } },
  projectMarkup: { markupBps: 2500, reason: "Secret terms", by: "x@y", at: AT },
  projectAdjustment: { kind: "amount", amountCents: -100_000, reason: "Secret discount reason", by: "x@y", at: AT },
}), RULES);

describe("9. no unauthorised pricing or cost visibility", () => {
  it("a viewer without cost visibility receives selling figures only: no cost, rate, supplier, freight, markup, margin, override reason or issue text", () => {
    const v = viewPricing(rich(), REP);
    expect(v.audience).toBe("customer_safe");
    const json = JSON.stringify(v);
    for (const leak of ["Secret", "Euro Supplier", "Fixture spot", "19500000", "20000000", "nativeUnitCost", "Landed", "landed", "costCents", "marginPct", "markup", "freight", "rate", "supplier", "SupplierBV", "forward", "reason", "by\":", "cost_missing", "issues", "x@y"]) {
      expect(json.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
    expect(Object.keys(v).sort()).toEqual(["adjustmentCents", "audience", "completeness", "lines", "totalExVatCents"]);
  });
  it("a viewer without cost visibility still sees the project adjustment as a selling line, and the true total", () => {
    const r = rich();
    const v = viewPricing(r, REP);
    expect(v.audience === "customer_safe" && v.adjustmentCents).toBe(-100_000);
    expect(v.audience === "customer_safe" && v.totalExVatCents).toBe(r.totalExVatCents);
  });
  it("an unpriced line is 'not_priced' with no figure, never 0, in the reduced view", () => {
    const v = viewPricing(rich(), REP);
    const ctl = v.audience === "customer_safe" ? v.lines.find((l) => l.key === "controller")! : null;
    expect(ctl).toMatchObject({ status: "not_priced", unitPriceCents: null, revenueCents: null });
  });
  it("a cost-entitled viewer gets the full result", () => expect(viewPricing(rich(), EST).audience).toBe("internal"));
  it("entering pricing inputs needs BOTH the Estimator/Manager role AND cost visibility", () => {
    expect(canEnterPricingInputs(REP)).toBe(false);
    expect(canEnterPricingInputs(EST_NO_COST)).toBe(false);
    expect(canEnterPricingInputs({ roles: roles("rep"), canSeeCost: true })).toBe(false);
    expect(canEnterPricingInputs(EST)).toBe(true);
    expect(canEnterPricingInputs(MGR)).toBe(true);
  });
});

describe("reasons and audit evidence for overrides (server-owned attribution)", () => {
  const submitted = (): PricingInputRecord => ({
    ...emptyInputRecord(),
    itemOverrides: { drinker: { price: { unitPriceCents: 125_000, reason: "  Match competitor  ", by: "attacker@evil", at: "1999-01-01T00:00:00.000Z" } } },
    forwardCover: { EUR: { rateMicro: micro("19.5"), coverDays: 90, reason: "FEC", by: "attacker@evil", at: "1999-01-01T00:00:00.000Z" } },
  });
  it("replaces whatever who/when the client sent with the actor and the time, and trims the reason", () => {
    const s = stampPricingInputs(submitted(), emptyInputRecord(), EST, FIXTURE_ACTOR, NOW);
    expect(s.itemOverrides.drinker!.price).toMatchObject({ reason: "Match competitor", by: FIXTURE_ACTOR, at: NOW });
    expect(s.forwardCover.EUR).toMatchObject({ by: FIXTURE_ACTOR, at: NOW });
  });
  it("an unchanged entry keeps its ORIGINAL attribution, even if a client tampers with it", () => {
    const first = stampPricingInputs(submitted(), emptyInputRecord(), EST, FIXTURE_ACTOR, NOW);
    const resubmit = structuredClone(first); resubmit.itemOverrides.drinker!.price!.by = "someone.else@x"; resubmit.itemOverrides.drinker!.price!.at = "2030-01-01T00:00:00.000Z";
    const again = stampPricingInputs(resubmit, first, MGR, "manager@example.test", "2026-11-13T09:00:00.000Z");
    expect(again.itemOverrides.drinker!.price).toMatchObject({ by: FIXTURE_ACTOR, at: NOW });
  });
  it("a changed value is re-stamped to the person who changed it", () => {
    const first = stampPricingInputs(submitted(), emptyInputRecord(), EST, FIXTURE_ACTOR, NOW);
    const edit = structuredClone(first); edit.itemOverrides.drinker!.price!.unitPriceCents = 120_000;
    const again = stampPricingInputs(edit, first, MGR, "manager@example.test", "2026-11-13T09:00:00.000Z");
    expect(again.itemOverrides.drinker!.price).toMatchObject({ unitPriceCents: 120_000, by: "manager@example.test", at: "2026-11-13T09:00:00.000Z" });
  });
  it("refuses a Rep, and an Estimator without cost visibility, entering, changing or REMOVING an input", () => {
    for (const v of [REP, EST_NO_COST]) {
      expect(() => stampPricingInputs(submitted(), emptyInputRecord(), v, "r@x", NOW)).toThrow(/Estimator or Manager who can see costs/);
    }
    const first = stampPricingInputs(submitted(), emptyInputRecord(), EST, FIXTURE_ACTOR, NOW);
    expect(() => stampPricingInputs(emptyInputRecord(), first, REP, "r@x", NOW)).toThrow(/Estimator or Manager/);
    expect(() => stampPricingInputs(first, first, REP, "r@x", NOW)).not.toThrow(); // resubmitting unchanged inputs is not a change
  });
  it("the stamped inputs calculate, and the recorded reason travels with the line", () => {
    const s = stampPricingInputs(submitted(), emptyInputRecord(), EST, FIXTURE_ACTOR, NOW);
    const r = calculatePricing(baseScenario({ itemOverrides: s.itemOverrides, forwardCover: s.forwardCover }), RULES);
    expect(r.lines.find((l) => l.key === "drinker")!.override?.price).toMatchObject({ reason: "Match competitor", by: FIXTURE_ACTOR });
  });
});

// ── 10 / boundary: the model is isolated from Cin7, Xero, the database and the existing engine ──────────
const ROOT = path.resolve(__dirname, "../../../../..");
const MODEL = path.join(ROOT, "src/newquip/pricing/model");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sources = walk(MODEL).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));
const importsOf = (f: string) => [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

describe("10. no regression to Cin7 posting: the model cannot reach it, and nothing reaches the model", () => {
  it("the model imports only NewQuip pure modules, the shared margin helper and itself: no Cin7, Xero, Supabase, server, email or billing code", () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const f of sources) for (const i of importsOf(f)) {
      const ok = i.startsWith("./") || i.startsWith("../../") || i === "@/lib/projects/margin-figures";
      expect(ok, `${path.relative(ROOT, f)} -> ${i}`).toBe(true);
      expect(i, `${f} -> ${i}`).not.toMatch(/cin7|xero|supabase|server-only|next\/|email|billing|sync|write-flag|posting/i);
    }
  });
  it("contains no organisation identifier and no Cin7 / Xero call", () => {
    for (const f of sources) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(t, f).not.toMatch(/fetch\(|NEWQUIP_CIN7_WRITES_ENABLED|process\.env|createServiceRoleClient/);
    }
  });
  it("is not called by anything outside the model in Phase 1: the existing quotation engine, actions, pages and posting code are unchanged and do not import it", () => {
    const offenders = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith(MODEL) && /pricing\/model/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
