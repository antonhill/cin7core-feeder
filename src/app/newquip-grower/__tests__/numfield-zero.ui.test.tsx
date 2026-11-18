// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumField } from "../fields";

afterEach(cleanup);

// An explicit 0 must reach the draft as 0 (a deliberate "no charge"); an empty box as null (not decided).
describe("NumField keeps an explicit zero distinct from blank", () => {
  it("typing 0 reports 0, clearing reports null, a negative is reported as typed (the evaluator refuses it)", () => {
    const onChange = vi.fn();
    render(<NumField label="Delivery" ariaLabel="Delivery charge (R ex VAT)" value={null} onChange={onChange} />);
    const box = screen.getByLabelText("Delivery charge (R ex VAT)");
    fireEvent.change(box, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(box, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.change(box, { target: { value: "-5" } });
    expect(onChange).toHaveBeenLastCalledWith(-5);
  });
  it("renders a stored 0 as 0, not as an empty box", () => {
    render(<NumField label="Delivery" ariaLabel="Delivery charge (R ex VAT)" value={0} onChange={() => {}} />);
    expect((screen.getByLabelText("Delivery charge (R ex VAT)") as HTMLInputElement).value).toBe("0");
  });
});
