import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRwtsaCredentials, loadLocationMap } from "@/rwtsa-live/credentials";
import { ACCOUNT, APPKEY, LOC, G, makeHome } from "./helpers";

describe("dedicated RWTSA credentials", () => {
  it("loads the three allowed keys from ~/rwtsa-local/credentials/cin7.env", () => {
    const { home } = makeHome();
    expect(loadRwtsaCredentials({ home })).toEqual({ accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "rwtsa-demo-instance" });
  });
  it("refuses a file readable by group or others", () => {
    const { home } = makeHome({ envMode: 0o644 });
    expect(() => loadRwtsaCredentials({ home })).toThrow(/permission/i);
  });
  it("refuses a directory open to group or others", () => {
    const { home } = makeHome({ dirMode: 0o755 });
    expect(() => loadRwtsaCredentials({ home })).toThrow(/permission/i);
  });
  it("refuses a symlinked credentials file", () => {
    const { home, dir } = makeHome();
    const other = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    writeFileSync(path.join(other, "x.env"), "RWTSA_CIN7_ACCOUNT_ID=a\n", { mode: 0o600 });
    const f = path.join(dir, "cin7.env");
    rmSync(f);
    symlinkSync(path.join(other, "x.env"), f);
    expect(() => loadRwtsaCredentials({ home })).toThrow(/symlink/i);
  });
  it("refuses any key outside the allowlist (no stray NewQuip or production secrets), without echoing the value", () => {
    const { home } = makeHome({ env: `RWTSA_CIN7_ACCOUNT_ID=${ACCOUNT}\nRWTSA_CIN7_APPLICATION_KEY=${APPKEY}\nRWTSA_CIN7_INSTANCE_LABEL=x\nSUPABASE_SERVICE_ROLE_KEY=topsecretvalue\n` });
    let msg = "";
    try { loadRwtsaCredentials({ home }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/not allowed/i);
    expect(msg).not.toContain("topsecretvalue");
  });
  it("refuses a missing key and never echoes values in the message", () => {
    const { home } = makeHome({ env: `RWTSA_CIN7_ACCOUNT_ID=${ACCOUNT}\n` });
    let msg = ""; try { loadRwtsaCredentials({ home }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/missing/i); expect(msg).not.toContain(ACCOUNT);
  });
  it("does not read process.env", () => {
    const { home } = makeHome();
    const before = process.env.RWTSA_CIN7_ACCOUNT_ID; process.env.RWTSA_CIN7_ACCOUNT_ID = "from-process-env";
    try { expect(loadRwtsaCredentials({ home }).accountId).toBe(ACCOUNT); } finally { if (before === undefined) delete process.env.RWTSA_CIN7_ACCOUNT_ID; else process.env.RWTSA_CIN7_ACCOUNT_ID = before; }
  });
  it("refuses a credentials directory outside ~/rwtsa-local/credentials", () => {
    const home = mkdtempSync(path.join(tmpdir(), "rwtsa-home-")); const d = path.join(home, "elsewhere"); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700);
    writeFileSync(path.join(d, "cin7.env"), "x", { mode: 0o600 });
    expect(() => loadRwtsaCredentials({ home, dirOverride: d })).toThrow(/rwtsa-local\/credentials/);
  });
});

describe("location map (identity by ID, never by display name)", () => {
  it("requires Bond and accepts only GUID identifiers, unique across roles", () => {
    const { dir } = makeHome();
    expect(loadLocationMap(dir).BOND).toBe(LOC.BOND);
    for (const bad of [{ JHB: G(1) }, { ...LOC, BOND: "Bond" }, { ...LOC, DURBAN: LOC.JHB }, { ...LOC, EXTRA: G(9) }]) {
      const m = makeHome({ locations: bad });
      expect(() => loadLocationMap(m.dir)).toThrow();
    }
  });
});
