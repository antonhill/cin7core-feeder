import { describe, expect, it } from "vitest";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { evaluateDraft } from "../evaluate";
import { emptyDraft, type QuoteDraft } from "../draft";
import { DEMO_DEFAULTS, applyDemoDefaults, demoDifferences, hasEntries } from "../demo-defaults";
import { buildMarginSheet } from "../../quote/margin";
import { readyDraft } from "./golden";

const source = () => createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT);
const ev = (d: QuoteDraft, withholdCost = false) => evaluateDraft(d, { priceSource: source(), withholdCost });

describe("Load Demo Defaults", () => {
  it("loads into a draft with a selected customer: complete, READY, with calculated prices, costs, margins, VAT and totals; WITHOUT a customer it is not READY (the demo never supplies one)", () => {
    expect(ev(applyDemoDefaults(emptyDraft()).draft).readiness.state).not.toBe("READY");
    const start = emptyDraft(); start.customerName = "Spark";
    const { draft, replaced } = applyDemoDefaults(start);
    expect(replaced.length).toBeGreaterThan(5);
    const e = ev(draft);
    expect(e.calc.valid).toBe(true);
    expect(e.readiness.state).toBe("READY");
    const b = e.budget!;
    expect(b.incomplete).toBe(false);
    expect(b.state).toBe("complete");
    expect(b.totals.subtotalExTax).toBeGreaterThan(0);
    expect(b.totals.taxTotal).toBeCloseTo(b.totals.subtotalExTax * 0.15, 2);
    expect(b.totals.totalIncTax).toBeCloseTo(b.totals.subtotalExTax * 1.15, 2);
    const sheet = buildMarginSheet(b);
    expect(sheet.sections.length).toBeGreaterThan(0);
    expect(sheet.lines.some((l) => l.costCents !== null && l.marginPct !== null)).toBe(true);
    expect(sheet.reportingBasis).toMatch(/PROVISIONAL/);
  });
  it("reproduces yesterday's demonstration quote NQ-Q-0001: R10,000,000.00 ex VAT, the amount the customer confirmed and the manager approved", () => {
    const b = ev(applyDemoDefaults(emptyDraft()).draft).budget!;
    expect(Math.round(b.totals.subtotalExTax * 100)).toBe(1_000_000_000);
  });
  it("uses the recovered inputs verbatim (spot checks); the demonstration's own customer name is kept as a constant but never loaded", () => {
    const d = applyDemoDefaults(emptyDraft()).draft;
    expect(DEMO_DEFAULTS.customerName).toBe("Test Customer");
    expect(d.siteName).toBe("Test Farm 1");
    expect(d.quoteType).toBe("day_to_day");
    expect(d.config).toMatchObject({ lengthM: 49.5, widthM: 14.43, rooms: 12, totalPens: 20, hospitalPens: 2, pigsPerRoom: 600, slattedFloorAreaM2: 120, penningPigSize: "SMALL", penningRunningMetresPerRoom: 20 });
    expect(d.config.estimatorQuantities).toMatchObject({ feeder: 18, concrete_slat: 1320, cup_drinker: 54, cone_fans: 4, pad_cooling: 3 });
    expect(d.estimator.charges).toEqual({ delivery: 979_992, installation: 1_200_000, concrete_slat_delivery: 250_000 });
    expect(d.estimator.unitPrices).toEqual({ flex_auger: 45_000 });
    expect(d.estimator.confirmedMappings).toMatchObject({ feeder: "PNQ082", bulk_tank: "SYSH-2750-3", concrete_slat: "NQ1161" });
    expect(Object.keys(d.estimator.priceResolutions).sort()).toEqual(["concrete_slat", "cup_drinker", "feed_saver_mat", "led_light", "pvc_door"]);
  });
  it("estimator price resolutions stay LABELLED as POC manual overrides, and nothing is left supplier-quote-required or unmapped", () => {
    const b = ev(applyDemoDefaults(emptyDraft()).draft).budget!;
    const overridden = b.lines.filter((l) => l.pricedBy === "estimator_resolution").map((l) => l.itemKey).sort();
    expect(overridden).toEqual(["concrete_slat", "cup_drinker", "feed_saver_mat", "led_light", "pvc_door"]);
    for (const l of b.lines.filter((x) => x.status !== "not_selected")) expect(["priced"]).toContain(l.status);
    expect(b.blockers).toEqual([]);
    expect(b.lines.filter((l) => l.pricedBy === "estimator_resolution").every((l) => /POC MANUAL PRICE OVERRIDE/.test(l.reason))).toBe(true);
  });
  it("is REPEATABLE: applying twice gives the identical draft, with no duplicated products, sections or charges", () => {
    const once = applyDemoDefaults(emptyDraft()).draft;
    const twice = applyDemoDefaults(once);
    expect(twice.draft).toEqual(once);
    expect(twice.replaced).toEqual([]);
    const a = ev(once).budget!; const b = ev(twice.draft).budget!;
    expect(b.lines.map((l) => l.itemKey)).toEqual(a.lines.map((l) => l.itemKey));
    expect(b.totals).toEqual(a.totals);
    expect(b.charges).toEqual(a.charges);
  });
  it("replaces someone's entries (and names what it replaced) but never mutates its input or the shared constant", () => {
    const mine = readyDraft({ customerName: "Real Customer" });
    const before = structuredClone(mine);
    const r = applyDemoDefaults(mine);
    expect(mine).toEqual(before);
    expect(r.draft.customerName).toBe("Real Customer"); // the selected customer is NOT part of the demo
    expect(r.draft.siteName).toBe("Test Farm 1");
    expect(r.replaced).not.toContain("Customer and site");
    r.draft.config.rooms = 99; r.draft.estimator.charges.delivery = 1;
    expect(DEMO_DEFAULTS.config.rooms).toBe(12);
    expect(DEMO_DEFAULTS.estimator.charges.delivery).toBe(979_992);
    expect(Object.isFrozen(DEMO_DEFAULTS)).toBe(true);
  });
  it("a confirmation is needed only when the draft holds entries; a blank draft needs none", () => {
    expect(hasEntries(emptyDraft())).toBe(false);
    expect(hasEntries(readyDraft())).toBe(true);
    const d = emptyDraft(); d.customerName = "x";
    expect(hasEntries(d)).toBe(false); // a selected customer alone is kept by the load, so nothing would be replaced
    d.siteName = "Plaas";
    expect(hasEntries(d)).toBe(true);
    expect(demoDifferences(applyDemoDefaults(emptyDraft()).draft)).toEqual([]);
  });
  it("audited internal cost overrides are preserved; nothing else is carried over", () => {
    const d = readyDraft();
    d.estimator.costOverrides = { delivery: { lineCostCents: 5, reason: "own trucks", by: "m@x", at: "2026-10-28T00:00:00Z" } };
    const r = applyDemoDefaults(d).draft;
    expect(r.estimator.costOverrides).toEqual(d.estimator.costOverrides);
    expect(r.estimator.costOverrides).not.toBe(d.estimator.costOverrides);
    expect(applyDemoDefaults(emptyDraft()).draft.estimator.costOverrides).toBeUndefined();
  });
  it("produces a draft that the existing approval-time rules accept (no field is silently zero)", () => {
    const d = applyDemoDefaults(emptyDraft()).draft;
    for (const k of ["lengthM", "widthM", "rooms", "totalPens", "pigsPerRoom"] as const) expect(d.config[k]).toBeGreaterThan(0);
    const e = ev(d, true); // a non-manager's view: cost withheld, same prices
    expect(Math.round(e.budget!.totals.subtotalExTax * 100)).toBe(1_000_000_000);
    expect(e.budget!.lines.every((l) => l.estimatedCost === null)).toBe(true);
  });
});

