import { describe, expect, it } from "vitest";
import { LIMITS } from "@/rwtsa-demo/fastreact/contract";
import {
  RETURN_FIELDS,
  RETURN_FORMAT_LABEL,
  buildSampleReturn,
  parseReturnFile,
  type ReturnOrderRef,
} from "@/rwtsa-demo/fastreact/return-format";
import { applyPlan, planReturn, type StoredReturns, EMPTY_RETURNS } from "@/rwtsa-demo/fastreact/return-reconcile";
import { sha256Text } from "@/rwtsa-demo/fastreact/return-format";

const NOW = new Date("2026-11-05T12:00:00Z");
const ORDERS: ReturnOrderRef[] = [
  { orderNo: "PO-1", qty: 1000 },
  { orderNo: "PO-2", qty: 300 },
];
const HEAD = RETURN_FIELDS.map((f) => f.code);
const row = (o: Partial<Record<string, string>> = {}): string[] => {
  const base: Record<string, string> = {
    "SPK.ORDER": "PO-1",
    "SPK.LINE": "Line 1",
    "SPK.SECT": "",
    "SPK.START": "2026-11-02",
    "SPK.END": "2026-11-20",
    "SPK.DELIVERY": "",
    "SPK.STATUS": "IN_PROGRESS",
    "SPK.QTYDONE": "400",
    "SPK.UPDATED": "2026-11-05T08:00:00Z",
    ...o,
  };
  return HEAD.map((h) => base[h] ?? "");
};
const tab = (rows: string[][], head: string[] = HEAD) => [head, ...rows].map((r) => r.join("\t")).join("\r\n") + "\r\n";

describe("proposed return format", () => {
  it("is labelled as Spark's demonstration format, never a Fast React export", () => {
    expect(RETURN_FORMAT_LABEL).toMatch(/SPARK-PROPOSED DEMONSTRATION FORMAT/);
    expect(RETURN_FORMAT_LABEL).toMatch(/not a Fast React/i);
  });
  it("uses codes that cannot be mistaken for the vendor's", () => {
    for (const f of RETURN_FIELDS) expect(f.code).toMatch(/^SPK\.[A-Z]+$/);
  });
  it("makes the smallest useful set mandatory", () => {
    expect(RETURN_FIELDS.filter((f) => f.required).map((f) => f.code)).toEqual([
      "SPK.ORDER", "SPK.LINE", "SPK.START", "SPK.END", "SPK.STATUS", "SPK.QTYDONE", "SPK.UPDATED",
    ]);
  });
});

describe("parsing", () => {
  it("parses a tab-separated file", () => {
    const p = parseReturnFile(tab([row()]));
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].values["SPK.ORDER"]).toBe("PO-1");
    expect(p.delimiter).toBe("tab");
  });
  it("parses quoted CSV including doubled quotes", () => {
    const csv = [HEAD.map((h) => `"${h}"`).join(","), row({ "SPK.LINE": 'Line "A", 1' }).map((c) => `"${c.replace(/"/g, '""')}"`).join(",")].join("\n");
    const p = parseReturnFile(csv);
    expect(p.fileErrors).toEqual([]);
    expect(p.rows[0].values["SPK.LINE"]).toBe('Line "A", 1');
    expect(p.delimiter).toBe("csv");
  });
  it("tolerates a byte-order mark and LF line endings", () => {
    const p = parseReturnFile("﻿" + tab([row()]).replace(/\r\n/g, "\n"));
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(1);
  });
  it("refuses an empty file, a header-only file and a missing required column", () => {
    expect(parseReturnFile("").fileErrors.length).toBeGreaterThan(0);
    expect(parseReturnFile(HEAD.join("\t") + "\r\n").fileErrors.join(" ")).toMatch(/no data rows/i);
    expect(parseReturnFile(tab([["PO-1"]], ["SPK.ORDER"])).fileErrors.join(" ")).toMatch(/missing required column/i);
  });
  it("refuses an unknown or duplicated column", () => {
    expect(parseReturnFile(tab([[...row(), "x"]], [...HEAD, "O.CODE"])).fileErrors.join(" ")).toMatch(/unknown column/i);
    expect(parseReturnFile(tab([[...row(), "x"]], [...HEAD, "SPK.ORDER"])).fileErrors.join(" ")).toMatch(/duplicate column/i);
  });
  it("refuses an oversized file and too many rows before parsing", () => {
    expect(parseReturnFile("x".repeat(LIMITS.maxReturnBytes + 1)).fileErrors.join(" ")).toMatch(/too large/i);
    const many = tab(Array.from({ length: LIMITS.maxReturnRows + 1 }, (_, i) => row({ "SPK.ORDER": `P${i}` })));
    expect(parseReturnFile(many).fileErrors.join(" ")).toMatch(/too many rows/i);
  });
  it("refuses NUL bytes and invalid characters", () => {
    expect(parseReturnFile(tab([row()]) + "\u0000").fileErrors.length).toBeGreaterThan(0);
  });
  it("reports a ragged row without throwing", () => {
    const p = parseReturnFile(HEAD.join("\t") + "\r\nPO-1\tLine 1\r\n");
    expect(p.rows[0].parseError).toMatch(/columns/i);
  });
  it("does not echo file content into file-level errors", () => {
    const p = parseReturnFile(tab([row({ "SPK.ORDER": "SECRET-ORDER" })], [...HEAD.slice(0, -1), "SECRETCOL"]));
    expect(p.fileErrors.join(" ")).not.toMatch(/SECRET/);
  });
});

