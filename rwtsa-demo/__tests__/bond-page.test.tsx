import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import BondPage, * as bondModule from "../app/bond/page";
import { Nav } from "../components/Nav";
import { realStyleReport } from "@/rwtsa-demo/__tests__/bond-helpers";

const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const render = async () => text(renderToStaticMarkup(await BondPage()));
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "rwtsa-bondpage-SENTINELDIR-")); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const env = (v: Record<string, string>) => { for (const k of ["RWTSA_BOND_SOURCE", "RWTSA_BOND_REPORT_PATH"]) vi.stubEnv(k, v[k] ?? ""); };

describe("offline Bond dashboard", () => {
  it("is rendered per request and linked from the navigation, separate from Scenarios A-D", () => {
    expect((bondModule as { dynamic?: string }).dynamic).toBe("force-dynamic");
    const nav = text(renderToStaticMarkup(<Nav />));
    expect(nav).toContain("Bond stock");
    expect(renderToStaticMarkup(<Nav />)).toContain('href="/bond"');
  });
  it("shows NO DATA and how to produce a report when nothing is selected (never a placeholder result)", async () => {
    env({});
    const t = await render();
    expect(t).toMatch(/NO DATA/);
    expect(t).not.toMatch(/Eligible for release \d/);
    expect(t).toMatch(/bond\.ts report/);
  });
  it("renders the synthetic example with an unmissable SYNTHETIC label and every required measure", async () => {
    env({ RWTSA_BOND_SOURCE: "synthetic" });
    const t = await render();
    expect(t).toMatch(/SYNTHETIC DEMONSTRATION/);
    expect(t).toMatch(/not a real customs event/i);
    for (const s of ["Physical Bond stock", "Verified-cleared", "Eligible for release", "Proposed transfers", "Clearance exceptions", "Evidence provenance"]) expect(t).toContain(s);
    expect(t).toMatch(/Physical Bond stock\s*600/);
    expect(t).toMatch(/Eligible for release\s*240/);
    for (const code of ["CUSTOMS_DOCUMENT", "BROKER_CONFIRMATION", "OWNER_STATEMENT", "TRANSFER_WITHOUT_CLEARANCE_EVIDENCE", "OVER_RELEASED", "UNVERIFIED_NOT_CLEARED", "WITHDRAWN"]) expect(t).toContain(code);
    expect(t).toContain("SYN-JKT-M");
    expect(t).toMatch(/P-1[^]*OPEN/);
    expect(t).toMatch(/no Cin7 transaction/i);
  });
  it("renders an owner-selected real-class report WITHOUT any synthetic wording, and never shows the file path", async () => {
    const f = join(tmp, "real.json"); writeFileSync(f, JSON.stringify(realStyleReport()));
    env({ RWTSA_BOND_REPORT_PATH: f });
    const t = await render();
    expect(t).toMatch(/REAL CIN7 SNAPSHOT/);
    expect(t).not.toMatch(/SYNTHETIC/i);
    expect(t).not.toMatch(/SENTINELDIR|real\.json/);
    expect(t).toMatch(/Eligible for release\s*240/);
  });
  it("an invalid report shows REPORT INVALID with value-free reasons and no data", async () => {
    const r = realStyleReport(); r.rows[0].eligible = 99999; r.rows[0].sku = "SENTINEL_SKU_55";
    const f = join(tmp, "bad.json"); writeFileSync(f, JSON.stringify(r));
    env({ RWTSA_BOND_REPORT_PATH: f });
    const t = await render();
    expect(t).toMatch(/REPORT INVALID/);
    expect(t).not.toMatch(/SENTINEL_SKU_55|99999|SENTINELDIR/);
    expect(t).not.toMatch(/Eligible for release\s*\d/);
  });
  it("a configured path never falls back to the synthetic example", async () => {
    env({ RWTSA_BOND_REPORT_PATH: join(tmp, "nope.json"), RWTSA_BOND_SOURCE: "" });
    const t = await render();
    expect(t).toMatch(/REPORT INVALID/);
    expect(t).not.toMatch(/SYNTHETIC/i);
  });
});
