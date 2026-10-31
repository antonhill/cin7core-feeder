import ts from "typescript";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Static import-boundary scanner for the RWTSA demonstration code (used by boundary.test.ts).
 *
 * WHAT IT PROVES, precisely: every first-party source file under the audited roots, and every file reachable from
 * them through relative or `@/` imports (the transitive closure), parses to a TypeScript AST that (a) imports only
 * from a fixed allowlist of packages / Node modules / first-party files, (b) contains no dynamic `import()`,
 * `require`, `createRequire` or `import x = require()`, (c) references none of a fixed list of network, worker,
 * code-evaluation and global-object identifiers or property names, (d) touches `process` only through a small
 * allowlist (and `process.env` only for named RWTSA_* variables in runtime code), and (e) contains no
 * http(s)/ws(s)/ftp URL literal. Comments and string contents are never mistaken for code because this works on the
 * AST, not on text.
 *
 * WHAT IT DOES NOT PROVE: it is NOT a sandbox and does not defend against deliberately malicious code. It does not
 * audit third-party packages (`exceljs`, `zod`, `typescript`) or Node itself. `node:fs` is allowed, so arbitrary file
 * reads and writes remain possible. Code could still obtain capabilities by means this list does not anticipate.
 * It is a review-time tripwire against accidental or unreviewed imports of Supabase, Cin7, network APIs or other
 * application modules, plus the specific evasions listed in boundary.test.ts.
 */

export type Profile = "runtime" | "test";

export interface ScanContext {
  /** Repository root (used to resolve `@/` to `<root>/src`). */
  readonly rootDir: string;
  /** Directories whose code is audited (and which relative/`@/` imports may stay inside). */
  readonly boundaryRoots: readonly string[];
  /** The only first-party files OUTSIDE the boundary roots that may be imported (scanned too, transitively). */
  readonly externalFiles: readonly string[];
}

export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cts", ".cjs", ".mts", ".mjs"] as const;
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, ".json"];

export const RUNTIME_BARE_ALLOWLIST: ReadonlySet<string> = new Set(["exceljs", "zod", "node:fs", "node:path", "node:crypto", "node:os"]);
export const TEST_BARE_ALLOWLIST: ReadonlySet<string> = new Set([...RUNTIME_BARE_ALLOWLIST, "vitest", "typescript", "node:child_process"]);

const BANNED_IDENTIFIERS: ReadonlySet<string> = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "RTCPeerConnection", "Worker", "SharedWorker", "importScripts",
  "eval", "Function", "require", "createRequire", "navigator", "globalThis", "global", "self", "window", "Deno", "Bun",
]);
const BANNED_PROPERTY_NAMES: ReadonlySet<string> = new Set(["fetch", "sendBeacon", "constructor", "__proto__", "binding", "dlopen", "mainModule", "_linkedBinding", "createRequire"]);
const RUNTIME_PROCESS_ALLOWED: ReadonlySet<string> = new Set(["argv", "exit", "exitCode", "env"]);
const TEST_PROCESS_BANNED: ReadonlySet<string> = new Set(["binding", "dlopen", "mainModule", "kill", "abort", "reallyExit", "_linkedBinding"]);
const RWTSA_ENV_NAME = /^RWTSA_[A-Z0-9_]+$/;
const NETWORK_URL = /^\s*(https?|wss?|ftp):\/\//i;

export interface FileScan {
  readonly violations: string[];
  /** Real paths of first-party files this file imports (to scan transitively). */
  readonly imports: string[];
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Resolves an import target (without guessing outside the filesystem) to a canonical real path, or null. */
function resolveFile(base: string): string | null {
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((e) => base + e), ...RESOLVE_EXTENSIONS.map((e) => path.join(base, `index${e}`))];
  for (const c of candidates) {
    if (existsSync(c) && lstatSync(c).isFile()) return realOrNull(c);
  }
  return null;
}

function scriptKind(file: string): ts.ScriptKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** True when `node` is the NAME in a property-like position (not a reference to a binding). */
function isPropertyNamePosition(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === node) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  return false;
}

