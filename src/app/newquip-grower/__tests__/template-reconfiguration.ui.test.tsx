// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlternativeProductChoice } from "../[id]/AlternativeProductChoice";
import { PenningScopePanel } from "../[id]/PenningScopePanel";
import { penningScope } from "@/newquip/grower/penning";

afterEach(cleanup);

describe("alternative products (PNQ002 for the feeder)", () => {
  it("the standard product is the default; choosing an alternative shows its caution and REPLACES the product through onChange; choosing standard clears it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AlternativeProductChoice itemKey="feeder" standardSku="PNQ082" value={undefined} onChange={onChange} />);
    expect((screen.getByLabelText(/Standard product \(PNQ082\)/) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("alternative-caution-PNQ002")).toBeNull();
    fireEvent.click(screen.getByLabelText(/CCM FEEDER FOR GROWERS \(PNQ002\)/));
    expect(onChange).toHaveBeenLastCalledWith("PNQ002");
    rerender(<AlternativeProductChoice itemKey="feeder" standardSku="PNQ082" value="PNQ002" onChange={onChange} />);
    expect(screen.getByTestId("alternative-caution-PNQ002").textContent).toMatch(/never an extra line beside the feeder/);
    fireEvent.click(screen.getByLabelText(/Standard product/));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it("the bulk tank offers NO alternative (SYSH-2750-4 is DON'T QUOTE); an item with no alternatives renders nothing", () => {
    const { container, rerender } = render(<AlternativeProductChoice itemKey="bulk_tank" standardSku="SYSH-2750-3" value={undefined} onChange={() => {}} />);
    expect(container.textContent).toBe("");
    rerender(<AlternativeProductChoice itemKey="concrete_slat" standardSku="NQ1161" value={undefined} onChange={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("the penning component scope", () => {
  const scope = penningScope({ lengthM: 49.5, widthM: 14.43, rooms: 12, penningPigSize: "SMALL", penningRunningMetresPerRoom: 100 });
  it("shows the room, the entered running metres and every component with its quantity left to the Estimator; no price and no invented count", () => {
    render(<PenningScopePanel scope={scope} />);
    expect(screen.getByTestId("penning-room").textContent).toMatch(/49.5 m × 14.43 m, 12 rooms/);
    expect(screen.getByTestId("penning-rm-room").textContent).toBe("100 m");
    expect(screen.getByTestId("penning-rm-project").textContent).toBe("1,200 m");
    const items = within(screen.getByTestId("penning-components")).getAllByRole("listitem");
    expect(items).toHaveLength(15);
    expect(items.every((li) => /quantity: Estimator decision/.test(li.textContent ?? ""))).toBe(true);
    expect(screen.getByTestId("penning-components").textContent).toMatch(/KNQ050-900/);
    expect(screen.getByTestId("penning-panel").textContent).toMatch(/No SKU at quotation/);
    expect(screen.getByTestId("penning-scope").textContent).not.toMatch(/\bR\s?\d/); // no price anywhere
  });
  it("names what is still missing instead of showing a number", () => {
    render(<PenningScopePanel scope={penningScope({ lengthM: 10, widthM: 5, rooms: 1, penningPigSize: null, penningRunningMetresPerRoom: null })} />);
    expect(screen.getByTestId("penning-rm-room").textContent).toBe("not entered");
    expect(screen.getByTestId("penning-decisions").textContent).toMatch(/Select the pig size/);
    expect(screen.getByTestId("penning-decisions").textContent).toMatch(/Post spacing is not supplied/);
  });
});
