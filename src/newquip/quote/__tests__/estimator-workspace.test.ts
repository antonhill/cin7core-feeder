import { describe, expect, it } from "vitest";
import type { BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView, SkuRow } from "@/newquip/pricing/estimator";
import { buildWorkspace, decodeManualReason, encodeManualReason, manualPriceComplete, manualReasonText, targetOf, type WorkspaceFacts } from "../estimator-workspace";

// Test12-shaped: 12 rooms. M75 and penning are Estimator-priced; slats, mats, tank, feeder need a supplier cost; the cup drinker needs its package confirmed and costed; LED has no SKU; the door needs a product.
const line = (o: Partial<BridgeLine> & { itemKey: string; label: string }): BridgeLine => ({ status: "priced", reason: "", sku: null, quantity: 1, unitPrice: null, revenueExTax: null, estimatedCost: null, estimatedGP: null, marginPct: null, pricedBy: null, ...o }) as unknown as BridgeLine;
const comp = (id: string, sku: string | null, status = "priced") => ({ id, sku, description: id, qtyPerUnit: 1, quantity: 648, status, reason: "", unitPrice: null, revenueExTax: null, estimatedCost: null });
const row = (sku: string, costState: SkuRow["costState"]): SkuRow => ({ sku, costState, status: costState === "missing" ? "no_input" : "priced", usedBy: [], quantity: 1 } as unknown as SkuRow);

