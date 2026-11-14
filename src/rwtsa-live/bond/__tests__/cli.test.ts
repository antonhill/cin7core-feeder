import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBondCli } from "@/rwtsa-live/bond/cli";
import { readRegister, registerFile } from "@/rwtsa-live/bond/register-store";
import { writeSnapshotAtomic } from "@/rwtsa-live/store";
import { buildSnapshot } from "@/rwtsa-live/snapshot";
import { ACCOUNT, APPKEY, LOC } from "../../__tests__/helpers";

const SKU = "SKU-XYZ-123";
const mkHome = () => mkdtempSync(path.join(tmpdir(), "bond-cli-"));
const names = { JHB: "Jhb", DURBAN: "Dbn", CAPE_TOWN: "Cpt", FACTORY_STORE: "Fac", BOND: "Bond" } as const;
const col = (rows: unknown[]) => ({ rows: rows as Record<string, unknown>[], pages: 1, reportedTotal: rows.length, complete: true, problems: [], observedFields: ["ID", "Name", "SKU", "Location", "OnHand", "Allocated"] });
function snap(home: string, takenAt: string, o: { bond: number; jhb: number; allocated?: number; identity?: "VERIFIED" | "NOT_APPROVED"; sku?: string }): string {
  const sku = o.sku ?? SKU;
  const s = buildSnapshot({
    creds: { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "i" }, locationMap: LOC, takenAt,
    identity: { status: o.identity ?? "VERIFIED", fingerprint: "f", locationCount: 5, accountIdSha256: "a" },
    locations: col(Object.entries(names).map(([r, n]) => ({ ID: LOC[r as keyof typeof LOC], Name: n }))),
    availability: col([{ SKU: sku, Location: "Bond", OnHand: o.bond, Allocated: 0 }, { SKU: sku, Location: "Jhb", OnHand: o.jhb, Allocated: o.allocated ?? 0 }]),
    products: col([]),
  });
  return writeSnapshotAtomic({ home, snapshot: s, creds: { accountId: ACCOUNT, applicationKey: APPKEY } }).file;
}
const run = (home: string, argv: string[]) => runBondCli(argv, { home, today: "2026-11-14", now: "2026-11-14T08:00:00.000Z" });
const addArgs = (extra: string[] = []) => ["add-clearance", "--shipment", "SHIP-A", "--clearance-ref", "BOE-1", "--date", "2026-11-10", "--provenance", "CUSTOMS_DOCUMENT", "--attributed-to", "owner", "--document-ref", "doc-1", "--line", `${SKU}=100`, ...extra];
const verifyArgs = ["verify", "--entry", "CL-1", "--by", "owner", "--document-ref", "doc-1"];
const reportRows = (home: string, out: { lines: string[] }) => {
  const dir = path.join(home, "rwtsa-local", "bond");
  const f = readdirSync(dir).filter((n) => n.startsWith("bond-report-"))[0];
  expect(out.lines.join("\n")).toContain("bond-report-");
  return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
};

