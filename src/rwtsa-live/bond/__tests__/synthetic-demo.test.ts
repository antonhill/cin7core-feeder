import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSyntheticBondReport, SYNTHETIC_REPORT_FILE_NAME } from "@/rwtsa-live/bond/synthetic-demo";

const FIXTURE = path.resolve(__dirname, "..", "..", "..", "rwtsa-demo", "fixtures", "bond-report.synthetic.json");

describe("synthetic Bond demonstration (never a real customs event)", () => {
  const r = buildSyntheticBondReport();
  it("matches the committed fixture the offline dashboard renders (regenerate with scripts/rwtsa-live/bond-synthetic.ts)", () => {
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(r)));
  });
  it("is labelled synthetic everywhere: data class, statements, SKUs, references and people", () => {
    expect(r.dataClass).toBe("SYNTHETIC_DEMONSTRATION");
    expect(r.statements.join(" ")).toMatch(/synthetic/i);
    expect(r.statements.join(" ")).toMatch(/not a real customs event/i);
    expect(r.rows.every((x) => x.sku.startsWith("SYN-"))).toBe(true);
    for (const e of r.evidence) {
      expect(e.shipmentRef.startsWith("SYN-") && e.clearanceRef.startsWith("SYN-") && e.attributedTo.startsWith("synthetic")).toBe(true);
      expect(e.lines.every((l) => l.sku.startsWith("SYN-"))).toBe(true);
    }
    expect(SYNTHETIC_REPORT_FILE_NAME).toMatch(/synthetic/);
  });
  it("demonstrates recording, verification, eligible quantities, a proposed transfer and exception reporting", () => {
    expect(r.evidence.some((e) => e.status === "VERIFIED")).toBe(true);
    expect(r.evidence.some((e) => e.status === "UNVERIFIED_NOT_CLEARED")).toBe(true);
    expect(r.evidence.some((e) => e.status === "WITHDRAWN")).toBe(true);
    expect(r.summary.eligibleUnits).toBeGreaterThan(0);
    expect(r.rows.some((x) => x.clearanceStatus === "NOT_CLEARED" && x.eligible === 0)).toBe(true);
    expect(r.rows.some((x) => x.clearanceStatus === "PARTIALLY_CLEARED")).toBe(true);
    expect(r.proposals.some((p) => p.status === "OPEN")).toBe(true);
    expect(r.observed.some((o) => o.exceptions.includes("TRANSFER_WITHOUT_CLEARANCE_EVIDENCE"))).toBe(true);
    expect(r.rows.some((x) => x.exceptions.length > 0)).toBe(true);
    expect(r.releases.length).toBeGreaterThan(0);
  });
  it("never exceeds verified clearance or physical Bond stock (the engine rules hold in the example)", () => {
    for (const x of r.rows) {
      expect(x.eligible).toBeLessThanOrEqual(x.bondPhysical);
      expect(x.eligible).toBeLessThanOrEqual(x.remainingCleared);
    }
  });
  it("contains nothing from the real RWTSA instance (no real Bond ID, hashes or snapshot data)", () => {
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/0ab54403|9a374b1c|9d8e7f33|9860184d/);
    expect(r.snapshotHash.startsWith("SYNTHETIC")).toBe(true);
  });
  it("is deterministic", () => {
    expect(JSON.stringify(buildSyntheticBondReport())).toBe(JSON.stringify(r));
  });
});
