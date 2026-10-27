import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyDiagnosticSales, DIAGNOSTIC_SALES } from "../cin7-sale-diagnostic";

const sale = (over = {}) => ({ id: "x", type: "Advanced Sale", taxRule: "Standard", orderStatus: "AUTHORISED", saleNumber: "SO-1", ...over });
const root = join(__dirname, "..", "..", "..", "..");

describe("temporary Cin7 sale diagnostic", () => {
  it("refuses outside the rollout org and for non-managers, before any Cin7 read", async () => {
    const read = vi.fn();
    await expect(classifyDiagnosticSales({ orgEnabled: false, isManager: true }, read)).rejects.toThrow();
    await expect(classifyDiagnosticSales({ orgEnabled: true, isManager: false }, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("reads only the two fixed sales and returns only the five classification fields", async () => {
    const read = vi.fn(async (id: string) => ({ ...sale({ id }), invoices: [{ memo: "secret" }], customer: "Acme" }));
    const rows = await classifyDiagnosticSales({ orgEnabled: true, isManager: true }, read);
    expect(read.mock.calls.map((c) => c[0])).toEqual(DIAGNOSTIC_SALES.map((s) => s.saleId));
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["label", "orderStatus", "requestedSaleId", "saleId", "saleOrderNumber", "taxRule", "type"]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|Acme/);
  });
  it("shows the raw Type verbatim (quoted) and absent fields explicitly", async () => {
    const rows = await classifyDiagnosticSales({ orgEnabled: true, isManager: true }, async () => sale({ type: "Simple Sale ", taxRule: null }));
    expect(rows[0].type).toBe('"Simple Sale "');
    expect(rows[0].taxRule).toBe("(absent)");
  });
  it("a failed read is reported per sale with a bounded message, not thrown", async () => {
    const rows = await classifyDiagnosticSales({ orgEnabled: true, isManager: true }, async () => { throw new Error("x".repeat(500)); });
    expect(rows[0].error?.length).toBeLessThanOrEqual(200);
  });
  it("is read-only: the diagnostic files contain no write verbs, and the Advanced Sale check is unchanged", () => {
    for (const f of ["src/lib/projects/cin7-sale-diagnostic.ts", "src/app/projects/cin7-diagnostic/page.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|createInvoice|method:\s*"(POST|PUT|DELETE)"|process\.env/);
    }
    expect(readFileSync(join(root, "src/lib/projects/cin7-posting-store.ts"), "utf8")).toContain('!== "advanced sale"');
  });
});
