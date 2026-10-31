import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildSynth } from "@/rwtsa-demo/__tests__/helpers";
import { buildSyntheticWorkbook } from "@/rwtsa-demo/fixtures/synthetic";
import { TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("AT-10: synthetic fixture generator", () => {
  it("is deterministic per seed and differs across seeds", async () => {
    const a = await buildSynth({ seed: 1 });
    const b = await buildSynth({ seed: 1 });
    const c = await buildSynth({ seed: 2 });
    expect(a.dataset!.reconciliation.controlHash).toBe(b.dataset!.reconciliation.controlHash);
    expect(a.dataset!.reconciliation.controlHash).not.toBe(c.dataset!.reconciliation.controlHash);
  });

  it("produces all 11 contract tabs and nothing that is not obviously synthetic", () => {
    const { workbook } = buildSyntheticWorkbook();
    expect(workbook.worksheets.map((w) => w.name)).toEqual([...TAB_NAMES]);
    const idCols: Record<string, string[]> = { Items: ["SKU", "Style code"], ImportPOs: ["Supplier", "PO no"], Customers: ["Customer"], Quotes: ["Customer", "Quote"] };
    for (const [tab, headers] of Object.entries(idCols)) {
      const ws = workbook.getWorksheet(tab)!;
      for (const h of headers) {
        const col = (ws.getRow(1).values as ExcelJS.CellValue[]).indexOf(h);
        for (let r = 2; r <= ws.rowCount; r++) expect(String(ws.getRow(r).getCell(col).value)).toMatch(/^(SYN|PO-SYN|Q-SYN)/);
      }
    }
  });

  it("supports the agreed demo scope (3 styles x 8 sizes) and the full 6-style shape", async () => {
    expect((await buildSynth({ styleCount: 3 })).dataset!.tables.items).toHaveLength(24);
    expect((await buildSynth({ styleCount: 6 })).dataset!.tables.items).toHaveLength(48);
  });

  it("plants a tender spike on exactly one style that the brief's anomaly rule (>5x median and >40) catches", async () => {
    const { planted } = buildSyntheticWorkbook();
    const r = await buildSynth();
    const d = r.dataset!;
    const flagged = new Set<string>();
    const bySku = new Map<string, { month: string; qty: number | null }[]>();
    for (const p of d.tables.salesHistory) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p]);
    for (const [sku, series] of bySku) {
      const med = median(series.map((p) => p.qty as number));
      for (const p of series) if (p.qty! > 5 * med && p.qty! > 40) flagged.add(`${sku}|${p.month}`);
    }
    const styleOf = new Map(d.tables.items.map((i) => [i.sku, i.styleCode]));
    const flaggedStyles = new Set([...flagged].map((k) => styleOf.get(k.split("|")[0])));
    expect(flaggedStyles).toEqual(new Set([planted.tenderSpike.styleCode])); // no false positives on other styles
    expect([...flagged].every((k) => k.endsWith(`|${planted.tenderSpike.month}`))).toBe(true);
    expect(flagged.size).toBe(8); // all eight sizes of the spike style
  });

  it("plants the tender SKU (no standing level), the overdue PO, shared and split shipments, the deposit, the size-varying BOM, bracketed orders and lost quotes", async () => {
    const { planted } = buildSyntheticWorkbook();
    const t = (await buildSynth()).dataset!.tables;

    const tender = t.items.find((i) => i.sku === planted.tenderSku)!;
    expect(tender.isTender).toBe(true);
    expect(tender.minLevel).toBeNull();

    const overdue = t.importPos.find((p) => p.poNo === planted.overduePoNo)!;
    expect(overdue.status).toBe("On the water");
    expect(overdue.etaStores < planted.stockDate).toBe(true);

    const shared = t.importPos.filter((p) => p.shipmentRef === planted.sharedShipmentRef).map((p) => p.poNo).sort();
    expect(shared).toEqual([...planted.sharedShipmentPoNos].sort());

    const shipmentsForSku = new Set(t.landedCost.filter((l) => l.sku === planted.skuInTwoShipments).map((l) => l.shipmentRef));
    expect(shipmentsForSku.size).toBe(2);

    const payments = t.paymentsFec.filter((p) => p.poNo === planted.depositPoNo);
    expect(payments.some((p) => p.isDeposit === true)).toBe(true);
    expect(payments.some((p) => p.isDeposit === false)).toBe(true);

    expect(t.bom.some((b) => b.styleCode === planted.sizeVaryingBom.styleCode && b.componentCode === planted.sizeVaryingBom.componentCode && b.sizeFrom === planted.sizeVaryingBom.sizeFrom)).toBe(true);

    const qtys = t.productionOrders.map((o) => o.qty);
    expect(Math.min(...qtys)).toBeLessThan(100);
    expect(Math.max(...qtys)).toBeGreaterThan(2000);
    expect(new Set(t.productionOrders.map((o) => o.productionLine)).size).toBe(2);

    const lost = t.quotes.filter((q) => q.status === "lost");
    expect(lost).toHaveLength(planted.lostQuoteCount);
    expect(lost.every((q) => q.lostReason !== null)).toBe(true);
  });

  it("ends sales history before the stock date, as the brief describes", async () => {
    const { planted } = buildSyntheticWorkbook();
    const r = await buildSynth();
    expect(`${r.dataset!.months.at(-1)}-31` < planted.stockDate).toBe(true);
  });
});
