// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../template-adoption-actions", () => ({ previewTemplateAdoptionAction: vi.fn(), adoptTemplateRevisionAction: vi.fn() }));
import * as actions from "../template-adoption-actions";
import { TemplateRevisionPanel } from "../[id]/TemplateRevisionPanel";

afterEach(cleanup);
const comp = (sku: string | null, description: string, quantity: number | null, status: string) => ({ sku, description, quantity, qtyPerUnit: null, status });
const line = (status: string, v: number | null, comps: ReturnType<typeof comp>[]) => ({ status, sellingExVat: v, reason: "", components: comps });
const preview = (over: Record<string, unknown> = {}) => ({ ok: true, data: { draftHash: "h1", revision: 1, state: "ESTIMATOR_REVIEW", impact: {
  from: "grower-2026-10", to: "grower-2026-11", eligible: true, refusal: null,
  led: { before: line("priced", 401736, [comp(null, "FORTIS luminaire", null, "identity_unresolved")]), afterConfirmed: line("priced", 401736, [comp("HNQ7046", "Luminaire", 456, "priced"), comp("HNQ7093", "Clip", 1368, "priced"), comp("HNQ7088", "Cable", 456, "priced")]), afterUnconfirmed: line("package_unconfirmed", null, [comp("HNQ7046", "Luminaire", 456, "pending")]) },
  totals: { before: { exVat: 1000, complete: true }, afterConfirmed: { exVat: 1000, complete: true }, afterUnconfirmed: { exVat: 900, complete: false } },
  otherDifferences: ["M75 reference package: support post KNQ050-900."], newSkus: [], effects: { confirmationWithdrawn: true, signoffCleared: true, returnedToRep: true }, ...over } } });

describe("the template revision panel (Estimator)", () => {
  it("changes nothing by itself: it only offers a review; the review shows old v new components, values and effects", async () => {
    vi.mocked(actions.previewTemplateAdoptionAction).mockResolvedValue(preview() as never);
    render(<TemplateRevisionPanel quoteId="q1" disabled={false} onAdopted={() => {}} />);
    expect(screen.queryByTestId("adoption-review")).toBeNull();
    expect(actions.adoptTemplateRevisionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review what would change" }));
    await screen.findByTestId("adoption-review");
    expect(screen.getByTestId("led-before").textContent).toMatch(/no SKU/);
    expect(screen.getByTestId("led-after").textContent).toMatch(/HNQ7093 · Clip · quantity 1368/);
    expect(screen.getByTestId("adoption-review").textContent).toMatch(/historical assumptions/);
    expect(screen.getByTestId("adoption-effects").textContent).toMatch(/customer's confirmation is withdrawn.*returns to the Rep.*sign-off is withdrawn/);
  });
  it("cannot be applied without the acknowledgement and a reason; then sends exactly the figures shown (the unconfirmed total by default, the confirmed one when the package is ticked)", async () => {
    vi.mocked(actions.previewTemplateAdoptionAction).mockResolvedValue(preview() as never);
    vi.mocked(actions.adoptTemplateRevisionAction).mockResolvedValue({ ok: true, data: { revision: 2, returnedToRep: true, confirmationWithdrawn: true, signoffCleared: true, totalExVat: 900, totalComplete: false } });
    const onAdopted = vi.fn();
    render(<TemplateRevisionPanel quoteId="q1" disabled={false} onAdopted={onAdopted} />);
    fireEvent.click(screen.getByRole("button", { name: "Review what would change" }));
    const go = (await screen.findByRole("button", { name: "Move this quotation to the current template" })) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (recorded in the audit history)"), { target: { value: "Adopt corrected LED" } });
    expect(go.disabled).toBe(true); // still not acknowledged
    fireEvent.click(screen.getByLabelText(/I acknowledge this changes the quotation/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(actions.adoptTemplateRevisionAction).toHaveBeenCalledWith("q1", { reason: "Adopt corrected LED", expectedDraftHash: "h1", acknowledgeImpact: true, acknowledgedTotalExVat: 900, confirmNewLedPackage: false }));
    await screen.findByTestId("adoption-done");
    expect(screen.getByTestId("adoption-done").textContent).toMatch(/revision 2.*confirmation was withdrawn/);
    expect(onAdopted).toHaveBeenCalled();
  });
  it("is disabled while there are unsaved edits, and shows a server refusal without changing anything", async () => {
    const { rerender } = render(<TemplateRevisionPanel quoteId="q1" disabled onAdopted={() => {}} />);
    expect((screen.getByRole("button", { name: "Review what would change" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<TemplateRevisionPanel quoteId="q1" disabled={false} onAdopted={() => {}} />);
    vi.mocked(actions.previewTemplateAdoptionAction).mockResolvedValue({ ok: false, error: "Only an Estimator can move a quotation to the current template." } as never);
    fireEvent.click(screen.getByRole("button", { name: "Review what would change" }));
    expect((await screen.findByTestId("adoption-error")).textContent).toMatch(/Only an Estimator/);
  });
});
