// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetBasisConfirm } from "../[id]/WorkspaceEditors";

// The Estimator's editor for a documented Budget basis (door BOM cost, fixed panel price): NO supplier field, NO cost form, one confirmation, an honest provisional label.
afterEach(() => cleanup());
const mount = (over: Record<string, unknown> = {}) => {
  const onConfirm = vi.fn();
  render(createElement(BudgetBasisConfirm, { label: "PVC SST door (incl. frame)", quantity: 24, unitPrice: 100, basisKind: "bom_cost_markup", plain: "Provisional: internal UAT allowance.", detail: "BOM cost plus the markup once, no freight.", configuration: "PVC door 2.1 m × 1.0 m (NQ3444-B) (chosen by the Rep)", confirmed: false, canEdit: true, busy: false, onConfirm, ...over }));
  return onConfirm;
};
describe("BudgetBasisConfirm", () => {
  it("asks for NO supplier and NO cost: no search, no cost-kind choice, one confirmation", () => {
    mount();
    expect(screen.queryByText(/Search all active Cin7 suppliers/i)).toBeNull();
    expect(screen.queryByText(/What kind of cost is this/i)).toBeNull();
    expect(screen.getByTestId("budget-basis-config").textContent).toContain("NQ3444-B");
    expect(screen.getByTestId("budget-basis-price").textContent).toMatch(/each/);
    expect(screen.getByTestId("budget-basis-note").textContent).toMatch(/No supplier cost is needed/);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
  it("confirming calls back once; it stays provisional and says it is not an approved NewQuip price", () => {
    const onConfirm = mount();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onConfirm).toHaveBeenCalledWith(true);
    expect(document.body.textContent).toMatch(/provisional and is not an approved NewQuip price/);
  });
  it("a fixed selling price says there is no freight or markup; a viewer who cannot edit cannot confirm", () => {
    mount({ basisKind: "fixed_selling_price", label: "Control panel for CL1 & BF", canEdit: false });
    expect(document.body.textContent).toMatch(/fixed Budget selling price/);
    expect(document.body.textContent).toMatch(/no freight, no markup/);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
  it("can offer the supplier-costed alternative", () => {
    const go = vi.fn(); mount({ onChooseProduct: go });
    fireEvent.click(screen.getByRole("button", { name: /Choose a Cin7 product instead/ }));
    expect(go).toHaveBeenCalled();
  });
});
