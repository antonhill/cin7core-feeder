import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * POC guard: nothing in the Projects module may reach Cin7. No import from src/cin7, no fetch, no
 * Xero/Lemon Squeezy/Resend client. A Cin7 write (P5) needs a separate, explicit authorisation —
 * adding one must be a deliberate edit to THIS test, not a side effect.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const DIRS = ["src/lib/projects", "src/app/projects"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const sources = DIRS.flatMap((d) => files(join(ROOT, d)));
/**
 * DELIBERATE EDIT (Cin7 claim posting slice): the Cin7 write path is allowed to exist in exactly ONE Projects file — the adapter that
 * implements the store's injected port. Every other Projects file still may not import Cin7, and nothing in the module may call fetch
 * or mention Xero. The write itself lives in src/cin7/sale-invoice-write.ts (classified in docs/cin7-post-classification.json) and is
 * only reachable through cin7-posting-store.ts's flag/manager/state gates.
 */
const CIN7_ADAPTER = "src/lib/projects/cin7-adapter.ts";
/** DELIBERATE EDIT (Advanced Sale creation slice): the second, and only other, adapter - it implements the Sale-creation store's injected port. */
const CIN7_SALE_CREATION_ADAPTER = "src/lib/projects/cin7-sale-creation-adapter.ts";
/** DELIBERATE EDIT (physical visibility slice): a third adapter that only READS (GET) - pinned below to contain no write verb. */
const CIN7_PHYSICAL_ADAPTER = "src/lib/projects/physical-adapter.ts";
/** DELIBERATE EDIT (cost estimate slice): a fourth adapter that only READS (GET /Product) the supplier costs for the NewQuip cost estimate - pinned below to contain no write verb. */
const CIN7_COST_ADAPTER = "src/lib/projects/latest-cost-adapter.ts";
/** DELIBERATE EDIT (UAT-010 pick lists): a fifth adapter that only READS locations and the Chart of Accounts - pinned below to contain no write verb. */
const CIN7_REFERENCE_ADAPTER = "src/lib/projects/cin7-reference-adapter.ts";
const ADAPTERS = [CIN7_ADAPTER, CIN7_SALE_CREATION_ADAPTER, CIN7_PHYSICAL_ADAPTER, CIN7_COST_ADAPTER, CIN7_REFERENCE_ADAPTER];

describe("Projects POC has no Cin7 / external write path", () => {
  it("found source files to check", () => expect(sources.length).toBeGreaterThan(5));
  it.each(sources.map((s) => [s.replace(ROOT + "/", ""), s]))("%s imports nothing from Cin7 or external services and never calls fetch", (_n, file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const bad: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const spec = (n.moduleSpecifier as ts.StringLiteral | undefined)?.text ?? "";
        const isAdapter = ADAPTERS.includes(file.replace(ROOT + "/", ""));
        const re = isAdapter ? /xero|lemonsqueezy|resend|@\/sync|@\/import/ : /(^|\/)cin7(\/|$)|xero|lemonsqueezy|resend|@\/sync|@\/import/;
        if (re.test(spec)) bad.push(`import ${spec}`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") bad.push("fetch()");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bad).toEqual([]);
  });
  it("only the adapter imports Cin7, and the store/rules/actions reach Cin7 solely through it", () => {
    const importers = sources.filter((f) => /from "@\/cin7\//.test(readFileSync(f, "utf8"))).map((f) => f.replace(ROOT + "/", ""));
    expect(importers.sort()).toEqual([...ADAPTERS].sort());
  });
  it("no source mentions the invoice-create endpoint", () => {
    for (const f of sources) expect(readFileSync(f, "utf8")).not.toMatch(/sale\/invoice|\/saleInvoice|nonIdempotentCreate/i);
  });
});

describe.each(["src/app/projects/actions.ts", "src/app/projects/cin7-actions.ts", "src/app/projects/variation-billing-actions.ts", "src/app/projects/physical-actions.ts", "src/app/projects/profitability-actions.ts", "src/app/projects/delivery-actions.ts"])('%s honours the "use server" rule', (rel) => {
  it("exports only async functions and erased interfaces", () => {
    const file = join(ROOT, rel);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    sf.forEachChild((n) => {
      const exported = ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(n) || ts.isExportAssignment(n)) offenders.push("export {...}/default");
      if (!exported) return;
      if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
      const isAsyncFn = ts.isFunctionDeclaration(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (!isAsyncFn) offenders.push(ts.isVariableStatement(n) ? "exported const" : ts.SyntaxKind[n.kind]);
    });
    expect(offenders).toEqual([]);
  });
});

describe("delivery allocation writes only local tables", () => {
  it.each(["src/lib/projects/delivery-allocation.ts", "src/lib/projects/delivery-allocation-store.ts", "src/app/projects/delivery-actions.ts"])("%s makes no Cin7 call", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(src).not.toMatch(/nonIdempotentCreate|sale\/invoice|sale\/order|@\/cin7\//);
  });
});

describe("the physical-visibility path can only read", () => {
  it.each(["src/lib/projects/cin7-reference-adapter.ts", "src/lib/projects/cin7-account-eligibility.ts", "src/lib/projects/physical-adapter.ts", "src/lib/projects/physical-store.ts", "src/lib/projects/physical-status.ts", "src/app/projects/physical-actions.ts", "src/app/projects/profitability-actions.ts", "src/lib/projects/profitability.ts", "src/lib/projects/profitability-store.ts", "src/cin7/sale-inspect.ts", "src/lib/projects/latest-cost-adapter.ts", "src/cin7/latest-cost.ts"])("%s contains no write verb or create endpoint", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(src).not.toMatch(/nonIdempotentCreate|sale\/invoice|sale\/order|\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
  });
});

describe.each(["probe-sale-invoices-readonly.mjs", "probe-product-costs-readonly.mjs"])("%s: the read-only Cin7 probe script can only read (see also probe-support.test.ts)", (file) => {
  const script = readFileSync(join(ROOT, "scripts", file), "utf8");
  it("contains no write verbs and a single network function", () => {
    expect(script).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(script).not.toMatch(/method:\s*["'](?!GET)/);
    expect(script.match(/\bfetch\(/g)).toHaveLength(1);
  });
  it("never prints or persists secret values", () => {
    // secret VALUES (identifiers / process.env reads) must not reach console or a template literal
    expect(script).not.toMatch(/console\.\w+\(\s*(APP_KEY|ACCOUNT_ID|process\.env)/);
    expect(script).not.toMatch(/console\.\w+\([^)]*,\s*(APP_KEY|process\.env\.\w+)\s*[,)]/);
    expect(script).not.toMatch(/\$\{\s*(APP_KEY|process\.env\.(SUPABASE_SERVICE_ROLE_KEY|ENCRYPTION_KEY))/);
    expect(script).not.toMatch(/writeFile|appendFile|createWriteStream/);
    expect(script).not.toMatch(/application_key_encrypted[^\n]*console|console[^\n]*application_key_encrypted/);
  });
});
