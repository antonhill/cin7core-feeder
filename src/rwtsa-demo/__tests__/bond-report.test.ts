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
    expect(problems(r)).toContain("verified-cleared quantity does not equal the verified evidence");
  });
  it("unverified-claimed must equal the unverified evidence", () => {
    const r = clone(); row(r, "SYN-JKT-L").unverifiedClaimed -= 50; r.summary.unverifiedClaimedUnits -= 50;
    expect(problems(r)).toContain("unverified-claimed quantity does not equal the unverified evidence");
  });
  it("eligible may not exceed physical Bond stock", () => {
    const r = clone(); const x = row(r, "SYN-CAP-XL"); x.bondPhysical = 50; r.summary.bondUnits -= 10;
    expect(problems(r)).toContain("eligible quantity exceeds physical Bond stock");
  });
  it("eligible may not exceed what remains of the verified clearance", () => {
    const r = clone(); row(r, "SYN-RAIN-M").eligible += 10; r.summary.eligibleUnits += 10;
    expect(problems(r)).toContain("eligible quantity exceeds the verified clearance");
  });
  it("an owner statement can never be verified evidence, even when the numbers follow", () => {
    const r = clone(); const e = r.evidence.find((y: any) => y.provenance === "OWNER_STATEMENT");
    e.status = "VERIFIED"; e.verifiedBy = "o"; e.verifiedOn = "2026-11-11"; e.verificationDocumentRef = "d";
    const x = row(r, "SYN-JKT-L"); x.verifiedCleared = 150; x.unverifiedClaimed = 0; x.remainingCleared = 150; r.summary.verifiedClearedUnits += 150; r.summary.unverifiedClaimedUnits -= 150;
    expect(problems(r)).toContain("an owner statement cannot be verified clearance evidence");
  });
  it("a real report may not carry synthetic identifiers", () => {
    const r = JSON.parse(JSON.stringify(realStyleReport()).replace(/"JKT-M"/g, '"SYN-JKT-M"'));
    expect(problems(r)).toContain("a real report may not contain synthetic identifiers");
  });
  it("an uncleared observed movement must carry the exception", () => {
    const r = clone(); r.observed.find((o: any) => o.uncleared > 0).exceptions = []; r.summary.exceptionCount -= 1;
    expect(problems(r)).toContain("an uncleared movement must carry the exception");
  });
  it("released beyond verified clearance must carry OVER_RELEASED", () => {
    const r = clone(); const x = row(r, "SYN-RAIN-L"); x.exceptions = x.exceptions.filter((c: string) => c !== "OVER_RELEASED"); r.summary.exceptionCount -= 1;
    expect(problems(r)).toContain("row exceptions do not match the figures");
  });
  it("a row labelled NOT CLEARED cannot be eligible", () => {
    const r = clone(); row(r, "SYN-RAIN-M").clearanceStatus = "NOT_CLEARED"; r.summary.notClearedSkus += 1;
    expect(problems(r)).toContain("a NOT CLEARED row cannot be eligible");
  });
  it("stock with no verified clearance can never be eligible", () => {
    const r = clone(); const x = row(r, "SYN-JKT-L"); x.eligible = 5; x.remainingCleared = 5; r.summary.eligibleUnits += 5;
    expect(problems(r).length).toBeGreaterThan(0);
  });
  it("released and proposed quantities must equal the recorded releases and open proposals", () => {
    const a = clone(); row(a, "SYN-RAIN-M").released += 1; row(a, "SYN-RAIN-M").remainingCleared -= 1;
    expect(problems(a)).toContain("released quantity does not equal the recorded releases");
    const b = clone(); row(b, "SYN-JKT-M").activeProposed += 5; b.summary.proposedUnits += 5;
    expect(problems(b)).toContain("proposed quantity does not equal the open proposals");
  });
});

