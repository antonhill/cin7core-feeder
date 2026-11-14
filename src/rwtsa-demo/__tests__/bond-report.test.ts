/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures mutate loosely-typed JSON on purpose */import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import synthetic from "@/rwtsa-demo/fixtures/bond-report.synthetic.json";
import { loadBondReport } from "@/rwtsa-demo/bond/load";
import { validateBondReport } from "@/rwtsa-demo/bond/report-schema";
import { realStyleReport } from "@/rwtsa-demo/__tests__/bond-helpers";

const clone = () => JSON.parse(JSON.stringify(synthetic)) as Record<string, any>;
const bad = (mut: (r: Record<string, any>) => void, src: () => Record<string, any> = clone) => { const r = src(); mut(r); return validateBondReport(r); };

describe("Bond report validation (the offline dashboard trusts nothing it reads)", () => {
  it("accepts the synthetic example and a real-style report", () => {
    expect(validateBondReport(clone()).ok).toBe(true);
    expect(validateBondReport(realStyleReport()).ok).toBe(true);
  });
  it("rejects anything that is not an object, has another schema version, or unknown keys", () => {
    for (const v of [null, 1, "x", [], {}]) expect(validateBondReport(v).ok).toBe(false);
    expect(bad((r) => { r.schemaVersion = 1; }).ok).toBe(false);
    expect(bad((r) => { r.extra = 1; }).ok).toBe(false);
    expect(bad((r) => { r.rows[0].extra = 1; }).ok).toBe(false);
    expect(bad((r) => { r.dataClass = "OTHER"; }).ok).toBe(false);
  });
  it("rejects inflated or inconsistent stock figures", () => {
    expect(bad((r) => { r.rows[0].eligible = r.rows[0].bondPhysical + 1; }).ok).toBe(false);
    expect(bad((r) => { const x = r.rows.find((y: any) => y.clearanceStatus === "NOT_CLEARED" && y.eligible === 0); x.eligible = 5; }).ok).toBe(false);
    expect(bad((r) => { r.rows[0].verifiedCleared += 1; }).ok).toBe(false); // must equal the verified evidence lines
    expect(bad((r) => { r.rows[0].unverifiedClaimed += 1; }).ok).toBe(false);
    expect(bad((r) => { r.rows[0].bondPhysical = -1; }).ok).toBe(false);
    expect(bad((r) => { r.rows[0].eligible = Number.NaN; }).ok).toBe(false);
    expect(bad((r) => { r.summary.eligibleUnits += 1; }).ok).toBe(false);
    expect(bad((r) => { r.summary.bondUnits += 1; }).ok).toBe(false);
    expect(bad((r) => { r.summary.exceptionCount += 1; }).ok).toBe(false);
  });
  it("rejects evidence that breaks the rules: an owner statement verified, a verified entry without its verification, unknown provenance or status", () => {
    expect(bad((r) => { const e = r.evidence.find((x: any) => x.provenance === "OWNER_STATEMENT"); e.status = "VERIFIED"; e.verifiedBy = "o"; e.verifiedOn = "2026-11-11"; e.verificationDocumentRef = "d"; }).ok).toBe(false);
    expect(bad((r) => { const e = r.evidence.find((x: any) => x.status === "VERIFIED"); delete e.verifiedBy; }).ok).toBe(false);
    expect(bad((r) => { const e = r.evidence.find((x: any) => x.status === "VERIFIED"); delete e.verificationDocumentRef; }).ok).toBe(false);
    expect(bad((r) => { r.evidence[0].provenance = "STOCK_TRANSFER"; }).ok).toBe(false);
    expect(bad((r) => { r.evidence[0].provenance = "DUTY_POSTED"; }).ok).toBe(false);
    expect(bad((r) => { r.evidence[0].status = "CLEARED"; }).ok).toBe(false);
    expect(bad((r) => { const e = r.evidence.find((x: any) => x.status === "UNVERIFIED_NOT_CLEARED"); e.verifiedBy = "o"; }).ok).toBe(false);
  });
  it("rejects unknown exception codes and an uncleared movement that carries no exception", () => {
    expect(bad((r) => { r.rows[0].exceptions = ["MYSTERY"]; }).ok).toBe(false);
    expect(bad((r) => { const o = r.observed.find((x: any) => x.uncleared > 0); o.exceptions = []; }).ok).toBe(false);
  });
  it("keeps real and synthetic data apart: a synthetic report cannot pass as real, nor real-looking data as synthetic", () => {
    expect(bad((r) => { r.dataClass = "REAL_CIN7_SNAPSHOT"; }).ok).toBe(false); // SYN- SKUs and a SYNTHETIC hash
    expect(bad((r) => { r.snapshotHash = "SYNTHETIC-x"; }, realStyleReport).ok).toBe(false);
    expect(bad((r) => { r.dataClass = "SYNTHETIC_DEMONSTRATION"; }, realStyleReport).ok).toBe(false);
    expect(bad((r) => { r.snapshotHash = "abc"; }).ok).toBe(false);
  });
  it("problem messages are value-free (never echo report content)", () => {
    const r = clone(); r.rows[0].sku = "SENTINEL_SKU_77"; r.rows[0].eligible = 99999;
    const v = validateBondReport(r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(JSON.stringify(v.problems)).not.toMatch(/SENTINEL_SKU_77|99999/);
  });
});

const problems = (r: unknown) => { const v = validateBondReport(r); return v.ok ? [] : v.problems; };
const row = (r: Record<string, any>, sku: string) => r.rows.find((x: any) => x.sku === sku);

describe("each consistency rule is independently necessary (single, internally consistent tamperings)", () => {
  it("verified-cleared must equal the verified evidence even when everything derived from it is consistently inflated", () => {
    const r = clone(); const x = row(r, "SYN-JKT-M"); x.verifiedCleared += 10; x.remainingCleared += 10; r.summary.verifiedClearedUnits += 10;
    expect(problems(r)).toEqual(["verified-cleared quantity does not equal the verified evidence"]);
  });
  it("unverified-claimed must equal the unverified evidence", () => {
    const r = clone(); row(r, "SYN-JKT-L").unverifiedClaimed -= 50; r.summary.unverifiedClaimedUnits -= 50;
    expect(problems(r)).toEqual(["unverified-claimed quantity does not equal the unverified evidence"]);
  });
  it("eligible may not exceed physical Bond stock", () => {
    const r = clone(); const x = row(r, "SYN-CAP-XL"); x.bondPhysical = 50; r.summary.bondUnits -= 10;
    expect(problems(r)).toEqual(["eligible quantity exceeds physical Bond stock"]);
  });
  it("eligible may not exceed what remains of the verified clearance", () => {
    const r = clone(); row(r, "SYN-RAIN-M").eligible += 10; r.summary.eligibleUnits += 10;
    expect(problems(r)).toEqual(["eligible quantity exceeds the verified clearance"]);
  });
  it("an owner statement can never be verified evidence, even when the numbers follow", () => {
    const r = clone(); const e = r.evidence.find((y: any) => y.provenance === "OWNER_STATEMENT");
    e.status = "VERIFIED"; e.verifiedBy = "o"; e.verifiedOn = "2026-11-11"; e.verificationDocumentRef = "d";
    const x = row(r, "SYN-JKT-L"); x.verifiedCleared = 150; x.unverifiedClaimed = 0; x.remainingCleared = 150; r.summary.verifiedClearedUnits += 150; r.summary.unverifiedClaimedUnits -= 150;
    expect(problems(r)).toEqual(["an owner statement cannot be verified clearance evidence"]);
  });
  it("a real report may not carry synthetic identifiers", () => {
    const r = JSON.parse(JSON.stringify(realStyleReport()).replace(/"JKT-M"/g, '"SYN-JKT-M"'));
    expect(problems(r)).toEqual(["a real report may not contain synthetic identifiers"]);
  });
  it("an uncleared observed movement must carry the exception", () => {
    const r = clone(); r.observed.find((o: any) => o.uncleared > 0).exceptions = []; r.summary.exceptionCount -= 1;
    expect(problems(r)).toEqual(["an uncleared movement must carry the exception"]);
  });
  it("released beyond verified clearance must carry OVER_RELEASED", () => {
    const r = clone(); const x = row(r, "SYN-RAIN-L"); x.exceptions = x.exceptions.filter((c: string) => c !== "OVER_RELEASED"); r.summary.exceptionCount -= 1;
    expect(problems(r)).toEqual(["a release beyond verified clearance must carry the OVER_RELEASED exception"]);
  });
  it("a row labelled NOT CLEARED cannot be eligible", () => {
    const r = clone(); row(r, "SYN-RAIN-M").clearanceStatus = "NOT_CLEARED"; r.summary.notClearedSkus += 1;
    expect(problems(r)).toEqual(["a NOT CLEARED row cannot be eligible"]);
  });
  it("stock with no verified clearance can never be eligible", () => {
    const r = clone(); const x = row(r, "SYN-JKT-L"); x.eligible = 5; x.remainingCleared = 5; r.summary.eligibleUnits += 5;
    expect(problems(r).length).toBeGreaterThan(0);
  });
  it("released and proposed quantities must equal the recorded releases and open proposals", () => {
    const a = clone(); row(a, "SYN-RAIN-M").released += 1; row(a, "SYN-RAIN-M").remainingCleared -= 1;
    expect(problems(a)).toContain("released quantity does not equal the recorded releases");
    const b = clone(); row(b, "SYN-JKT-M").activeProposed += 5; b.summary.proposedUnits += 5;
    expect(problems(b)).toEqual(["proposed quantity does not equal the open proposals"]);
  });
});

describe("Bond report loading (owner-selected local file or the built-in synthetic example)", () => {
  let tmp: string;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "rwtsa-bond-SENTINELPATH-")); });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const write = (name: string, body: unknown) => { const f = join(tmp, name); writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };

  it("shows NO DATA when nothing is configured, and the synthetic example only when explicitly selected", async () => {
    expect((await loadBondReport({})).kind).toBe("NO_DATA");
    expect((await loadBondReport({ source: "" })).kind).toBe("NO_DATA");
    const s = await loadBondReport({ source: "synthetic" });
    expect(s.kind).toBe("OK");
    if (s.kind === "OK") expect(s.report.dataClass).toBe("SYNTHETIC_DEMONSTRATION");
    expect((await loadBondReport({ source: "bogus" })).kind).toBe("INVALID");
  });
  it("loads a validated report from an owner-selected local file outside any git tree", async () => {
    const r = await loadBondReport({ path: write("ok.json", realStyleReport()) });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") expect(r.report.dataClass).toBe("REAL_CIN7_SNAPSHOT");
  });
  it("never silently substitutes the synthetic example for a path that cannot be used", async () => {
    for (const cfg of [{ path: join(tmp, "missing.json") }, { path: write("bad.json", "not json SENTINEL_CONTENT") }, { path: write("tamper.json", { ...realStyleReport(), schemaVersion: 9 }) }, { path: tmp }]) {
      const r = await loadBondReport(cfg);
      expect(r.kind).toBe("INVALID");
      expect(JSON.stringify(r)).not.toMatch(/SENTINEL_CONTENT|SENTINELPATH/);
    }
  });
  it("refuses a report inside a git working tree and an oversized file", async () => {
    const repo = join(tmp, "repo"); mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "r.json"), JSON.stringify(realStyleReport()));
    const a = await loadBondReport({ path: join(repo, "r.json") });
    expect(a.kind).toBe("INVALID");
    const big = join(tmp, "big.json"); writeFileSync(big, " ".repeat(6 * 1024 * 1024));
    const b = await loadBondReport({ path: big });
    expect(b.kind).toBe("INVALID");
    expect(JSON.stringify(b)).toMatch(/size limit/);
    expect(JSON.stringify(a)).toMatch(/git working tree/);
  });
  it("a symlink is resolved and judged by where it really points", async () => {
    const repo = join(tmp, "repo2"); mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "r.json"), JSON.stringify(realStyleReport()));
    const link = join(tmp, "link.json"); symlinkSync(join(repo, "r.json"), link);
    expect((await loadBondReport({ path: link })).kind).toBe("INVALID");
  });
});
