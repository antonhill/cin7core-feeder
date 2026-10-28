import { describe, expect, it } from "vitest";
import { allocateClaim, assertVariationTransition, cin7PocRepresentation, contractPosition, nextVariationCode, NOT_SENT_TO_CIN7, type VariationRow } from "../variations";
import { buildProjectView } from "../project-view";

const v = (code: string, status: string, amount: number, title = "t"): VariationRow => ({
  id: code, code, title, description: null, amount_cents: amount, status, raised_by_email: "e@x", priced_by_email: "e@x",
  decided_by_email: status === "DRAFT" ? null : "m@x", decided_at: null, decision_reason: null, created_at: "2026-01-01",
});
const R = (n: number) => n * 100;

describe("variation codes", () => {
  it("V001 first, then the next free number", () => {
    expect(nextVariationCode([])).toBe("V001");
    expect(nextVariationCode(["V001", "V002"])).toBe("V003");
    expect(nextVariationCode(["V009"])).toBe("V010");
    expect(nextVariationCode(["junk"])).toBe("V001");
  });
});

describe("variation status machine", () => {
  it("only a DRAFT can be approved or rejected; decisions are final", () => {
    expect(() => assertVariationTransition("DRAFT", "APPROVED")).not.toThrow();
    expect(() => assertVariationTransition("DRAFT", "REJECTED")).not.toThrow();
    for (const [from, to] of [["APPROVED", "REJECTED"], ["REJECTED", "APPROVED"], ["APPROVED", "DRAFT"], ["DRAFT", "DRAFT"], ["APPROVED", "APPROVED"]] as const) {
      expect(() => assertVariationTransition(from, to)).toThrow();
    }
  });
});

describe("contract position — original is never touched", () => {
  it("revised = original + APPROVED variations only (V001 R480,000 → R10,480,000)", () => {
    const p = contractPosition(R(10_000_000), [v("V001", "APPROVED", R(480_000))]);
    expect(p).toEqual({ originalContractCents: R(10_000_000), approvedVariationsCents: R(480_000), revisedContractCents: R(10_480_000) });
  });
  it("draft and rejected variations do not change any contract value", () => {
    const p = contractPosition(R(10_000_000), [v("V001", "DRAFT", R(480_000)), v("V002", "REJECTED", R(90_000))]);
    expect(p.revisedContractCents).toBe(R(10_000_000));
    expect(p.approvedVariationsCents).toBe(0);
  });
  it("an unknown status counts for nothing (fail closed)", () => {
    expect(contractPosition(100, [v("V001", "WEIRD", 50)]).revisedContractCents).toBe(100);
  });
  it("is exposed on the project view without moving original_contract", () => {
    const project = { id: "p", org_id: "o", project_reference: "P", name: "n", customer_name: "c", originating_quote_ref: null, original_contract_cents: R(10_000_000), currency: "ZAR", tax_rule: null, tax_rate_bps: 1500, salesperson: null, project_manager: null, start_date: null, target_completion_date: null, status: "ACTIVE" };
    const view = buildProjectView({ project, stages: [], events: [], claims: [], claimLines: [], allocations: [], links: [], variations: [v("V001", "APPROVED", R(480_000)), v("V002", "DRAFT", R(1))] });
    expect(view.commercial.originalContractCents).toBe(R(10_000_000));
    expect(view.commercial.revisedContractCents).toBe(R(10_480_000));
    expect(view.project.original_contract_cents).toBe(R(10_000_000));
    const none = buildProjectView({ project, stages: [], events: [], claims: [], claimLines: [], allocations: [], links: [] });
    expect(none.commercial.revisedContractCents).toBe(R(10_000_000));
  });
});

describe("Cin7 POC representation — display only", () => {
  it("original = SO-POC-001; each approved variation the next placeholder; ALL NOT SENT TO CIN7", () => {
    const rows = cin7PocRepresentation(R(10_000_000), [v("V001", "APPROVED", R(480_000), "Additional Ventilation"), v("V002", "DRAFT", R(1)), v("V003", "REJECTED", R(2))]);
    expect(rows.map((r) => r.saleRef)).toEqual(["SO-POC-001", "SO-POC-002"]);
    expect(rows.every((r) => r.state === NOT_SENT_TO_CIN7)).toBe(true);
    expect(rows[1].label).toContain("V001");
  });
});

describe("claim allocation across commitments", () => {
  const parts = (o: number, x: number, rem = R(480_000)) => [
    { label: "Original", amountCents: o, remainingCents: R(8_000_000) },
    { label: "V001", amountCents: x, remainingCents: rem },
  ];
  it("C005 R550,000 = R450,000 original + R100,000 V001", () => {
    expect(allocateClaim(R(550_000), parts(R(450_000), R(100_000))).ok).toBe(true);
  });
  it("must sum to the claim, never exceed a commitment, never go negative", () => {
    expect(allocateClaim(R(550_000), parts(R(450_000), R(99_000))).ok).toBe(false);
    expect(allocateClaim(R(550_000), parts(R(450_000), R(100_000), R(50_000))).ok).toBe(false);
    expect(allocateClaim(R(550_000), parts(R(600_000), -R(50_000))).ok).toBe(false);
  });
});
