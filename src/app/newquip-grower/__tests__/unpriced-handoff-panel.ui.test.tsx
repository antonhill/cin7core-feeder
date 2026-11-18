// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPRICED_ACK_TEXT, UnpricedHandoffPanel } from "../[id]/UnpricedHandoffPanel";

afterEach(cleanup);
const submit = () => screen.getByRole("button", { name: /Submit to Estimator/ }) as HTMLButtonElement;

describe("UnpricedHandoffPanel", () => {
  it("states plainly that no customer price exists, and Submit stays disabled until the acknowledgement is ticked", () => {
    const onSubmit = vi.fn();
    render(<UnpricedHandoffPanel canAct ready loading={false} onSubmit={onSubmit} />);
    expect(screen.getByTestId("unpriced-explain").textContent).toMatch(/no amount to confirm/);
    expect(screen.getByTestId("unpriced-ack").textContent).toContain(UNPRICED_ACK_TEXT);
    expect(UNPRICED_ACK_TEXT).toBe("No customer price has been established yet. The Estimator will set the price and I will confirm the calculated amount with the customer before the quotation can proceed.");
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/Tick the acknowledgement above/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith(true);
  });
  it("never submits for a viewer who cannot act, an unfinished Rep configuration, or while another action runs; no amount is shown", () => {
    for (const p of [{ canAct: false, ready: true }, { canAct: true, ready: false }]) {
      const onSubmit = vi.fn();
      const { unmount } = render(<UnpricedHandoffPanel {...p} loading={false} onSubmit={onSubmit} />);
      expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
      expect(submit().disabled).toBe(true);
      fireEvent.click(submit());
      expect(onSubmit).not.toHaveBeenCalled();
      unmount();
    }
    const { unmount } = render(<UnpricedHandoffPanel canAct ready loading={false} otherBusy onSubmit={() => undefined} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit().disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/R\s?\d/);
    unmount();
  });
});