/** Scans one file's text. `file` must be an absolute path (used for relative resolution and messages). */
export function scanFile(ctx: ScanContext, file: string, text: string, profile: Profile): FileScan {
  const violations: string[] = [];
  const imports: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const rel = path.relative(ctx.rootDir, file);
  const bare = profile === "test" ? TEST_BARE_ALLOWLIST : RUNTIME_BARE_ALLOWLIST;
  const externalReal = ctx.externalFiles.map((f) => realOrNull(f) ?? f);
  const rootsReal = ctx.boundaryRoots.map((r) => realOrNull(r) ?? r);

  const report = (node: ts.Node, msg: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`${rel}:${line + 1}: ${msg}`);
  };

  const checkFirstParty = (node: ts.Node, spec: string, absBase: string) => {
    const resolved = resolveFile(absBase);
    if (!resolved) {
      report(node, `import "${spec}" cannot be resolved (failing closed)`);
      return;
    }
    if (rootsReal.some((r) => isInside(r, resolved)) || externalReal.includes(resolved)) imports.push(resolved);
    else report(node, `import "${spec}" resolves outside the audited boundary`);
  };

  const checkSpecifier = (node: ts.Node, spec: string) => {
    if (spec.startsWith(".")) {
      checkFirstParty(node, spec, path.resolve(path.dirname(file), spec));
    } else if (spec.startsWith("@/")) {
      const rest = spec.slice(2);
      if (rest.split("/").includes("..") || rest.startsWith("/")) {
        report(node, `alias import "${spec}" contains path traversal`);
        return;
      }
      checkFirstParty(node, spec, path.join(ctx.rootDir, "src", path.posix.normalize(rest)));
    } else if (!bare.has(spec)) {
      report(node, `import "${spec}" is not on the ${profile} allowlist`);
    }
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      report(node, "`import x = require(...)` is not allowed");
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
      if (lit && ts.isStringLiteral(lit)) checkSpecifier(node, lit.text);
      else report(node, "non-literal import type");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, "dynamic import() is not allowed");
    }

    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (BANNED_IDENTIFIERS.has(name) && !isPropertyNamePosition(node)) report(node, `banned identifier "${name}"`);
      if (name === "process") {
        const p = node.parent;
        if (!(p && ts.isPropertyAccessExpression(p) && p.expression === node)) report(node, "`process` may only be used as `process.<allowed property>`");
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const prop = node.name.text;
      if (BANNED_PROPERTY_NAMES.has(prop)) report(node, `banned property "${prop}"`);
      if (ts.isIdentifier(node.expression) && node.expression.text === "process") {
        if (profile === "runtime" && !RUNTIME_PROCESS_ALLOWED.has(prop)) report(node, `process.${prop} is not allowed`);
        if (profile === "test" && TEST_PROCESS_BANNED.has(prop)) report(node, `process.${prop} is not allowed`);
        if (profile === "runtime" && prop === "env") {
          const outer = node.parent;
          const named = outer && ts.isPropertyAccessExpression(outer) && outer.expression === node && RWTSA_ENV_NAME.test(outer.name.text);
          const namedElem = outer && ts.isElementAccessExpression(outer) && outer.expression === node && ts.isStringLiteral(outer.argumentExpression) && RWTSA_ENV_NAME.test(outer.argumentExpression.text);
          if (!named && !namedElem) report(node, "process.env may only be read as a named RWTSA_* variable");
        }
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && BANNED_PROPERTY_NAMES.has(node.argumentExpression.text)) {
      report(node, `banned property "${node.argumentExpression.text}"`);
    }

    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && NETWORK_URL.test(node.text)) report(node, "network URL literal");

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, imports };
}

export interface TreeScan {
  readonly violations: string[];
  /** Real paths of every file scanned (roots plus the transitive closure). */
  readonly visited: string[];
}

function walk(dir: string, rootDir: string, violations: string[], out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      violations.push(`${path.relative(rootDir, full)}: symlink inside the audited boundary`);
    } else if (st.isDirectory()) {
      walk(full, rootDir, violations, out);
    } else if ((CODE_EXTENSIONS as readonly string[]).includes(path.extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
}

/** Scans every code file under the boundary roots (all 8 extensions, including `__tests__`), then everything they import. */
export function scanTree(ctx: ScanContext): TreeScan {
  const violations: string[] = [];
  const entries: string[] = [];
  for (const root of ctx.boundaryRoots) walk(root, ctx.rootDir, violations, entries);

  const visited = new Set<string>();
  const queue = [...entries];
  const externalReal = new Set(ctx.externalFiles.map((f) => realOrNull(f) ?? f));
  while (queue.length > 0) {
    const file = queue.pop()!;
    const real = realOrNull(file) ?? file;
    if (visited.has(real)) continue;
    visited.add(real);
    if (!(CODE_EXTENSIONS as readonly string[]).includes(path.extname(real).toLowerCase())) continue; // data file (e.g. .json): inside-boundary check already done
    const profile: Profile = !externalReal.has(real) && real.split(path.sep).includes("__tests__") ? "test" : "runtime";
    const scan = scanFile(ctx, real, readFileSync(real, "utf8"), profile);
    violations.push(...scan.violations);
    queue.push(...scan.imports);
  }
  return { violations, visited: [...visited] };
}