describe("row validation and planning", () => {
  const plan = (rows: string[][], stored: StoredReturns = EMPTY_RETURNS, orders = ORDERS) => planReturn(parseReturnFile(tab(rows)), orders, stored, { now: NOW, fileHash: "h1" });
  const only = (rows: string[][], stored?: StoredReturns) => plan(rows, stored).rows[0];

  it("accepts a valid row as NEW", () => {
    const r = only([row()]);
    expect(r.outcome).toBe("NEW");
    expect(r.reasons).toEqual([]);
    expect(r.accepted).toBe(true);
  });
  it("rejects an order that does not exist locally", () => {
    expect(only([row({ "SPK.ORDER": "NOPE" })])).toMatchObject({ outcome: "REJECTED" });
    expect(only([row({ "SPK.ORDER": "NOPE" })]).reasons.join(" ")).toMatch(/unknown order/i);
  });
  it("matches order references ignoring case", () => {
    expect(only([row({ "SPK.ORDER": "po-1" })]).outcome).toBe("NEW");
  });
  it("rejects invalid dates, reversed dates and bad timestamps", () => {
    expect(only([row({ "SPK.START": "2026-02-30" })]).outcome).toBe("REJECTED");
    expect(only([row({ "SPK.START": "2026-11-21", "SPK.END": "2026-11-20" })]).reasons.join(" ")).toMatch(/start.*after/i);
    expect(only([row({ "SPK.UPDATED": "yesterday" })]).outcome).toBe("REJECTED");
    expect(only([row({ "SPK.UPDATED": "2026-11-05T08:00:00" })]).outcome).toBe("REJECTED"); // must be UTC with Z
    expect(only([row({ "SPK.DELIVERY": "31/12/2026" })]).outcome).toBe("REJECTED");
  });
  it("rejects a timestamp more than five minutes in the future", () => {
    expect(only([row({ "SPK.UPDATED": "2026-11-05T12:10:00Z" })]).reasons.join(" ")).toMatch(/future/i);
    expect(only([row({ "SPK.UPDATED": "2026-11-05T12:03:00Z" })]).outcome).toBe("NEW");
    expect(only([row({ "SPK.QTYDONE": "2147483648" })]).outcome).toBe("REJECTED");
  });
  it("rejects invalid quantities and quantities above the ordered quantity", () => {
    for (const q of ["-1", "1.5", "abc", "", "1e3"]) expect(only([row({ "SPK.QTYDONE": q })]).outcome, q).toBe("REJECTED");
    expect(only([row({ "SPK.QTYDONE": "1001" })]).reasons.join(" ")).toMatch(/exceeds/i);
    expect(only([row({ "SPK.QTYDONE": "1000", "SPK.STATUS": "COMPLETE" })]).outcome).toBe("NEW");
  });
  it("rejects an unknown status and a PLANNED row that reports output", () => {
    expect(only([row({ "SPK.STATUS": "DONE" })]).outcome).toBe("REJECTED");
    expect(only([row({ "SPK.STATUS": "PLANNED", "SPK.QTYDONE": "5" })]).reasons.join(" ")).toMatch(/planned.*output/i);
    expect(only([row({ "SPK.STATUS": "PLANNED", "SPK.QTYDONE": "0" })]).outcome).toBe("NEW");
  });
  it("warns, without rejecting, when a row is COMPLETE below the ordered quantity", () => {
    const r = only([row({ "SPK.STATUS": "COMPLETE", "SPK.QTYDONE": "900" })]);
    expect(r.outcome).toBe("NEW");
    expect(r.warnings.join(" ")).toMatch(/short/i);
  });
  it("refuses unsafe text in line and section", () => {
    expect(only([row({ "SPK.LINE": "=HYPERLINK()" })]).outcome).toBe("REJECTED");
    expect(only([row({ "SPK.LINE": "X".repeat(16) })]).outcome).toBe("REJECTED");
  });
  it("marks a later update for a known order UPDATED, with a change list", () => {
    const first = plan([row()]);
    const state = applyPlan(EMPTY_RETURNS, first, { appliedAt: "2026-11-05T09:00:00Z", fileHash: "h1", sourceKind: "synthetic-sample" });
    const second = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "700", "SPK.UPDATED": "2026-11-05T10:00:00Z" })])), ORDERS, state, { now: NOW, fileHash: "h2" });
    expect(second.rows[0].outcome).toBe("UPDATED");
    expect(second.rows[0].changes.map((c) => c.field)).toContain("SPK.QTYDONE");
  });
  it("marks an older update STALE and rejects it", () => {
    const state = applyPlan(EMPTY_RETURNS, plan([row()]), { appliedAt: "x", fileHash: "h1", sourceKind: "upload" });
    const r = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "100", "SPK.UPDATED": "2026-11-05T07:00:00Z" })])), ORDERS, state, { now: NOW, fileHash: "h2" }).rows[0];
    expect(r.outcome).toBe("STALE");
    expect(r.accepted).toBe(false);
  });
  it("marks the same timestamp with different content a CONFLICT", () => {
    const state = applyPlan(EMPTY_RETURNS, plan([row()]), { appliedAt: "x", fileHash: "h1", sourceKind: "upload" });
    const r = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "401" })])), ORDERS, state, { now: NOW, fileHash: "h2" }).rows[0];
    expect(r.outcome).toBe("CONFLICT");
    expect(r.accepted).toBe(false);
  });
  it("treats a newer update that lowers completed quantity, or reopens a completed order, as a CONFLICT", () => {
    const done = applyPlan(EMPTY_RETURNS, plan([row({ "SPK.STATUS": "COMPLETE", "SPK.QTYDONE": "1000" })]), { appliedAt: "x", fileHash: "h1", sourceKind: "upload" });
    const lower = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "500", "SPK.UPDATED": "2026-11-05T11:00:00Z" })])), ORDERS, done, { now: NOW, fileHash: "h2" }).rows[0];
    expect(lower.outcome).toBe("CONFLICT");
    expect(lower.reasons.join(" ")).toMatch(/lower|reopen|regress/i);
  });
  it("a newer update that lowers the completed quantity, on its own, is a CONFLICT", () => {
    const state = applyPlan(EMPTY_RETURNS, plan([row({ "SPK.QTYDONE": "400" })]), { appliedAt: "x", fileHash: "h1", sourceKind: "upload" });
    const r = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "300", "SPK.UPDATED": "2026-11-05T11:00:00Z" })])), ORDERS, state, { now: NOW, fileHash: "h2" }).rows[0];
    expect(r.outcome).toBe("CONFLICT");
    expect(r.reasons.join(" ")).toMatch(/lower/i);
  });
  it("a newer update that reopens a COMPLETE order with the same quantity, on its own, is a CONFLICT", () => {
    const done = applyPlan(EMPTY_RETURNS, plan([row({ "SPK.STATUS": "COMPLETE", "SPK.QTYDONE": "900" })]), { appliedAt: "x", fileHash: "h1", sourceKind: "upload" });
    const r = planReturn(parseReturnFile(tab([row({ "SPK.STATUS": "IN_PROGRESS", "SPK.QTYDONE": "900", "SPK.UPDATED": "2026-11-05T11:00:00Z" })])), ORDERS, done, { now: NOW, fileHash: "h2" }).rows[0];
    expect(r.outcome).toBe("CONFLICT");
    expect(r.reasons.join(" ")).toMatch(/reopen/i);
  });
  it("within one file: identical repeats are DUPLICATE, the older of two timestamps is superseded, equal timestamps with different content conflict", () => {
    const a = row();
    const b = row({ "SPK.QTYDONE": "450", "SPK.UPDATED": "2026-11-05T09:00:00Z" });
    const p = plan([a, a, b]);
    expect(p.rows.map((r) => r.outcome)).toEqual(["SUPERSEDED", "SUPERSEDED", "NEW"]);
    const c = plan([a, row({ "SPK.QTYDONE": "411" })]);
    expect(c.rows.map((r) => r.outcome)).toEqual(["CONFLICT", "CONFLICT"]);
    const d = plan([a, a]);
    expect(d.rows.map((r) => r.outcome)).toEqual(["NEW", "DUPLICATE"]);
  });
  it("summarises counts", () => {
    const p = plan([row(), row({ "SPK.ORDER": "NOPE" })]);
    expect(p.summary).toMatchObject({ rows: 2, accepted: 1, rejected: 1 });
  });
});

