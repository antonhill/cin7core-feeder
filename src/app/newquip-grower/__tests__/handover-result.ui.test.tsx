// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const available = vi.fn(); const select = vi.fn();
vi.mock("@/app/demo-mode/actions", () => ({ demoSwitchAvailableAction: (...a: unknown[]) => available(...a), selectDemoIdentityAction: (...a: unknown[]) => select(...a) }));
import { HandoverResult } from "../[id]/HandoverResult";

const props = {
  quoteRef: "NQ-Q-0026", revision: 2, previousCents: 4193351546, newCents: 6169751546,
  changes: [{ key: "feed_saver_mat", kind: "line price" as const, before: null, after: 10000 }, { key: "concrete_slat_delivery", kind: "charge" as const, before: 250000, after: 2500000 }],
  labelOf: (k: string) => ({ feed_saver_mat: "Feed saver mat", concrete_slat_delivery: "Concrete slat delivery" } as Record<string, string>)[k] ?? k,
  fmtCents: (c: number) => `R${(c / 100).toFixed(2)}`, fmtRand: (r: number) => `R${r.toFixed(2)}`, onDismiss: vi.fn(),
};

beforeEach(() => { available.mockReset(); select.mockReset(); });
afterEach(cleanup);

describe("Estimator handover result screen", () => {
  it("says the quotation went back to the Rep, shows previous -> new total and what changed, and names the next role", async () => {
    available.mockResolvedValue(false);
    render(createElement(HandoverResult, props));
    expect(screen.getByRole("heading", { name: /gone back to the Rep/i })).toBeTruthy();
    expect(screen.getByTestId("handover-total").textContent).toMatch(/R41933515\.46 to R61697515\.46/);
    expect(screen.getByTestId("handover-changes").textContent).toMatch(/Feed saver mat: unit price entered R10000\.00/);
    expect(screen.getByTestId("handover-changes").textContent).toMatch(/Concrete slat delivery: charge R2500\.00 → R25000\.00|Concrete slat delivery: charge R250000\.00 → R2500000\.00/);
    expect(document.body.textContent).toMatch(/Next responsible role: Rep/);
  });

  it("offers no role switch for a normal user", async () => {
    available.mockResolvedValue(false);
    render(createElement(HandoverResult, props));
    await waitFor(() => expect(available).toHaveBeenCalled());
    expect(screen.queryByTestId("continue-as-rep")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("in Presenter Mode offers ONE Continue as Rep action that uses the server-authorised switch (slot name only)", async () => {
    available.mockResolvedValue(true); select.mockResolvedValue({ ok: false, error: "Demo Mode is switched off." });
    render(createElement(HandoverResult, props));
    const b = await screen.findByTestId("continue-as-rep");
    fireEvent.click(b);
    await waitFor(() => expect(select).toHaveBeenCalledWith("rep"));
    expect(await screen.findByText(/Demo Mode is switched off/)).toBeTruthy(); // a refusal is shown, not hidden
  });
});