// The saved draft of yesterday's demonstration quote NQ-Q-0001, exactly as read (SELECT only) from the hosted NewQuip POC organisation on
// 2026-10-28. The demo defaults must equal it field for field (the one difference: the customer name's accidental trailing space).
const YESTERDAYS_SAVED_DRAFT = JSON.parse(`{"config": {"rooms": 12, "widthM": 14.43, "lengthM": 49.5, "totalPens": 20, "exclusions": {}, "pigsPerRoom": 600, "hospitalPens": 2, "feederVariant": "STANDARD", "penningPigSize": "SMALL", "optionalEquipment": {"cone_fans": false, "controller": false, "manure_plug": false, "pad_cooling": false, "control_panel": false, "silo_weighing": false, "emergency_windows": false}, "quantityOverrides": {"led_light": 38, "feed_saver_mat": 18}, "selectedFeederType": "CCM", "slattedFloorAreaM2": 120, "estimatorQuantities": {"feeder": 18, "pvc_door": 2, "bulk_tank": 1, "cone_fans": 4, "controller": 2, "flex_auger": 1, "cup_drinker": 54, "manure_plug": 2, "pad_cooling": 3, "concrete_slat": 1320, "control_panel": 2, "silo_weighing": 2, "emergency_windows": 2}, "selectedDrinkerType": "CUP_NEW", "selectedPenningType": "PP_GREEN_VENTED", "selectedFlooringType": "CONCRETE_1200X450X70", "selectedLightingType": "FORTIS_1_2_5000K", "quantityOverrideReasons": {"led_light": "Test", "feed_saver_mat": "Test"}, "penningRunningMetresPerRoom": 20}, "siteName": "Test Farm 1", "estimator": {"charges": {"delivery": 979992, "installation": 1200000, "concrete_slat_delivery": 250000}, "unitPrices": {"flex_auger": 45000}, "assumptions": "Test", "priceResolutions": {"pvc_door": {"reason": "Master workbook has no usable price. Temporary POC estimator value only.", "unitPriceExVat": 3000}, "led_light": {"reason": "Master workbook has no usable price. Temporary POC estimator value only.", "unitPriceExVat": 881}, "cup_drinker": {"reason": "Master workbook has no usable price. Temporary POC estimator value only.", "unitPriceExVat": 548}, "concrete_slat": {"reason": "Master workbook has no usable price. Temporary POC estimator value only.", "unitPriceExVat": 203}, "feed_saver_mat": {"reason": "Master workbook has no usable price. Temporary POC estimator value only.", "unitPriceExVat": 919}}, "confirmedMappings": {"feeder": "PNQ082", "pvc_door": "NQ2114", "bulk_tank": "SYSH-2750-3", "concrete_slat": "NQ1161", "feed_saver_mat": "ERT053"}, "confirmedPackages": ["cup_drinker", "led_light"]}, "quoteType": "day_to_day", "customerName": "Test Customer "}`);