describe("independent review fixes (status vs evidence, references, real/synthetic separation)", () => {
  it("clearanceStatus must follow from the evidence: a CLEARED badge with no verified clearance is rejected", () => {
    const r = clone(); row(r, "SYN-JKT-L").clearanceStatus = "CLEARED"; r.summary.notClearedSkus -= 1;
    expect(problems(r)).toEqual(["clearance status does not follow from the stock and verified evidence"]);
    const s = clone(); row(s, "SYN-RAIN-M").clearanceStatus = "CLEARED";
    expect(problems(s)).toEqual(["clearance status does not follow from the stock and verified evidence"]);
  });
  it("eligible must equal min(Bond stock, remaining verified clearance), not merely stay under it", () => {
    const r = clone(); row(r, "SYN-CAP-XL").eligible = 59; r.summary.eligibleUnits -= 1;
    expect(problems(r)).toEqual(["eligible quantity is not the lesser of Bond stock and remaining verified clearance"]);
  });
  it("clearedExceedsBond must be true exactly when the remaining clearance exceeds the Bond stock", () => {
    const r = clone(); row(r, "SYN-JKT-M").clearedExceedsBond = true;
    expect(problems(r)).toEqual(["clearedExceedsBond is inconsistent with the stock and clearance"]);
  });
  it("a verified entry that is later withdrawn keeps its verification history and the report stays valid", () => {
    const r = clone(); const e = r.evidence.find((x: any) => x.status === "WITHDRAWN");
    expect(e.verifiedBy).toBeDefined();
    expect(problems(r)).toEqual([]);
    delete e.verificationDocumentRef;
    expect(problems(r)).toEqual(["verification details must be complete or absent"]);
  });
  it("the exception lists must be exactly what the figures imply (nothing omitted, nothing invented)", () => {
    const a = clone(); const x = row(a, "SYN-RAIN-L"); x.exceptions = x.exceptions.filter((c: string) => c !== "RELEASED_BEFORE_VERIFICATION"); a.summary.exceptionCount -= 1;
    expect(problems(a)).toEqual(["row exceptions do not match the figures"]);
    const b = clone(); row(b, "SYN-CAP-XL").exceptions = ["PROPOSAL_EXCEEDS_ELIGIBLE"]; b.summary.exceptionCount += 1;
    expect(problems(b)).toEqual(["row exceptions do not match the figures"]);
    const c = clone(); row(c, "SYN-RAIN-L").releasedBeforeCover = 0;
    expect(problems(c)).toContain("released-before-cover quantity does not equal the recorded releases");
  });
  it("an observed movement's uncleared quantity must follow from its own decrease and eligibility, and is never hidden", () => {
    const r = clone(); const o = r.observed.find((x: any) => x.uncleared > 0); o.uncleared = 0; o.exceptions = []; r.summary.unclearedObservedUnits -= 40; r.summary.exceptionCount -= 1;
    expect(problems(r)).toEqual(["an observed movement's uncleared quantity does not follow from its decrease and eligibility"]);
    const d = clone(); d.observed.push(JSON.parse(JSON.stringify(d.observed[0])));
    expect(problems(d)).toContain("duplicate observed SKUs");
  });
  it("proposals and releases must refer to real rows and each other, with unique ids and consistent completion", () => {
    const a = clone(); a.proposals[0].sku = "SYN-NOPE"; expect(problems(a).length).toBeGreaterThan(0);
    const b = clone(); b.releases[0].sku = "SYN-NOPE"; expect(problems(b)).toContain("a proposal or release refers to a SKU that has no row");
    const c = clone(); c.releases.find((x: any) => x.proposalId).proposalId = "P-99"; expect(problems(c)).toContain("a release refers to an unknown proposal");
    const d = clone(); d.proposals[1].id = d.proposals[0].id; expect(problems(d)).toContain("duplicate proposal ids");
    const e = clone(); e.releases[1].id = e.releases[0].id; expect(problems(e)).toContain("duplicate release ids");
    const g = clone(); g.proposals.find((x: any) => x.status === "COMPLETED").status = "OPEN"; expect(problems(g)).toContain("a proposal's status does not match its completed quantity");
    const h = clone(); h.proposals.find((x: any) => x.status === "COMPLETED").completedQuantity = 10; h.proposals.find((x: any) => x.status === "COMPLETED").status = "PARTLY_COMPLETED"; expect(problems(h)).toContain("a proposal's completed quantity does not equal the releases that cite it");
  });
  it("real and synthetic stay apart in EVERY identifier, and real reports need real-looking hashes", () => {
    const a = clone(); a.evidence[0].clearanceRef = "BOE-REAL-1"; expect(problems(a)).toContain("a synthetic report may contain only synthetic identifiers");
    const b = clone(); b.evidence[0].attributedTo = "Some Person"; expect(problems(b)).toContain("a synthetic report may contain only synthetic identifiers");
    const c = clone(); c.proposals[0].proposedBy = "x"; expect(problems(c)).toContain("a synthetic report may contain only synthetic identifiers");
    const d = realStyleReport(); d.evidence[0].clearanceRef = "SYN-BOE-1"; expect(problems(d)).toContain("a real report may not contain synthetic identifiers");
    const e = realStyleReport(); e.evidence[0].attributedTo = "synthetic-owner"; expect(problems(e)).toContain("a real report may not contain synthetic identifiers");
    const f = realStyleReport(); f.snapshotHash = "not-a-real-hash"; expect(problems(f)).toContain("a real report must carry a SHA-256 snapshot hash");
    const g = realStyleReport(); g.registerTipHash = "zz"; expect(problems(g)).toContain("a real report must carry a SHA-256 snapshot hash");
  });
  it("a SKU absent from the snapshot cannot hold Bond stock", () => {
    const r = clone(); row(r, "SYN-CAP-XL").inSnapshot = false;
    expect(problems(r)).toContain("a SKU absent from the snapshot cannot hold Bond stock");
  });
  it("only verified evidence may carry verification details, and only withdrawn evidence a withdrawal reason", () => {
    const a = clone(); a.evidence.find((e: any) => e.status === "UNVERIFIED_NOT_CLEARED").verifiedBy = "synthetic-owner";
    expect(problems(a)).toContain("only verified evidence may carry verification details");
    const b = clone(); b.evidence.find((e: any) => e.status === "VERIFIED").withdrawnReason = "oops";
    expect(problems(b)).toContain("only withdrawn evidence may carry a withdrawal reason");
  });
  it("a release may only cite a proposal for the same SKU", () => {
    const r = clone(); r.releases.find((l: any) => l.proposalId).sku = "SYN-JKT-M";
    expect(problems(r)).toContain("a release cites a proposal for a different SKU");
  });
  it("genuine builder output is accepted: withdrawn proposals and voided releases for SKUs with no row, and a release larger than the proposal it cites", () => {
    const a = clone();
    a.proposals.push({ id: "P-9", sku: "SYN-ZZ", quantity: 5, destination: "JHB", proposedBy: "synthetic-owner", proposedOn: "2026-11-12", reason: "r", status: "WITHDRAWN", completedQuantity: 0 });
    a.releases.push({ id: "R-9", sku: "SYN-ZZ", quantity: 3, on: "2026-11-13", fromTakenAt: "2026-11-12T08:00:00.000Z", toTakenAt: "2026-11-13T08:00:00.000Z", voided: true, releasedBeforeCoverUnits: 3 });
    expect(problems(a)).toEqual([]);
    const b = clone(); const p = b.proposals.find((x: any) => x.status === "COMPLETED"); const rel = b.releases.find((l: any) => l.proposalId === p.id);
    p.quantity = 30; p.completedQuantity = 40; p.status = "COMPLETED"; b.summary.proposedUnits += 0;
    expect(problems(b)).not.toContain("a proposal's completed quantity exceeds its quantity");
    expect(rel.quantity).toBe(40);
  });
  it("a live (non-voided) release or an open proposal for a SKU with no row is still rejected", () => {
    const a = clone(); a.proposals.push({ id: "P-9", sku: "SYN-ZZ", quantity: 5, destination: "JHB", proposedBy: "synthetic-owner", proposedOn: "2026-11-12", reason: "r", status: "OPEN", completedQuantity: 0 });
    expect(problems(a)).toContain("a proposal or release refers to a SKU that has no row");
  });
  it("cheap forgery bounds: previous hash vs observed, released-before-cover bounds, projected usable, observed eligibleBefore and alreadyRecorded", () => {
    const a = clone(); a.previousSnapshotHash = null; expect(problems(a)).toContain("observed movements require a previous snapshot");
    const b = clone(); b.releases.find((l: any) => l.releasedBeforeCoverUnits > 0).releasedBeforeCoverUnits = 999; expect(problems(b)).toContain("released-before-cover units exceed the release quantity");
    const c = clone(); row(c, "SYN-RAIN-L").releasedBeforeCover = 0; c.releases.find((l: any) => l.sku === "SYN-RAIN-L").releasedBeforeCoverUnits = 0; row(c, "SYN-RAIN-L").exceptions = ["OVER_RELEASED"]; c.summary.exceptionCount -= 1;
    expect(problems(c)).toContain("released-before-cover units are below the minimum implied by the release and the verified clearance");
    const d = clone(); row(d, "SYN-JKT-M").projectedUsableIfProposedCompleted += 1; expect(problems(d)).toContain("projected usable does not equal usable plus open proposals");
    const g = clone(); delete row(g, "SYN-JKT-M").projectedUsableIfProposedCompleted; expect(problems(g)).toContain("usable and projected usable must both be present or both absent");
    const e = clone(); const o = e.observed.find((x: any) => x.uncleared > 0); o.eligibleBefore = 100000; o.uncleared = 0; o.exceptions = []; e.summary.unclearedObservedUnits -= 40; e.summary.exceptionCount -= 1;
    expect(problems(e)).toContain("an observed movement's eligible-before quantity exceeds all verified evidence");
    const f = clone(); f.observed[0].alreadyRecorded = 100000; expect(problems(f)).toContain("an observed movement claims more recorded releases than exist");
  });
  it("the fixed safety statements must be present, so a report cannot omit them", () => {
    const r = realStyleReport(); r.statements = r.statements.filter((s: string) => !/Unverified clearance means NOT CLEARED/.test(s));
    expect(problems(r)).toEqual(["the report must carry the fixed safety statements"]);
    const s = realStyleReport(); s.statements = [];
    expect(problems(s)).toEqual(["the report must carry the fixed safety statements"]);
  });
  it("whitespace-only identifiers are rejected", () => {
    const r = clone(); r.evidence[0].attributedTo = "   ";
    expect(problems(r).length).toBeGreaterThan(0);
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
  it("a defined-but-blank path is invalid and never falls back to the example", async () => {
    const r = await loadBondReport({ path: "   ", source: "synthetic" });
    expect(r.kind).toBe("INVALID");
  });
  it("a symlink is resolved and judged by where it really points", async () => {
    const repo = join(tmp, "repo2"); mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "r.json"), JSON.stringify(realStyleReport()));
    const link = join(tmp, "link.json"); symlinkSync(join(repo, "r.json"), link);
    expect((await loadBondReport({ path: link })).kind).toBe("INVALID");
  });
});
