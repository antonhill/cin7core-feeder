import { describe, expect, it } from "vitest";
import { runP0, type P0Deps, type P0Input, type P0Port } from "../p0-checklist";
import { NEWQUIP_REQUIRED_SUPABASE_REF } from "../write-flag";
import { NEWQUIP_POC_CIN7_INSTANCE_ID, OPERATIONAL_CUSTOMER_DENYLIST } from "@/newquip/access";

const URL_OK = `https://${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`;
const ENV_OK = { SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_URL: URL_OK, VERCEL_ENV: "preview" };
const POC = { id: NEWQUIP_POC_CIN7_INSTANCE_ID, name: "NewQuip POC" };

class Port implements P0Port {
  calls: string[] = [];
  customers = new Map<string, { taxRule: string | null; revenueAccount: string | null; location: string | null }>([["P0 Test Customer", { taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }]]);
  skus = new Set(["NQ2886", "NQ-ASM"]);
  assemblies = new Set(["NQ-ASM"]);
  stock: Record<string, Array<{ location: string | null; available: number | null }>> = { NQ2886: [{ location: "MSTR", available: 10 }], "NQ-ASM": [{ location: "MSTR", available: 0 }] };
  found: Array<{ saleId: string; saleNumber: string | null }> = [];
  async customerExists(n: string) { this.calls.push(`customerExists:${n}`); return this.customers.has(n); }
  async customerDefaults(n: string) { this.calls.push("customerDefaults"); return this.customers.get(n) ?? null; }
  async resolveProducts(s: string[]) { this.calls.push("resolveProducts"); const ids = new Map<string, string>(); const missing: string[] = []; for (const k of s) { if (this.skus.has(k)) ids.set(k, "id"); else missing.push(k); } return { ids, missing }; }
  async assemblySkus(s: string[]) { this.calls.push("assemblySkus"); return s.filter((k) => this.assemblies.has(k)); }
  async stockAt(k: string) { this.calls.push(`stockAt:${k}`); return this.stock[k] ?? []; }
  async findByExternalId() { this.calls.push("findByExternalId"); return this.found; }
}
const input = (o: Partial<P0Input> = {}): P0Input => ({ customerName: "P0 Test Customer", location: "MSTR", taxRule: "Standard Rate Sales", revenueAccount: "200", skus: [{ sku: "NQ2886", quantity: 2 }], externalId: "NEWQUIP-PROJECTS-SALE:P-1", ...o });
const deps = (port: Port, o: Partial<P0Deps> = {}): P0Deps => ({ env: ENV_OK, instances: [POC], expectedInstanceId: NEWQUIP_POC_CIN7_INSTANCE_ID, denylist: OPERATIONAL_CUSTOMER_DENYLIST, portFor: () => port, ...o });
const status = (r: Awaited<ReturnType<typeof runP0>>, id: string) => r.checks.find((c) => c.id === id)!;

