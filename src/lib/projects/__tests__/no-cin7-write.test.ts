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

describe("Projects POC has no Cin7 / external write path", () => {
  it("found source files to check", () => expect(sources.length).toBeGreaterThan(5));
  it.each(sources.map((s) => [s.replace(ROOT + "/", ""), s]))("%s imports nothing from Cin7 or external services and never calls fetch", (_n, file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const bad: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const spec = (n.moduleSpecifier as ts.StringLiteral | undefined)?.text ?? "";
        if (/(^|\/)cin7(\/|$)|xero|lemonsqueezy|resend|@\/sync|@\/import/.test(spec)) bad.push(`import ${spec}`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") bad.push("fetch()");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bad).toEqual([]);
  });
  it("no source mentions the invoice-create endpoint", () => {
    for (const f of sources) expect(readFileSync(f, "utf8")).not.toMatch(/sale\/invoice|\/saleInvoice|nonIdempotentCreate/i);
  });
});

describe('src/app/projects/actions.ts honours the "use server" rule', () => {
  it("exports only async functions and erased interfaces", () => {
    const file = join(ROOT, "src/app/projects/actions.ts");
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

describe("the read-only Cin7 probe script can only read (see also probe-support.test.ts)", () => {
  const script = readFileSync(join(ROOT, "scripts/probe-sale-invoices-readonly.mjs"), "utf8");
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
