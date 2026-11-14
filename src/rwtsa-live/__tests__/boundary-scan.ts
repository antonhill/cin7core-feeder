import path from "node:path";
import ts from "typescript";

const LIVE = path.resolve(__dirname, "..");
const SCRIPTS = path.resolve(__dirname, "..", "..", "..", "scripts", "rwtsa-live");
const DEMO_WB = path.resolve(__dirname, "..", "..", "rwtsa-demo", "workbook");
const inside = (target: string, root: string) => target === root || target.startsWith(root + path.sep);

/**
 * AST scanner for the RWTSA live module. It reasons about syntax nodes, not text, so comment/string tricks (`"//"`, `/*` in a string,
 * line-blanking) cannot hide a forbidden import or network call. It is a review-time tripwire, NOT a sandbox.
 */
export type Role = "client" | "module" | "script";
const NODE_OK = new Set(["node:fs", "node:os", "node:path", "node:crypto"]);
const BANNED_IDENT = new Set(["XMLHttpRequest", "WebSocket", "EventSource", "eval", "Function", "globalThis", "global", "Reflect", "Request", "Bun", "Deno", "self", "window", "setInterval", "setImmediate", "importScripts", "createRequire", "require", "getBuiltinModule", "dlopen"]);
const PROCESS_OK = new Set(["platform", "getuid", "pid", "argv", "exit", "stdin", "stdout"]);
const BANNED_METHOD = /^(POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/i;

function specifierAllowed(spec: string, role: Role, fileName: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = path.resolve(path.dirname(fileName), spec);
    if (inside(target, LIVE)) return true;
    if (role === "script" && inside(target, SCRIPTS)) return true;
    return role === "script" && (target === path.join(DEMO_WB, "build-dataset") || target === path.join(DEMO_WB, "read"));
  }
  if (NODE_OK.has(spec)) return true;
  if (spec === "@/cin7/api-origin") return true;
  if (spec.startsWith("@/rwtsa-live/")) return !spec.split("/").some((p) => p === ".." || p === ".");
  return role === "script" && /^@\/rwtsa-demo\/workbook\/(build-dataset|read)$/.test(spec);
}

/** Constant string value of a (possibly concatenated) literal expression, else undefined. */
function constText(n: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isParenthesizedExpression(n)) return constText(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { const l = constText(n.left), r = constText(n.right); return l !== undefined && r !== undefined ? l + r : undefined; }
  return undefined;
}

export function scanSource(text: string, fileName: string, role: Role): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const v: string[] = [];
  const add = (n: ts.Node, m: string) => v.push(`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${m}`);
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!specifierAllowed(n.moduleSpecifier.text, role, fileName)) add(n, `forbidden import "${n.moduleSpecifier.text}"`);
    }
    if (ts.isImportEqualsDeclaration(n)) add(n, "import = require is forbidden");
    if (ts.isImportTypeNode(n)) add(n, "import() type is forbidden");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) add(n, "dynamic import is forbidden");
    if (ts.isIdentifier(n)) {
      if (BANNED_IDENT.has(n.text)) add(n, `forbidden identifier ${n.text}`);
      if (n.text === "fetch" && role !== "client") add(n, "fetch is only allowed in client.ts");
      if (n.text === "setTimeout" && role !== "client") add(n, "setTimeout is only allowed in client.ts (pacing/backoff)");
      if (n.text === "process") {
        const p = n.parent;
        const okUse = ts.isPropertyAccessExpression(p) && p.expression === n && PROCESS_OK.has(p.name.text);
        if (!okUse && !(ts.isPropertyAccessExpression(p) && p.name === n)) add(n, "process may only be used for platform/getuid/pid/argv/exit");
      }
    }
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (name === "constructor" || name === "binding") add(n, `forbidden property .${name}`);
      if (name === "fetch" && role !== "client") add(n, "fetch property access outside client.ts");
    }
    if (ts.isElementAccessExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === "process") add(n, "process[...] is forbidden");
      // Ordinary lookups (byRole[role]) are fine: reaching a network primitive needs a global receiver (globalThis/self/window/Bun/Deno/process),
      // and every one of those identifiers is itself banned above. What remains is a literal name that spells a sensitive member.
      if (ts.isStringLiteralLike(n.argumentExpression) && /^(fetch|constructor|env|binding|Function)$/.test(n.argumentExpression.text)) add(n, "string element access to a sensitive name");
    }
    if (ts.isStringLiteralLike(n)) {
      const t = n.text;
      if (/api-auth-/i.test(t) && role !== "client") add(n, "Cin7 auth header name outside client.ts");
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) add(n, "URL literal (the Cin7 origin must come from @/cin7/api-origin)");
      if (BANNED_METHOD.test(t)) add(n, `non-GET HTTP method literal "${t}"`);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const t = constText(n);
      if (t !== undefined && (/api-auth-/i.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || BANNED_METHOD.test(t))) add(n, "concatenated literal forms a forbidden header/URL/method");
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "method") add(n, "shorthand `method` cannot be proven GET");
    if (ts.isComputedPropertyName(n) && constText(n.expression) === "method") add(n, "computed `method` key cannot be proven GET");
    if (ts.isTemplateExpression(n) && /api-auth-|:\/\//i.test(n.head.text + n.templateSpans.map((s) => s.literal.text).join(""))) add(n, "header/URL in a template literal");
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "method" && !(ts.isStringLiteral(n.initializer) && n.initializer.text === "GET")) add(n, "method must be the literal \"GET\"");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return v;
}

/** Module specifiers (static import/export-from, dynamic import, require) that mention a path fragment, for the "who imports rwtsa-live" check. */
export function importersOf(text: string, fileName: string, fragment: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.includes(fragment)) hits.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.includes(fragment)) hits.push(n.arguments[0].text);
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal) && n.argument.literal.text.includes(fragment)) hits.push(n.argument.literal.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}