function test12(over: { lines?: BridgeLine[]; rows?: SkuRow[]; incomplete?: boolean; subtotal?: number } = {}): { budget: BudgetQuote; view: PricingWorkspaceView } {
  const lines = over.lines ?? [
    line({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", quantity: 12, unitPrice: 200000, revenueExTax: 2_400_000 }),
    line({ itemKey: "penning_package", label: "Penning", pricedBy: "penning_rate", quantity: 240, unitPrice: 1300, revenueExTax: 312_000 }),
    line({ itemKey: "concrete_slat", label: "Concrete slats", status: "not_in_price_source", sku: "NQ1161", quantity: 15840 }),
    line({ itemKey: "feed_saver_mat", label: "Feed saver mats", status: "not_in_price_source", sku: "ERT053", quantity: 216 }),
    line({ itemKey: "cup_drinker", label: "Cup drinker package", status: "package_unconfirmed", quantity: 648, components: [comp("cup", "QCA00003"), comp("pipe", "NQ1380")] as never }),
    line({ itemKey: "led_light", label: "FORTIS 1.2 LED light", status: "package_unconfirmed", quantity: 456, components: [comp("lum", null, "identity_unresolved"), comp("clip", null, "identity_unresolved")] as never }),
    line({ itemKey: "pvc_door", label: "PVC SST door", status: "unmapped", quantity: 24 }),
    line({ itemKey: "bulk_tank", label: "Bulk tank", status: "not_in_price_source", sku: "SYSH-2750-3", quantity: 12 }),
    line({ itemKey: "feeder", label: "CCM feeder", status: "not_in_price_source", sku: "PNQ082", quantity: 216 }),
    line({ itemKey: "controller", label: "Controller", status: "not_selected" }),
  ];
  const budget = { lines, totals: { subtotalExTax: over.subtotal ?? 7_607_144 }, incomplete: over.incomplete ?? true, charges: [{ key: "delivery", label: "Delivery", amountExTax: 1_000_000, status: "entered" }, { key: "installation", label: "Installation", amountExTax: 1_300_000, status: "entered" }, { key: "concrete_slat_delivery", label: "Slat delivery", amountExTax: 120_000, status: "entered" }] } as unknown as BudgetQuote;
  const view = { rows: over.rows ?? [], costs: { required: 0, verified: 0 }, totals: { margin: null } } as unknown as PricingWorkspaceView;
  return { budget, view };
}
const facts = (o: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({ state: "ESTIMATOR_REVIEW", confirmedCents: 513_200_000, signedOff: false, canEdit: true, canReview: false, confirmedPackages: [], confirmedMappings: {}, ...o });

describe("the task list is exception-first and compact", () => {
  const w = buildWorkspace({ ...test12(), facts: facts() });
  it("lists decisions first (door, cup drinker, LED), then the cost-only lines", () => {
    expect(w.tasks.map((t) => [t.n, t.id, t.group])).toEqual([
      [1, "cup_drinker", "decision"], [2, "led_light", "decision"], [3, "pvc_door", "decision"],
      [4, "concrete_slat", "cost"], [5, "feed_saver_mat", "cost"], [6, "bulk_tank", "cost"], [7, "feeder", "cost"],
    ]);
    expect(w.tasks).toHaveLength(7);
  });
  it("tags separate a product choice, components, and a supplier cost", () => {
    const by = Object.fromEntries(w.tasks.map((t) => [t.id, t.tags]));
    expect(by.pvc_door).toEqual(["PRODUCT", "PRICE"]);
    expect(by.cup_drinker).toEqual(["COMPONENTS", "PRICE"]);
    expect(by.led_light).toEqual(["COMPONENTS", "PRICE"]);
    expect(by.bulk_tank).toEqual(["COST"]);
  });
  it("four distinct indicators: a settled product with no cost is mapped but not costed or verified", () => {
    const tank = w.tasks.find((t) => t.id === "bulk_tank")!;
    expect(tank.indicators).toEqual({ mapping: "done", price: "open", cost: "open", verified: "wait" });
    expect(w.tasks.find((t) => t.id === "pvc_door")!.indicators).toEqual({ mapping: "open", price: "open", cost: "open", verified: "wait" });
    expect(w.tasks.find((t) => t.id === "led_light")!.indicators).toMatchObject({ mapping: "open", cost: "na", verified: "na" });
  });
  it("M75 and penning are completed Estimator-priced lines, never product mappings or tasks", () => {
    expect(w.complete.map((c) => [c.id, c.estimatorPriced, c.costState])).toEqual([["flex_auger", true, "n/a"], ["penning_package", true, "n/a"]]);
    expect(w.tasks.some((t) => t.id === "flex_auger" || t.id === "penning_package")).toBe(false);
  });
  it("a cost that is entered but not verified shows cost done and verified open; a verified one shows done", () => {
    const r = test12({ rows: [row("NQ1161", "unverified"), row("ERT053", "verified")] });
    const ws = buildWorkspace({ ...r, facts: facts() });
    expect(ws.tasks.find((t) => t.id === "concrete_slat")!.indicators).toMatchObject({ cost: "done", verified: "open" });
    expect(ws.tasks.find((t) => t.id === "feed_saver_mat")!.indicators).toMatchObject({ cost: "done", verified: "done" });
  });
  it("a confirmed cup package moves to costing its components", () => {
    const ws = buildWorkspace({ ...test12(), facts: facts({ confirmedPackages: ["cup_drinker"] }) });
    const cup = ws.tasks.find((t) => t.id === "cup_drinker")!;
    expect(cup.indicators.mapping).toBe("done");
    expect(cup.skus).toEqual(["QCA00003", "NQ1380"]);
  });
});

describe("a priced line leaves the task list and is grouped as complete", () => {
  it("a costed SKU line is complete with its verification state; a manual price is complete but provisional", () => {
    const r = test12({ lines: [
      line({ itemKey: "concrete_slat", label: "Concrete slats", sku: "NQ1161", quantity: 10, unitPrice: 232.32, revenueExTax: 2323.2 }),
      line({ itemKey: "led_light", label: "LED", pricedBy: "estimator_resolution", quantity: 456, unitPrice: 881, revenueExTax: 401_736 }),
    ], rows: [row("NQ1161", "unverified")], incomplete: false });
    const w = buildWorkspace({ ...r, facts: facts() });
    expect(w.tasks).toHaveLength(0);
    expect(w.complete.find((c) => c.id === "concrete_slat")).toMatchObject({ costState: "unverified", provisional: false });
    expect(w.complete.find((c) => c.id === "led_light")).toMatchObject({ provisional: true, costState: "n/a" });
  });
});

describe("the commercial summary never overstates the total or the margin", () => {
  it("Test12: a partial total of R7,607,144 against the Rep-confirmed R5,132,000", () => {
    const s = buildWorkspace({ ...test12(), facts: facts() }).summary;
    expect(s.totalKind).toBe("partial");
    expect(s.totalLabel).toBe("PARTIAL TOTAL, EX VAT");
    expect(s.totalNote).toMatch(/Not a contract value/);
    expect(s.totalExVat).toBe(7_607_144);
    expect(s.chargesExVat).toBe(2_420_000);
    expect(s.confirmedCents).toBe(513_200_000);
    expect(s.differenceCents).toBe(760_714_400 - 513_200_000);
    expect(s.marginLabel).toBe("none");
    expect(s.blockers).toContain("7 tasks open");
  });
  it("every line priced but the budget still incomplete (e.g. a required charge missing): still a PARTIAL total, never 'priced total'", () => {
    const priced = { lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows: [row("NQ1161", "unverified")], incomplete: true, subtotal: 100 };
    const s = buildWorkspace({ ...test12(priced), facts: facts({ confirmedCents: 10_000 }) }).summary;
    expect(s.totalLabel).toBe("PARTIAL TOTAL, EX VAT");
  });
  it("all lines priced but a different amount: calculated, not confirmed; equal amount: confirmed by the Rep, still not 'contract value'", () => {
    const done = { lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows: [row("NQ1161", "unverified")], incomplete: false, subtotal: 100 };
    const calc = buildWorkspace({ ...test12(done), facts: facts({ confirmedCents: 5000 }) }).summary;
    expect(calc.totalKind).toBe("calculated");
    expect(calc.totalLabel).toBe("CALCULATED TOTAL, NOT YET CONFIRMED");
    const conf = buildWorkspace({ ...test12(done), facts: facts({ confirmedCents: 10_000 }) }).summary;
    expect(conf.totalKind).toBe("confirmed");
    for (const s of [calc, conf]) expect(s.totalLabel).not.toMatch(/contract value/i);
    expect(calc.totalNote).toMatch(/Not a contract value/);
    expect(conf.totalNote).not.toMatch(/contract value/i);
  });
  it("margin is indicative until every cost is verified, then verified", () => {
    const r = test12({ lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows: [row("NQ1161", "unverified")], incomplete: false, subtotal: 100 });
    const withMargin = (verified: number) => ({ ...r, view: { ...r.view, costs: { required: 1, verified }, totals: { margin: { marginPct: 16.7 } } } as unknown as PricingWorkspaceView });
    expect(buildWorkspace({ ...withMargin(0), facts: facts({ confirmedCents: 10_000 }) }).summary.marginLabel).toBe("indicative");
    expect(buildWorkspace({ ...withMargin(1), facts: facts({ confirmedCents: 10_000 }) }).summary.marginLabel).toBe("verified");
  });
});

describe("the one next action follows the workflow order", () => {
  const priced = (rows: SkuRow[], costs: { required: number; verified: number }) => {
    const r = test12({ lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows, incomplete: false, subtotal: 100 });
    return { ...r, view: { ...r.view, costs } as unknown as PricingWorkspaceView };
  };
  it("open tasks first: open the first one", () => {
    const n = buildWorkspace({ ...test12(), facts: facts() }).next;
    expect(n).toMatchObject({ kind: "open_task", taskId: "cup_drinker", button: "Open task 1 of 7" });
  });
  it("an Estimator-less viewer is told who acts", () => {
    expect(buildWorkspace({ ...test12(), facts: facts({ canEdit: false }) }).next.kind).toBe("read_only");
  });
  it("all priced and back with the Rep: wait for the Rep", () => {
    expect(buildWorkspace({ ...priced([row("NQ1161", "unverified")], { required: 1, verified: 0 }), facts: facts({ state: "REP_DRAFT" }) }).next.kind).toBe("wait_rep");
  });
  it("all priced but the amount differs from the confirmation: return to the Rep BEFORE verification", () => {
    expect(buildWorkspace({ ...priced([row("NQ1161", "unverified")], { required: 1, verified: 0 }), facts: facts({ confirmedCents: 5000 }) }).next).toMatchObject({ kind: "return_to_rep", button: "Return to Rep" });
  });
  it("amount confirmed: a Manager verifies (the Estimator only waits)", () => {
    const base = priced([row("NQ1161", "unverified")], { required: 1, verified: 0 });
    expect(buildWorkspace({ ...base, facts: facts({ confirmedCents: 10_000, canReview: true }) }).next.kind).toBe("verify_costs");
    expect(buildWorkspace({ ...base, facts: facts({ confirmedCents: 10_000, canReview: false }) }).next.kind).toBe("wait_manager");
  });
  it("verified: sign-off, then Manager approval, then approved", () => {
    const base = priced([row("NQ1161", "verified")], { required: 1, verified: 1 });
    expect(buildWorkspace({ ...base, facts: facts({ confirmedCents: 10_000 }) }).next.kind).toBe("sign_off");
    expect(buildWorkspace({ ...base, facts: facts({ confirmedCents: 10_000, signedOff: true }) }).next.kind).toBe("wait_manager_approval");
    expect(buildWorkspace({ ...base, facts: facts({ confirmedCents: 10_000, state: "MANAGER_APPROVED_FINAL" }) }).next.kind).toBe("approved");
  });
});

describe("manual quotation price: reason and evidence in the existing reason field", () => {
  it("is one readable labelled text and round-trips both inputs, including line breaks", () => {
    const stored = encodeManualReason("No SKU exists for the FORTIS 1.2 yet.\nSecond line.", "Supplier quote ref. 123, dated 12 Nov");
    expect(stored).toBe("REASON: No SKU exists for the FORTIS 1.2 yet.\\nSecond line.\nEVIDENCE: Supplier quote ref. 123, dated 12 Nov");
    expect(decodeManualReason(stored)).toEqual({ reason: "No SKU exists for the FORTIS 1.2 yet.\nSecond line.", evidence: "Supplier quote ref. 123, dated 12 Nov", legacy: false });
  });
  it("is LOSSLESS over adversarial text: markers, line breaks, backslashes, empty parts, escapes that look like escapes", () => {
    const nasty = ["", "x", "EVIDENCE: fake", "a\nEVIDENCE: fake", "\nEVIDENCE: ", "REASON: inner", "back\\slash", "ends with \\", "\\n literal", "\\\\n", "line1\r\nline2", "tab\there", "unicode R ✓ — é", "\\", "\n", "\r"];
    for (const r of nasty) for (const e of nasty) {
      const d = decodeManualReason(encodeManualReason(r, e));
      expect(d, JSON.stringify([r, e])).toEqual({ reason: r.trim(), evidence: e.trim(), legacy: false });
    }
  });
  it("the stored text never contains a second separator or a raw line break inside a part", () => {
    const stored = encodeManualReason("a\nEVIDENCE: b\nc", "d\ne");
    expect(stored.split("\n")).toHaveLength(2);
    expect(stored.match(/\nEVIDENCE: /g)).toHaveLength(1);
  });
  it("the Manager's one-line text names both parts; an earlier text is shown whole", () => {
    expect(manualReasonText(encodeManualReason("why", "quote 7"))).toBe("reason: why · evidence: quote 7");
    expect(manualReasonText("Phoned the supplier")).toBe("Phoned the supplier");
    expect(manualReasonText("")).toBe("no reason");
  });
  it("an earlier free-text reason is shown whole as the reason and flagged legacy with no evidence", () => {
    expect(decodeManualReason("Supplier phoned with a price")).toEqual({ reason: "Supplier phoned with a price", evidence: "", legacy: true });
    expect(decodeManualReason(undefined)).toEqual({ reason: "", evidence: "", legacy: true });
  });
  it("is complete only with a positive price, a reason and evidence", () => {
    expect(manualPriceComplete("why", "quote ref 0001", 881)).toBe(true);
    expect(manualPriceComplete("why", "quote 1", 881)).toBe(false); // the evidence record needs at least 10 characters
    expect(manualPriceComplete("why", "x".repeat(501), 881)).toBe(false);
    expect(manualPriceComplete("why", "", 881)).toBe(false);
    expect(manualPriceComplete("", "quote ref 0001", 881)).toBe(false);
    expect(manualPriceComplete("why", "quote ref 0001", 0)).toBe(false);
    expect(manualPriceComplete("why", "quote ref 0001", null)).toBe(false);
  });
});

describe("unpriced M75: an explicit price task, never a package or component task", () => {
  const m75 = () => line({ itemKey: "flex_auger", label: "M75 feed system", status: "estimator_price_required", quantity: 12, reason: "M75 is estimator input by design", components: [comp("auger", "NQ1163", "reference_only"), comp("tube", "NQ1223", "reference_only")] as never });
  it("is a PRICE task with no mapping, supplier cost or verification, and carries no component SKUs", () => {
    const w = buildWorkspace({ ...test12({ lines: [m75()], incomplete: true, subtotal: 0 }), facts: facts() });
    expect(w.tasks).toHaveLength(1);
    expect(w.tasks[0]).toMatchObject({ id: "flex_auger", kind: "m75", tags: ["PRICE"], skus: [], action: "Enter price", group: "decision" });
    expect(w.tasks[0].indicators).toEqual({ mapping: "na", price: "open", cost: "na", verified: "na" });
    expect(w.next).toMatchObject({ kind: "open_task", taskId: "flex_auger", headline: "Enter the M75 system price" });
    expect(targetOf(m75())).toEqual({ kind: "m75", skus: [] });
  });
  it("once priced it is a completed Estimator-priced line again", () => {
    const priced = line({ itemKey: "flex_auger", label: "M75", pricedBy: "estimator_input", quantity: 12, unitPrice: 200000, revenueExTax: 2_400_000 });
    const w = buildWorkspace({ ...test12({ lines: [priced], incomplete: false }), facts: facts() });
    expect(w.tasks).toHaveLength(0);
    expect(w.complete[0]).toMatchObject({ id: "flex_auger", estimatorPriced: true });
  });
  it("the Test12-shaped quotation with the M75 price missing has the M75 task first and no component task", () => {
    const base = test12().budget.lines.filter((l) => l.itemKey !== "flex_auger");
    const w = buildWorkspace({ ...test12({ lines: [m75(), ...base] }), facts: facts() });
    expect(w.tasks[0].id).toBe("flex_auger");
    expect(w.tasks.filter((t) => t.kind === "package").map((t) => t.id)).toEqual(["cup_drinker"]);
  });
});

describe("things only the Rep can supply are named, not offered as tasks", () => {
  const penningNoSize = line({ itemKey: "penning_package", label: "Penning", status: "estimator_price_required", reason: "Select the pig size so the running-metre rate applies.", quantity: 240 });
  const noQty = line({ itemKey: "feeder", label: "CCM feeder", status: "no_quantity", reason: "Estimator input required", quantity: null });
  it("an unpriced penning line (pig size) and a missing quantity become Rep items; no task, and the next action says so", () => {
    const w = buildWorkspace({ ...test12({ lines: [penningNoSize, noQty], incomplete: true }), facts: facts() });
    expect(w.tasks).toHaveLength(0);
    expect(w.repItems.map((r) => r.id)).toEqual(["penning_package", "feeder"]);
    expect(w.next.kind).toBe("wait_rep_items");
    expect(w.next.button).toBeNull();
    expect(w.next.headline).toMatch(/Waiting for the Rep: Penning: Select the pig size.*CCM feeder: quantity not entered/);
  });
  it("a charge the Rep has not entered is a Rep item too, and sign-off is not offered", () => {
    const r = test12({ lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows: [row("NQ1161", "verified")], incomplete: true, subtotal: 100 });
    (r.budget as unknown as { charges: unknown[] }).charges = [{ key: "delivery", label: "Delivery", amountExTax: null, status: "required" }];
    const w = buildWorkspace({ ...r, view: { ...r.view, costs: { required: 1, verified: 1 } } as never, facts: facts({ confirmedCents: 10_000 }) });
    expect(w.next.kind).toBe("wait_rep_items");
    expect(w.summary.blockers).toEqual(["Waiting for the Rep: Delivery: amount not entered"]);
  });
});

describe("the blocked-by list and the next action come from the same facts", () => {
  const priced = (costs: { required: number; verified: number }, incomplete = false) => {
    const r = test12({ lines: [line({ itemKey: "concrete_slat", label: "Slats", sku: "NQ1161", revenueExTax: 100 })], rows: [row("NQ1161", costs.verified ? "verified" : "unverified")], incomplete, subtotal: 100 });
    (r.budget as unknown as { charges: unknown[] }).charges = [];
    return { ...r, view: { ...r.view, costs } as unknown as PricingWorkspaceView };
  };
  it("nothing to verify (no supplier costs required): no 'costs not verified' blocker, and the next action does not wait for verification", () => {
    const w = buildWorkspace({ ...priced({ required: 0, verified: 0 }), facts: facts({ confirmedCents: 10_000 }) });
    expect(w.summary.blockers).toEqual([]);
    expect(w.next.kind).toBe("sign_off");
  });
  it("a partial total with nothing open never offers sign-off: it names the incomplete reason", () => {
    const r = priced({ required: 1, verified: 1 }, true);
    (r.budget as unknown as { blockers: string[] }).blockers = ["Something is not priced yet"];
    (r.budget as unknown as { estimatorBlockers: string[] }).estimatorBlockers = [];
    const w = buildWorkspace({ ...r, facts: facts({ confirmedCents: 10_000 }) });
    expect(w.summary.totalKind).toBe("partial");
    expect(w.next.kind).toBe("wait_rep_items");
    expect(w.next.button).toBeNull();
    expect(w.summary.blockers).toEqual(["The quotation is incomplete: Something is not priced yet"]);
  });
  it("every blocker is listed in order and the next action is the first one", () => {
    const w = buildWorkspace({ ...priced({ required: 2, verified: 1 }), facts: facts({ confirmedCents: 5_000 }) });
    expect(w.summary.blockers).toEqual(["Amount differs from the Rep's confirmation", "Costs not independently verified"]);
    expect(w.next.kind).toBe("return_to_rep");
  });
});