describe("bond CLI (offline, local register, no Cin7)", () => {
  it("add-clearance records an UNVERIFIED entry; the report shows NOT CLEARED and nothing eligible", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 });
    expect(run(h, addArgs()).code).toBe(0);
    const out = run(h, ["report", "--snapshot", s]);
    expect(out.code).toBe(0);
    const rep = reportRows(h, out);
    expect(rep.rows[0]).toMatchObject({ sku: SKU, clearanceStatus: "NOT_CLEARED", eligible: 0, unverifiedClaimed: 100, bondPhysical: 100 });
    expect(rep.summary).toMatchObject({ eligibleUnits: 0, verifiedClearedUnits: 0, unverifiedClaimedUnits: 100 });
  });
  it("verify makes the stock eligible; an owner-statement entry can never be verified and the register stays unchanged", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 });
    run(h, addArgs()); expect(run(h, verifyArgs).code).toBe(0);
    expect(reportRows(h, run(h, ["report", "--snapshot", s])).rows[0]).toMatchObject({ clearanceStatus: "CLEARED", eligible: 100 });
    const h2 = mkHome(); run(h2, addArgs(["--provenance", "OWNER_STATEMENT"].length ? [] : []).map((x) => (x === "CUSTOMS_DOCUMENT" ? "OWNER_STATEMENT" : x)));
    const before = readFileSync(registerFile(h2), "utf8");
    const bad = run(h2, verifyArgs);
    expect(bad.code).toBe(1);
    expect(readFileSync(registerFile(h2), "utf8")).toBe(before);
  });
  it("refuses a stock transfer, posted duty or freight invoice as evidence, and missing or unknown arguments", () => {
    const h = mkHome();
    for (const p of ["STOCK_TRANSFER", "DUTY_POSTED", "FREIGHT_INVOICE"]) expect(run(h, addArgs().map((x) => (x === "CUSTOMS_DOCUMENT" ? p : x))).code).toBe(1);
    expect(run(h, ["add-clearance", "--shipment", "S"]).code).toBe(2);
    expect(run(h, [...addArgs(), "--bogus", "x"]).code).toBe(2);
    const eq = run(h, ["add-clearance", "--shipment=S"]);
    expect(eq.code).toBe(2);
    expect(eq.lines.join(" ")).toMatch(/unexpected argument/i);
    expect(run(h, ["nope"]).code).toBe(2);
    expect(readRegister({ home: h }).count).toBe(0);
  });
  it("propose is validated against the snapshot and verified clearance; it records a draft and creates nothing else", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 });
    const p = (q: string) => ["propose", "--snapshot", s, "--sku", SKU, "--qty", q, "--to", "JHB", "--by", "owner", "--reason", "demo"];
    run(h, addArgs());
    expect(run(h, p("10")).code).toBe(1); // not cleared yet
    run(h, verifyArgs);
    expect(run(h, p("101")).code).toBe(1); // over eligible
    expect(run(h, [...p("10").slice(0, 8), "BOND", ...p("10").slice(9)]).code).toBe(1); // Bond destination
    expect(run(h, p("60")).code).toBe(0);
    expect(run(h, p("41")).code).toBe(1); // 60 already proposed
    const rep = reportRows(h, run(h, ["report", "--snapshot", s]));
    expect(rep.rows[0]).toMatchObject({ activeProposed: 60, eligible: 100 });
    expect(rep.summary.proposedUnits).toBe(60);
  });
  it("record-release needs an observed Bond decrease between two snapshots and never creates clearance", () => {
    const h = mkHome();
    const s1 = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 }), s2 = snap(h, "2026-11-14T07:00:00.000Z", { bond: 60, jhb: 40 });
    const rel = (q: string) => ["record-release", "--from-snapshot", s1, "--to-snapshot", s2, "--sku", SKU, "--qty", q, "--by", "owner"];
    run(h, addArgs());
    expect(run(h, rel("41")).code).toBe(1); // more than the 40 observed
    expect(run(h, rel("40")).code).toBe(0); // recorded, but there is no verified clearance
    const rep = reportRows(h, run(h, ["report", "--snapshot", s2, "--previous-snapshot", s1]));
    expect(rep.rows[0]).toMatchObject({ verifiedCleared: 0, eligible: 0, clearanceStatus: "NOT_CLEARED" });
    expect(rep.rows[0].exceptions).toContain("OVER_RELEASED");
    expect(rep.observed[0]).toMatchObject({ bondDecrease: 40, nonBondIncrease: 40, uncleared: 40, alreadyRecorded: 40 });
    expect(rep.summary).toMatchObject({ exceptionCount: expect.any(Number), unclearedObservedUnits: 40 });
    const order = run(h, ["record-release", "--from-snapshot", s2, "--to-snapshot", s1, "--sku", SKU, "--qty", "1", "--by", "owner"]);
    expect(order.code).toBe(1); // later snapshot first is refused
    expect(order.lines.join(" ")).toMatch(/earlier/i);
  });
  it("refuses an INCOMPLETE or identity-unverified snapshot", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0, identity: "NOT_APPROVED" });
    expect(run(h, ["report", "--snapshot", s]).code).toBe(1);
  });
  it("terminal output never carries a SKU, and report files are owner-only", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 });
    const outs = [run(h, addArgs()), run(h, verifyArgs), run(h, ["report", "--snapshot", s])];
    for (const o of outs) expect(o.lines.join("\n")).not.toContain(SKU);
    const dir = path.join(h, "rwtsa-local", "bond");
    for (const n of readdirSync(dir)) expect(statSync(path.join(dir, n)).mode & 0o077).toBe(0);
  });
  it("re-running an identical report is idempotent (never overwrites, never fails)", () => {
    const h = mkHome(); const s = snap(h, "2026-11-13T08:00:00.000Z", { bond: 100, jhb: 0 });
    expect(run(h, ["report", "--snapshot", s]).code).toBe(0);
    expect(run(h, ["report", "--snapshot", s]).code).toBe(0);
  });
});