describe("apply and idempotency", () => {
  const meta = (hash: string) => ({ appliedAt: "2026-11-05T09:00:00Z", fileHash: hash, sourceKind: "upload" as const });
  const text = tab([row(), row({ "SPK.ORDER": "PO-2", "SPK.QTYDONE": "100", "SPK.UPDATED": "2026-11-05T08:30:00Z" })]);
  const hash = sha256Text(text);
  const first = planReturn(parseReturnFile(text), ORDERS, EMPTY_RETURNS, { now: NOW, fileHash: hash });

  it("applies accepted rows to local state and records the batch", () => {
    const s = applyPlan(EMPTY_RETURNS, first, meta(hash));
    expect(Object.keys(s.orders).sort()).toEqual(["PO-1", "PO-2"]);
    expect(s.orders["PO-1"]).toMatchObject({ status: "IN_PROGRESS", qtyDone: 400, line: "Line 1", fileHash: hash });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({ fileHash: hash, accepted: 2, rejected: 0 });
  });
  it("importing the same file again has no effect at all", () => {
    const s1 = applyPlan(EMPTY_RETURNS, first, meta(hash));
    const again = planReturn(parseReturnFile(text), ORDERS, s1, { now: NOW, fileHash: hash });
    expect(again.alreadyApplied).toBe(true);
    expect(again.rows.every((r) => r.outcome === "DUPLICATE" && !r.accepted)).toBe(true);
    const s2 = applyPlan(s1, again, meta(hash));
    expect(s2).toEqual(s1);
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });
  it("the same rows in a differently formatted file are still duplicates", () => {
    const s1 = applyPlan(EMPTY_RETURNS, first, meta(hash));
    const csv = [HEAD.join(","), ...[row(), row({ "SPK.ORDER": "PO-2", "SPK.QTYDONE": "100", "SPK.UPDATED": "2026-11-05T08:30:00Z" })].map((r) => r.join(","))].join("\n");
    const again = planReturn(parseReturnFile(csv), ORDERS, s1, { now: NOW, fileHash: sha256Text(csv) });
    expect(again.alreadyApplied).toBe(false);
    expect(again.rows.every((r) => r.outcome === "DUPLICATE")).toBe(true);
    expect(applyPlan(s1, again, meta("other")).orders).toEqual(s1.orders);
  });
  it("rejected, stale and conflicting rows never change state", () => {
    const s1 = applyPlan(EMPTY_RETURNS, first, meta(hash));
    const bad = tab([row({ "SPK.ORDER": "NOPE" }), row({ "SPK.QTYDONE": "1", "SPK.UPDATED": "2026-11-05T01:00:00Z" })]);
    const p = planReturn(parseReturnFile(bad), ORDERS, s1, { now: NOW, fileHash: "h9" });
    const s2 = applyPlan(s1, p, meta("h9"));
    expect(s2.orders).toEqual(s1.orders);
  });
  it("when a file mixes an accepted row with a stale and a conflicting row, only the accepted row is written", () => {
    const s1 = applyPlan(EMPTY_RETURNS, planReturn(parseReturnFile(tab([row()])), ORDERS, EMPTY_RETURNS, { now: NOW, fileHash: "h1" }), meta("h1"));
    const mixed = tab([
      row({ "SPK.ORDER": "PO-1", "SPK.QTYDONE": "10", "SPK.UPDATED": "2026-11-05T01:00:00Z" }), // stale for PO-1
      row({ "SPK.ORDER": "PO-2", "SPK.QTYDONE": "100", "SPK.UPDATED": "2026-11-05T08:30:00Z" }), // new
    ]);
    const p = planReturn(parseReturnFile(mixed), ORDERS, s1, { now: NOW, fileHash: "h2" });
    expect(p.rows.map((r) => r.outcome)).toEqual(["STALE", "NEW"]);
    const s2 = applyPlan(s1, p, meta("h2"));
    expect(s2.orders["PO-1"]).toEqual(s1.orders["PO-1"]);
    expect(s2.orders["PO-2"]).toMatchObject({ qtyDone: 100 });
    const conflict = planReturn(parseReturnFile(tab([row({ "SPK.QTYDONE": "401" }), row({ "SPK.ORDER": "PO-2", "SPK.QTYDONE": "50", "SPK.UPDATED": "2026-11-05T09:00:00Z" })])), ORDERS, s1, { now: NOW, fileHash: "h3" });
    const s3 = applyPlan(s1, conflict, meta("h3"));
    expect(s3.orders["PO-1"]).toEqual(s1.orders["PO-1"]);
  });
  it("does not mutate its inputs", () => {
    const frozen = JSON.parse(JSON.stringify(EMPTY_RETURNS));
    applyPlan(EMPTY_RETURNS, first, meta(hash));
    expect(EMPTY_RETURNS).toEqual(frozen);
  });
  it("a file with a file-level error plans nothing and cannot be applied", () => {
    const p = planReturn(parseReturnFile("garbage"), ORDERS, EMPTY_RETURNS, { now: NOW, fileHash: "z" });
    expect(p.fileErrors.length).toBeGreaterThan(0);
    expect(p.rows).toEqual([]);
    expect(applyPlan(EMPTY_RETURNS, p, meta("z"))).toEqual(EMPTY_RETURNS);
  });
});

describe("synthetic sample", () => {
  it("is labelled, deterministic and valid against the proposed contract", () => {
    const t1 = buildSampleReturn(ORDERS, NOW);
    expect(buildSampleReturn(ORDERS, NOW)).toBe(t1);
    const p = planReturn(parseReturnFile(t1), ORDERS, EMPTY_RETURNS, { now: NOW, fileHash: sha256Text(t1) });
    expect(p.fileErrors).toEqual([]);
    expect(p.rows.every((r) => r.outcome === "NEW")).toBe(true);
    expect(p.rows).toHaveLength(ORDERS.length);
  });
  it("covers a spread of statuses so the demonstration shows progress", () => {
    const t = buildSampleReturn([...ORDERS, { orderNo: "PO-3", qty: 50 }, { orderNo: "PO-4", qty: 80 }], NOW);
    const statuses = new Set(parseReturnFile(t).rows.map((r) => r.values["SPK.STATUS"]));
    expect(statuses.size).toBeGreaterThan(1);
  });
});
