// A supplier named "(EURO)" / "(DOLLAR)" whose Cin7 currency is ZAR must NEVER be priced (it would be read about 19 times too low). Neutral fixtures only.
import { describe, expect, it } from "vitest";
import { autoCostFor, currencyHintFromSupplierName, isFlag } from "../auto-costing";
import { emptyCommercialSettings, type CommercialSettings } from "../commercial-settings";
import type { MasterSupplier, SurveyInput } from "../cost-survey";

const NOW = "2026-11-25T09:00:00Z";
const SETTINGS: CommercialSettings = { ...emptyCommercialSettings(), markupBps: 2000, freight: { factorMicro: 1_150_000, addOnCents: 0, source: "fixture" }, fx: { EUR: { rateMicro: 19_000_000, source: "fixture", asOf: "2026-11-25T07:00:00Z" }, USD: { rateMicro: 17_000_000, source: "fixture", asOf: "2026-11-25T07:00:00Z" } } };
const REF = { version: 7, enteredBy: "fixture" };
const run = (name: string, currency: "EUR" | "USD" | "ZAR") => {
  const master = new Map<string, MasterSupplier>([["S1", { id: "S1", name, currency, active: true }]]);
  const input = { sku: "X", found: true, productStatus: "Active", productName: "X", uom: "Item", averageCost: null, unitFields: {}, suppliers: [{ supplierId: "S1", supplierName: name, cost: 10, fixedCost: 10, currency, lastSupplied: "2026-11-25" }] } as unknown as SurveyInput;
  return autoCostFor(input, master, SETTINGS, REF, NOW);
};

describe("supplier-name currency guard", () => {
  it("reads the marker only when it is explicit", () => {
    expect(currencyHintFromSupplierName("HOTRACO (EURO)")).toBe("EUR");
    expect(currencyHintFromSupplierName("MP MACHINERY (DOLLAR)")).toBe("USD");
    expect(currencyHintFromSupplierName("KUNLONG INTERNATIONAL (USD)")).toBe("USD");
    expect(currencyHintFromSupplierName("POLNET (RAND)")).toBe("ZAR");
    expect(currencyHintFromSupplierName("ERRA TECNI-RAM SL")).toBeNull();
    expect(currencyHintFromSupplierName("ALNET (COD)")).toBeNull();
    expect(currencyHintFromSupplierName(null)).toBeNull();
  });
  it("a (EURO) or (DOLLAR) supplier carried as ZAR is flagged and never priced, with the reason for the Estimator", () => {
    for (const n of ["HOTRACO (EURO)", "RIDDER (EURO)", "MP MACHINERY (DOLLAR)", "MULTIFAN / VOSTERMANS (EURO)"]) {
      const r = run(n, "ZAR"); expect(isFlag(r), n).toBe(true);
      if (isFlag(r)) { expect(r.code).toBe("currency_unknown"); expect(r.internal).toMatch(/name says/); }
    }
    expect(isFlag(run("POLNET (RAND)", "EUR"))).toBe(true);
  });
  it("a marker that agrees with the currency, and an unmarked supplier, price exactly as before", () => {
    expect(isFlag(run("HOTRACO (EURO)", "EUR"))).toBe(false);
    expect(isFlag(run("KUNLONG INTERNATIONAL (USD)", "USD"))).toBe(false);
    expect(isFlag(run("A & G FASTENERS (PTY) LTD", "ZAR"))).toBe(false);
    expect(isFlag(run("ERRA TECNI-RAM SL", "EUR"))).toBe(false);
  });
});
