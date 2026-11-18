import { describe, expect, it } from "vitest";
import { checkApproval, checkSignOff } from "../workflow";

// Found in the isolated Preview run (NQ-008B P2): the sign-off message for a NON-WAIVABLE reason contradicted itself ("cannot be waived" ... "or record an exception") and doubled a full stop.
const ready = { state: "READY", reasons: [] } as never;
const base = { readiness: ready, totalExVatCents: 100, customerConfirmedCents: 100 };
describe("incomplete-costing messages", () => {
  it("a waivable reason keeps the existing wording exactly", () => {
    expect(checkSignOff({ ...base, costing: { complete: false, reasons: ["2 SKU(s) have no supplier cost selected"] } })).toEqual({ ok: false, error: "Costing is incomplete: 2 SKU(s) have no supplier cost selected. Complete it (or record an authorised incomplete-cost exception) before signing off." });
    expect(checkApproval({ ...base, signoffHash: "h", currentDraftHash: "h", costing: { complete: false, reasons: ["x"] } })).toEqual({ ok: false, error: "Costing is incomplete: x. It cannot be approved." });
  });
  it("a NON-waivable reason does not suggest the exception and has no doubled full stop", () => {
    const r = checkSignOff({ ...base, costing: { complete: false, reasons: ["NQ1017: the supplier cost is not verified, so its price is indicative only. This cannot be waived by the incomplete-costing exception."] } });
    expect(r).toEqual({ ok: false, error: "Costing is incomplete: NQ1017: the supplier cost is not verified, so its price is indicative only. This cannot be waived by the incomplete-costing exception." });
  });
});
