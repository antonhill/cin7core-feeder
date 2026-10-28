import type { PriceSnapshot, SnapshotEntry } from "../workbook-price-source";
import { createWorkbookPriceSource } from "../workbook-price-source";

// SYNTHETIC TEST DATA — NOT the NewQuip Master workbook. These numbers exist only so the tests can exercise the pricing
// mechanics (landed cost, +20%, zero handling) deterministically. They are never used by the application.

const e = (sku: string, cost: number, roe: number, freight: number, mu: number, retailOverride?: number): SnapshotEntry => ({
  sku, description: sku, cost, roe, freight, mu,
  retailExVat: retailOverride ?? Math.round(cost * roe * freight * mu * 100) / 100,
});

export const TEST_SNAPSHOT: PriceSnapshot = {
  id: "test-synthetic",
  label: "NewQuip Master workbook – POC controlled snapshot",
  sourceFile: "SYNTHETIC-TEST-FIXTURE.xlsx",
  sourceSheet: "Master",
  sourceDate: "2026-10-05",
  sha256: null,
  entries: Object.fromEntries([
    e("SYSH-2750-3", 100000, 1, 1.2, 1.4), // landed 120,000 · retail 168,000 · project 144,000
    e("PNQ082", 1000, 1, 1.2, 1.4), // landed 1,200 · retail 1,680 · project 1,440
    e("PNQ082-WINDOW", 1100, 1, 1.2, 1.4), // landed 1,320 · retail 1,848 · project 1,584
    e("ERT053", 500, 1, 1.2, 1.4),
    e("NQ1161", 150, 1, 1.2, 1.4),
    e("QCA00003", 20, 1, 1.2, 1.4), e("NQ1380", 15, 1, 1.2, 1.4), e("NQ2784", 5, 1, 1.2, 1.4), e("NQ2886", 12, 1, 1.2, 1.4),
    e("NQ1386", 2, 1, 1.2, 1.4), e("NYNUT", 1, 1, 1.2, 1.4), e("NQ1017", 1, 1, 1.2, 1.4),
    e("NQ2114", 800, 1, 1.2, 1.4),
    e("NQ3132", 0, 1, 1, 1, 0), // the Master shows Retail 0 for NQ3132
  ].map((x) => [x.sku, x])),
};

export const testPriceSource = () => createWorkbookPriceSource(TEST_SNAPSHOT);
