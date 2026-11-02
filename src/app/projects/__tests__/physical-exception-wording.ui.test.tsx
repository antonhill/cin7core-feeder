// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { exceptionLabel } from "@/lib/projects/exception-labels";

// D4 final audit P2-2: raw machine codes never reach the user on Products & Stock.
vi.mock("../physical-actions", () => ({
  getPhysicalStatusAction: vi.fn(async () => ({ ok: true, data: { sections: [{
    label: "Original", scope: "BASE", linked: true, saleNumber: "SO-1", asOf: "2026-11-02T00:00:00Z", scopeBlockers: [], rows: [],
    exceptions: [{ code: "OVER_INVOICED", sku: "A", message: "A: 5 invoiced, 3 ordered." }, { code: "NOT_ON_ORDER", sku: "B", message: "B is in scope but not on the order." }, { code: "SOMETHING_NEW", sku: "C", message: "C." }],
  }] } })),
}));
import { PhysicalPanel } from "../[id]/PhysicalPanel";
afterEach(cleanup);

describe("Products & Stock exception wording", () => {
  it("renders sentence-case business wording, with a safe fallback for an unknown code", async () => {
    render(<PhysicalPanel view={{ project: { id: "p1" } } as never} />);
    fireEvent.click(screen.getByRole("button", { name: /Read from Cin7/ }));
    expect(await screen.findByText(/Invoiced more than ordered: A: 5 invoiced/)).toBeTruthy();
    expect(screen.getByText(/Not on the order: B is in scope/)).toBeTruthy();
    expect(screen.getByText(/Something new: C\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/OVER_INVOICED|NOT_ON_ORDER|SOMETHING_NEW/);
  });
  it("labels", () => { expect(exceptionLabel("OVER_BILLED")).toBe("Billed more than the contract"); });
});
