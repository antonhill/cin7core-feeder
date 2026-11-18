// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PackageOwnConfirmation } from "../[id]/PackageOwnConfirmation";
import { bulkConfirmablePackageKeys, packageFor, TEMPLATE_REVISION_CURRENT, TEMPLATE_REVISION_LEGACY } from "@/newquip/grower/commercial";
import { GROWER_ITEM_KEYS } from "@/newquip/grower/types";

afterEach(cleanup);

describe("bulk confirmation never covers a package that needs the Estimator's own decision", () => {
  it("excludes the LED light and the cup drinker on both template revisions, whatever else it confirms", () => {
    for (const rev of [TEMPLATE_REVISION_LEGACY, TEMPLATE_REVISION_CURRENT]) {
      const keys = bulkConfirmablePackageKeys(GROWER_ITEM_KEYS, rev);
      expect(keys).not.toContain("led_light");
      expect(keys).not.toContain("cup_drinker");
    }
  });
  it("today no package passes bulk confirmation (every package needs the Estimator or is estimator-priced), so the bulk action confirms none", () => {
    expect(bulkConfirmablePackageKeys(GROWER_ITEM_KEYS, TEMPLATE_REVISION_CURRENT)).toEqual([]);
    expect(bulkConfirmablePackageKeys(GROWER_ITEM_KEYS, TEMPLATE_REVISION_LEGACY)).toEqual([]);
  });
  it("never includes an estimator-priced, layout-driven or note-bearing package", () => {
    for (const k of bulkConfirmablePackageKeys(GROWER_ITEM_KEYS, TEMPLATE_REVISION_CURRENT)) {
      const p = packageFor(k, TEMPLATE_REVISION_CURRENT)!;
      expect(p.estimatorPriced || p.layoutDriven || p.estimatorConfirmation || p.alternativeIdentity).toBeFalsy();
    }
  });
});

describe("PackageOwnConfirmation", () => {
  const led = packageFor("led_light", TEMPLATE_REVISION_CURRENT)!;
  it("shows the proposed LED composition HNQ7046 x1, HNQ7093 x3, HNQ7088 x1 and why it needs a decision, before any confirmation", () => {
    render(<PackageOwnConfirmation pkg={led} confirmed={false} canEdit onChange={() => {}} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.replace(/\s+/g, " ").trim());
    expect(items.some((t) => /^1 ×\s*HNQ7046/.test(t ?? ""))).toBe(true);
    expect(items.some((t) => /^3 ×\s*HNQ7093/.test(t ?? ""))).toBe(true);
    expect(items.some((t) => /^1 ×\s*HNQ7088/.test(t ?? ""))).toBe(true);
    expect(screen.getByTestId("package-own-reason").textContent).toMatch(/not their quantities/);
    expect(screen.getByText("Package unconfirmed")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });
  it("confirms only when the Estimator ticks it, and is read-only without edit rights", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PackageOwnConfirmation pkg={led} confirmed={false} canEdit onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<PackageOwnConfirmation pkg={led} confirmed={false} canEdit={false} onChange={onChange} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
  it("shows the cup drinker's alternative representation as its reason", () => {
    const cup = packageFor("cup_drinker", TEMPLATE_REVISION_CURRENT)!;
    render(<PackageOwnConfirmation pkg={cup} confirmed={false} canEdit onChange={() => {}} />);
    expect(screen.getByTestId("package-own-reason").textContent).toMatch(/NB3542-03/);
  });
});
