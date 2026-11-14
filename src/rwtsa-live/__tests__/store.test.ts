import { describe, expect, it } from "vitest";
import { existsSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { writeSnapshotAtomic, readSnapshotFile } from "@/rwtsa-live/store";
import { buildSnapshot } from "@/rwtsa-live/snapshot";
import { ACCOUNT, APPKEY, LOC, makeHome } from "./helpers";

const mini = (extra: Partial<{ label: string }> = {}) => buildSnapshot({ creds: { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: extra.label ?? "i" }, locationMap: LOC, takenAt: "2026-11-04T10:00:00.000Z", identity: { status: "VERIFIED", fingerprint: "f", locationCount: 5, accountIdSha256: "a" },
  locations: { rows: [{ ID: LOC.JHB, Name: "JHB" }, { ID: LOC.BOND, Name: "Bond" }], pages: 1, reportedTotal: 2, complete: true, problems: [], observedFields: ["ID", "Name"] },
  availability: { rows: [{ SKU: "A", Location: "JHB", OnHand: 1, Allocated: 0 }], pages: 1, reportedTotal: 1, complete: true, problems: [], observedFields: ["Location", "OnHand", "SKU", "Allocated"] },
  products: { rows: [], pages: 1, reportedTotal: 0, complete: true, problems: [], observedFields: [] } });

describe("snapshot store", () => {
  it("writes atomically under ~/rwtsa-local/cin7-snapshots with 0600 and leaves no temp file", () => {
    const { home } = makeHome(); const r = writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } });
    expect(r.file.startsWith(path.join(realpathSync(home), "rwtsa-local", "cin7-snapshots"))).toBe(true);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(r.file)).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(readSnapshotFile(r.file).contentHash).toBe(mini().contentHash);
  });
  it("never overwrites an existing snapshot", () => {
    const { home } = makeHome(); const a = writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } });
    expect(() => writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } })).toThrow(/exists/i);
    expect(existsSync(a.file)).toBe(true);
  });
  it("refuses to write a snapshot that contains credential material", () => {
    const { home } = makeHome(); const s = mini({ label: `label-${APPKEY}` });
    expect(() => writeSnapshotAtomic({ home, snapshot: s, creds: { accountId: ACCOUNT, applicationKey: APPKEY } })).toThrow(/credential/i);
  });
  it("also catches a credential whose JSON-escaped form differs from the raw value", () => {
    const { home } = makeHome(); const key = 'k"ey\\SECRET'; const s = mini({ label: key });
    expect(() => writeSnapshotAtomic({ home, snapshot: s, creds: { accountId: ACCOUNT, applicationKey: key } })).toThrow(/credential/i);
  });
  it("refuses a snapshot directory inside a git working tree", () => {
    const { home } = makeHome(); mkdirSync(path.join(home, "rwtsa-local"), { recursive: true }); mkdirSync(path.join(home, ".git"));
    expect(() => writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } })).toThrow(/git/i);
  });
  it("rejects a tampered snapshot file on read", () => {
    const { home } = makeHome(); const r = writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } });
    writeFileSync(r.file, readFileSync(r.file, "utf8").replace('"physical": 1', '"physical": 2').replace('"physical":1', '"physical":2'));
    expect(() => readSnapshotFile(r.file)).toThrow(/integrity/i);
  });
});

import { mkdtempSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeTextAtomic } from "@/rwtsa-live/store";

describe("store hardening (independent review P2)", () => {
  it("refuses a snapshot directory that is a symlink into a git working tree", () => {
    const { home } = makeHome(); const repo = mkdtempSync(path.join(tmpdir(), "repo-")); mkdirSync(path.join(repo, ".git")); mkdirSync(path.join(repo, "x"));
    mkdirSync(path.join(home, "rwtsa-local"), { recursive: true }); symlinkSync(path.join(repo, "x"), path.join(home, "rwtsa-local", "cin7-snapshots"));
    expect(() => writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } })).toThrow(/git/i);
  });
  it("refuses an existing snapshot directory that is open to group or others", () => {
    const { home } = makeHome(); const d = path.join(home, "rwtsa-local", "cin7-snapshots"); mkdirSync(d, { recursive: true }); chmodSync(d, 0o755);
    expect(() => writeSnapshotAtomic({ home, snapshot: mini(), creds: { accountId: ACCOUNT, applicationKey: APPKEY } })).toThrow(/permission/i);
  });
  it("writeTextAtomic is no-overwrite and leaves no temp file (used for reconciliation reports too)", () => {
    const { home } = makeHome(); const f = writeTextAtomic({ home, name: "r.json", text: "{}" }).file;
    expect(() => writeTextAtomic({ home, name: "r.json", text: "{}" })).toThrow(/exists/i);
    expect(readdirSync(path.dirname(f)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});