describe("the selected customer is kept", () => {
  it("select a customer first, then load the demo: the customer is unchanged and everything else is the demonstration; repeating changes nothing", () => {
    const picked = emptyDraft(); picked.customerName = "Spark";
    const once = applyDemoDefaults(picked);
    expect(once.draft.customerName).toBe("Spark");
    expect({ ...once.draft, customerName: "" }).toEqual({ ...applyDemoDefaults(emptyDraft()).draft });
    expect(applyDemoDefaults(once.draft).draft).toEqual(once.draft);
    expect(once.replaced).not.toContain("Customer and site");
  });
  it("a blank customer stays blank (the demo never invents one) and a customer is never overwritten with 'Test Customer'", () => {
    expect(applyDemoDefaults(emptyDraft()).draft.customerName).toBe("");
    for (const name of ["Spark", "Test Customer ", "Boerdery (Pty) Ltd"]) { const d = emptyDraft(); d.customerName = name; expect(applyDemoDefaults(d).draft.customerName).toBe(name); }
  });
});

describe("against yesterday's actual demonstration data", () => {
  it("the loaded draft equals NQ-Q-0001's saved draft field for field (customer name trimmed)", () => {
    const loaded = applyDemoDefaults(emptyDraft()).draft;
    expect(loaded).toEqual({ ...YESTERDAYS_SAVED_DRAFT, customerName: "" }); // the customer is the one selected on the quotation (blank here), never the demo's
  });
  it("and evaluates to the same R10,000,000.00 ex VAT that was confirmed and approved", () => {
    const fromSaved = ev(YESTERDAYS_SAVED_DRAFT).budget!;
    const fromDemo = ev(applyDemoDefaults(emptyDraft()).draft).budget!;
    expect(fromDemo.totals).toEqual(fromSaved.totals);
    expect(Math.round(fromDemo.totals.subtotalExTax * 100)).toBe(1_000_000_000);
  });
});

describe("the button only edits the draft in the editor", () => {
  it("is shown only to users who can edit, asks one confirmation when entries exist, and calls no server action, save, approval or Cin7 path", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/../../../app/newquip-grower/[id]/page.tsx`, "utf8");
    expect(src).toMatch(/\{editable && !confirmDemo && <Button[\s\S]*?Load Demo Defaults<\/Button>\}/);
    expect(src).toMatch(/hasEntries\(draft\) \? setConfirmDemo\(true\) : loadDemo\(\)/);
    const body = /function loadDemo\(\) \{([\s\S]*?)\n  \}/.exec(src)![1];
    expect(body).not.toMatch(/Action\(|save\(|act\(|fetch|cin7|Cin7|approve|createProject/);
    expect(body).toMatch(/applyDemoDefaults\(draft!\)/);
  });
});
