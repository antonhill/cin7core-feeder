import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../evaluate";
import { blankExclusions, createRecalcLoop, latestOnly, PENDING_EXCLUSION_REASON, previewDraftOf } from "../preview-draft";
import { buildMarginSheet } from "../../quote/margin";
import { readyDraft } from "./golden";
import { testPriceSource } from "./test-snapshot";

// UAT-003: ticking or clearing "Exclude" must change the quotation figures at once, from the SAME engine that Save uses, and never be persisted by the preview.
const ctx = { priceSource: testPriceSource(), withholdCost: false };
const figures = (d: ReturnType<typeof readyDraft>) => {
  const ev = evaluateDraft(d, ctx);
  const b = ev.budget!;
  return { subtotal: b.totals.subtotalExTax, vat: b.totals.taxTotal, total: b.totals.totalIncTax, lines: b.lines.map((l) => [l.itemKey, l.status, l.revenueExTax]), margin: JSON.stringify(buildMarginSheet(b, {})) };
};
const withExclusion = (key: string, reason: string) => { const d = readyDraft(); d.config.exclusions = { [key]: reason } as never; return d; };
const KEY = "feed_saver_mat";

describe("a ticked exclusion applies in the preview before its reason is typed", () => {
  it("the plain engine ignores a blank-reason exclusion (the trap UAT-003 hit); the preview applies it", () => {
    const base = figures(readyDraft());
    const blank = withExclusion(KEY, "");
    expect(blankExclusions(blank)).toEqual([KEY]);
    expect(figures(blank).subtotal).toBe(base.subtotal);
    const previewed = figures(previewDraftOf(blank));
    expect(previewed.subtotal).toBeLessThan(base.subtotal);
    expect(previewed.total).toBeLessThan(base.total);
    expect(previewed.margin).not.toBe(base.margin);
  });
  it("the preview does not mutate the draft it was given", () => {
    const blank = withExclusion(KEY, "");
    previewDraftOf(blank);
    expect(blank.config.exclusions?.[KEY as never]).toBe("");
  });
  it("preview and saved figures are identical once a reason exists: same selling price, VAT, total, lines and margins", () => {
    const saved = figures(withExclusion(KEY, "Customer supplies their own"));
    const previewed = figures(previewDraftOf(withExclusion(KEY, "")));
    expect(previewed).toEqual(saved);
    expect(PENDING_EXCLUSION_REASON.trim().length).toBeGreaterThan(0);
  });
});

describe("exclusion, re-inclusion and several changes", () => {
  it("re-including restores the original figures exactly", () => {
    const base = figures(readyDraft());
    const again = readyDraft();
    again.config.exclusions = { [KEY]: "" } as never;
    expect(figures(previewDraftOf(again)).subtotal).toBeLessThan(base.subtotal);
    delete (again.config.exclusions as Record<string, string>)[KEY];
    expect(figures(previewDraftOf(again))).toEqual(base);
  });
  it("several exclusions compound, in any order, and clearing one leaves the others", () => {
    const keys = [KEY, "concrete_slat"];
    const base = figures(readyDraft()).subtotal;
    const one = figures(previewDraftOf(withExclusion(keys[0], ""))).subtotal;
    const both = (order: string[]) => { const d = readyDraft(); d.config.exclusions = Object.fromEntries(order.map((k) => [k, ""])) as never; return figures(previewDraftOf(d)); };
    expect(both(keys).subtotal).toBeLessThan(one);
    expect(one).toBeLessThan(base);
    expect(both(keys)).toEqual(both([...keys].reverse()));
    const d = readyDraft(); d.config.exclusions = Object.fromEntries(keys.map((k) => [k, ""])) as never;
    delete (d.config.exclusions as Record<string, string>)[keys[1]];
    expect(figures(previewDraftOf(d)).subtotal).toBe(one);
  });
  it("a mix of explained and unexplained exclusions previews as if every one were explained", () => {
    const d = readyDraft(); d.config.exclusions = { [KEY]: "Customer supplies", concrete_slat: "" } as never;
    const e = readyDraft(); e.config.exclusions = { [KEY]: "Customer supplies", concrete_slat: "Existing slats stay" } as never;
    expect(figures(previewDraftOf(d))).toEqual(figures(e));
  });
});

describe("rapid consecutive changes never leave stale totals", () => {
  it("only the newest request's answer is applied, whatever order answers arrive in", () => {
    const g = latestOnly();
    const applied: string[] = [];
    const answer = (ticket: number, label: string) => { if (g.isCurrent(ticket)) applied.push(label); };
    const t1 = g.next(); const t2 = g.next(); const t3 = g.next();
    answer(t3, "third"); answer(t1, "first"); answer(t2, "second");
    expect(applied).toEqual(["third"]);
  });
  it("a save or reload (which takes a ticket too) discards a recalculation still in flight", () => {
    const g = latestOnly();
    const inFlight = g.next();
    g.next(); // the save adopts the server's figures
    expect(g.isCurrent(inFlight)).toBe(false);
  });
});

describe("single-flight recalculation (server actions run one at a time, slowly)", () => {
  const slow = (log: string[], ms = 20) => async (d: string) => { log.push(`start ${d}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${d}`); return d.toUpperCase(); };
  it("never has two requests in flight; edits made meanwhile collapse into one follow-up for the NEWEST draft, and every answer is applied", async () => {
    const log: string[] = []; const shown: string[] = [];
    const loop = createRecalcLoop(slow(log), { onResult: (_d, r) => shown.push(r), onError: () => undefined });
    loop.request("a"); loop.request("b"); loop.request("c"); loop.request("d");
    await new Promise((r) => setTimeout(r, 120));
    expect(log).toEqual(["start a", "end a", "start d", "end d"]);
    expect(shown).toEqual(["A", "D"]);
  });
  it("cancel (a save or reload) discards the answer still in flight and the pending follow-up", async () => {
    const log: string[] = []; const shown: string[] = [];
    const loop = createRecalcLoop(slow(log), { onResult: (_d, r) => shown.push(r), onError: () => undefined });
    loop.request("a"); loop.request("b");
    loop.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(shown).toEqual([]);
    loop.request("c");
    await new Promise((r) => setTimeout(r, 60));
    expect(shown).toEqual(["C"]);
  });
  it("a failure is reported for its draft and does not stop later requests", async () => {
    const errors: string[] = []; const shown: string[] = [];
    const loop = createRecalcLoop(async (d: string) => { if (d === "bad") throw new Error("boom"); return d; }, { onResult: (_d, r) => shown.push(r), onError: (d) => errors.push(d) });
    loop.request("bad"); await new Promise((r) => setTimeout(r, 10));
    loop.request("ok"); await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(["bad"]); expect(shown).toEqual(["ok"]);
  });
});
