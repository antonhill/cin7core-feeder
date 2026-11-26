// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceOpenRow } from "../[id]/WorkspaceParts";
import type { CompleteLine } from "@/newquip/quote/estimator-workspace";

// A documented Budget basis (door BOM cost, fixed panel price) must NOT be described as a "manual quotation price" in the Estimator's evidence row.
afterEach(() => cleanup());
const line = (over: Partial<CompleteLine>): CompleteLine => ({ id: "pvc_door", label: "PVC SST door (incl. frame)", how: "x", quantity: 24, unit: 100, revenue: 2400, provisional: true, estimatorPriced: true, costState: "n/a", evidence: { state: "missing", text: "no pricing evidence has been recorded", note: null, reference: null }, ...over });
const text = (l: CompleteLine) => { render(createElement("ol", null, createElement(EvidenceOpenRow, { n: 1, line: l, canEdit: true, onRecord: async () => ({ ok: true }) }))); return document.body.textContent ?? ""; };
describe("EvidenceOpenRow wording", () => {
  it("a documented Budget basis is labelled as such, never as a manual quotation price", () => {
    const t = text(line({ budgetBasis: true }));
    expect(t).toContain("Documented Budget basis, provisional");
    expect(t).not.toContain("Manual quotation price");
  });
  it("a real manual quotation price keeps its wording", () => {
    expect(text(line({ budgetBasis: false }))).toContain("Manual quotation price, provisional");
  });
});