describe("P0 checklist", () => {
  it("all automated checks pass for a correct setup; manual items remain; the verdict is READY_PENDING_MANUAL", async () => {
    const r = await runP0(deps(new Port()), input());
    expect(r.checks.filter((c) => c.status !== "MANUAL").map((c) => c.status)).toEqual(Array(r.checks.length - r.counts.MANUAL).fill("PASS"));
    expect(r).toMatchObject({ verdict: "READY_PENDING_MANUAL", counts: { FAIL: 0, NOT_RUN: 0 } });
    expect(r.counts.MANUAL).toBeGreaterThanOrEqual(5);
  });
  it("fails explicitly if the write flag is ON, and if run on Production, without reading Cin7", async () => {
    const on = await runP0(deps(new Port()), input());
    expect(on.verdict).toBe("READY_PENDING_MANUAL");
    const flagged = await runP0(deps(new Port(), { env: { ...ENV_OK, NEWQUIP_CIN7_WRITES_ENABLED: "true" } }), input());
    expect(status(flagged, "ENV_WRITE_FLAG_OFF")).toMatchObject({ status: "FAIL" });
    expect(flagged.verdict).toBe("NOT_READY");
    const port = new Port();
    const prod = await runP0(deps(port, { env: { ...ENV_OK, VERCEL_ENV: "production" } }), input());
    expect(status(prod, "ENV_NOT_PRODUCTION").status).toBe("FAIL");
    expect(status(prod, "CUSTOMER_EXISTS").status).toBe("NOT_RUN");
    expect(port.calls).toEqual([]);
  });
  it("a wrong or unreadable Supabase project FAILS with the facts and stops every Cin7 read (no substitution)", async () => {
    const port = new Port();
    for (const env of [{ ...ENV_OK, SUPABASE_URL: "https://witulfbpotimvbfiqbwq.supabase.co" }, { ...ENV_OK, NEXT_PUBLIC_SUPABASE_URL: undefined }, { VERCEL_ENV: "preview" }]) {
      const r = await runP0(deps(port, { env }), input());
      expect(status(r, "ENV_SUPABASE_PROJECT").status).toBe("FAIL");
      expect(status(r, "CUSTOMER_EXISTS").status).toBe("NOT_RUN");
      expect(r.verdict).toBe("NOT_READY");
    }
    expect(port.calls).toEqual([]);
    const r = await runP0(deps(port, { env: { ...ENV_OK, SUPABASE_URL: "https://witulfbpotimvbfiqbwq.supabase.co" } }), input());
    expect(status(r, "ENV_SUPABASE_PROJECT").detail).toMatch(/different project \(witulfbpotimvbfiqbwq\)/);
    expect(JSON.stringify(r)).not.toMatch(/service_role|eyJ/);
  });
  it("never picks a Cin7 instance: none, several, or a different one is a FAIL and nothing is read", async () => {
    const port = new Port();
    const none = await runP0(deps(port, { instances: [] }), input());
    const many = await runP0(deps(port, { instances: [POC, { id: "other", name: "Other" }] }), input());
    const other = await runP0(deps(port, { instances: [{ id: "other", name: "Spark Demo" }] }), input());
    for (const r of [none, many, other]) { expect(status(r, "CIN7_INSTANCE").status).toBe("FAIL"); expect(status(r, "SKUS_EXIST").status).toBe("NOT_RUN"); expect(r.verdict).toBe("NOT_READY"); }
    expect(status(many, "CIN7_INSTANCE").detail).toMatch(/will not choose one/);
    expect(status(other, "CIN7_INSTANCE").detail).toMatch(/Spark Demo/);
    expect(port.calls).toEqual([]);
  });
  it("refuses operational customers and never falls back to a similar customer", async () => {
    for (const n of ["AGRICO", "Afgri Poultry", "amanzimnengi farms (pty)"]) {
      const r = await runP0(deps(new Port()), input({ customerName: n }));
      expect(status(r, "CUSTOMER_NOT_OPERATIONAL").status).toBe("FAIL");
      expect(r.verdict).toBe("NOT_READY");
    }
    const port = new Port();
    const r = await runP0(deps(port), input({ customerName: "p0 test customer" })); // wrong case: not the same name
    expect(status(r, "CUSTOMER_EXISTS")).toMatchObject({ status: "FAIL" });
    expect(status(r, "CUSTOMER_EXISTS").detail).toMatch(/never picks a similar one/);
    expect(status(r, "CUSTOMER_DEFAULTS").status).toBe("NOT_RUN");
    expect(status(r, "NO_EXISTING_SALE").status).toBe("NOT_RUN");
  });
  it("compares the customer's defaults to the intended tax rule, revenue account and location", async () => {
    const p = new Port(); p.customers.set("P0 Test Customer", { taxRule: "Zero Rated", revenueAccount: "400", location: "OTHER" });
    const r = await runP0(deps(p), input());
    expect(status(r, "CUSTOMER_DEFAULTS").status).toBe("FAIL");
    expect(status(r, "CUSTOMER_DEFAULTS").detail).toMatch(/tax rule is "Zero Rated", expected "Standard Rate Sales"; .*revenue account is "400", expected "200"; .*default location is "OTHER", expected "MSTR"/);
    const p2 = new Port(); p2.customers.set("P0 Test Customer", { taxRule: null, revenueAccount: null, location: null });
    expect(status(await runP0(deps(p2), input()), "CUSTOMER_DEFAULTS").detail).toMatch(/tax rule is not set.*revenue account is not set/);
  });
  it("SKUs: missing, duplicated, bad quantity, assembly mismatch", async () => {
    expect(status(await runP0(deps(new Port()), input({ skus: [{ sku: "NOPE", quantity: 1 }] })), "SKUS_EXIST")).toMatchObject({ status: "FAIL", detail: "Missing from Cin7: NOPE." });
    expect(status(await runP0(deps(new Port()), input({ skus: [{ sku: "NQ2886", quantity: 1 }, { sku: "NQ2886", quantity: 1 }] })), "INPUT_SKUS").status).toBe("FAIL");
    expect(status(await runP0(deps(new Port()), input({ skus: [{ sku: "NQ2886", quantity: 0 }] })), "INPUT_SKUS").status).toBe("FAIL");
    expect(status(await runP0(deps(new Port()), input({ skus: [] })), "INPUT_SKUS").status).toBe("FAIL");
    expect(status(await runP0(deps(new Port()), input({ skus: [{ sku: "NQ-ASM", quantity: 1, expectAssembly: false }] })), "SKU_ASSEMBLY").status).toBe("FAIL");
    expect(status(await runP0(deps(new Port()), input({ skus: [{ sku: "NQ-ASM", quantity: 1, expectAssembly: true }, { sku: "NQ2886", quantity: 1, expectAssembly: false }] })), "SKU_ASSEMBLY").status).toBe("PASS");
  });
  it("stock must exist at the named location in the needed quantity; unreadable is a failure, not zero", async () => {
    const p = new Port();
    expect(status(await runP0(deps(p), input({ skus: [{ sku: "NQ2886", quantity: 11 }] })), "STOCK_AVAILABLE").detail).toMatch(/10 available at "MSTR", 11 needed/);
    expect(status(await runP0(deps(p), input({ location: "ELSEWHERE" })), "STOCK_AVAILABLE").detail).toMatch(/no stock row at "ELSEWHERE"/);
    p.stock.NQ2886 = [{ location: "MSTR", available: null }];
    expect(status(await runP0(deps(p), input()), "STOCK_AVAILABLE").detail).toMatch(/unreadable/);
  });
  it("a Sale already carrying the ExternalID is a FAIL (creation would duplicate)", async () => {
    const p = new Port(); p.found = [{ saleId: "s", saleNumber: "SO-00300" }];
    expect(status(await runP0(deps(p), input()), "NO_EXISTING_SALE")).toMatchObject({ status: "FAIL" });
  });
  it("performs only reads: the port has no write method and the report contains no secrets", async () => {
    const p = new Port();
    await runP0(deps(p), input());
    expect(p.calls.every((c) => /^(customerExists|customerDefaults|resolveProducts|assemblySkus|stockAt|findByExternalId)/.test(c))).toBe(true);
    expect(Object.getOwnPropertyNames(Port.prototype).filter((n) => /create|post|put|delete|update/i.test(n))).toEqual([]);
  });
});
