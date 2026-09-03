import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Security re-audit final closure, regression guardrail #5. Every Cin7
 * mutation in this codebase must be explicitly classified — see
 * docs/cin7-post-classification.json for what each classification means and
 * the investigation it snapshots. An unclassified mutation fails this test,
 * forcing a deliberate decision before merge rather than a silently
 * unreviewed new write path (the exact "fixed the examples, missed a
 * sibling" pattern the whole closure pass exists to stop).
 *
 * REPAIRED 2026-09-03. The original guard made a stronger claim than it
 * enforced, in two distinct ways:
 *
 *   1. It matched only the literal text `method: "POST" | "PUT"`, so
 *      `method: exists ? "PUT" : "POST"` (production-bom.ts) and the
 *      shorthand `method,` where method is a parameter (debug.ts) both
 *      escaped it entirely.
 *   2. It skipped a whole FILE once any registry row named that file, so a
 *      second mutating function added to an already-registered file needed
 *      no classification of its own.
 *
 * Both are closed here by discovering mutations from the TypeScript AST at
 * file+function granularity. The scanner is deliberately CONSERVATIVE: a
 * method expression it cannot prove non-mutating counts as a mutation, so an
 * unrecognised dynamic shape fails loudly instead of passing silently. That
 * is the opposite of the old regex's default, which was to pass anything it
 * did not recognise.
 *
 * Two further bypasses were closed in review:
 *
 *   3. DELETE. http.ts's own method union is GET|POST|PUT|DELETE and it
 *      paces anything that is not GET as a write, but the scanner only
 *      recognised POST and PUT — so a future literal `method: "DELETE"`
 *      would have passed silently. DELETE is now mutation-capable. There is
 *      deliberately NO DELETE classification in the taxonomy: no DELETE call
 *      site exists today, and when one is added the guard will fail for lack
 *      of a registry row, forcing the taxonomy decision at that moment
 *      rather than pre-inventing one.
 *
 *   4. GATEWAY ALIASING. The scanner recognises a gateway call by its callee
 *      name, so `import { cin7Request as go }` — which still legitimately
 *      travels through the gateway, and so passes cin7-gateway-boundary's
 *      no-bare-fetch check — would have hidden a mutation from it. Rather
 *      than building a cross-file call graph, aliasing and rebinding the
 *      gateway identifiers is now forbidden outright and tested below.
 */

const ROOT = join(__dirname, "..", "..", "..");
const REGISTRY_PATH = join(ROOT, "docs", "cin7-post-classification.json");

/** The gateway helpers every Cin7 request must go through — see cin7-gateway-boundary.test.ts, which forbids bare fetch() alongside this. */
const GATEWAY_FUNCTIONS = new Set(["cin7Request", "cin7RawRequest"]);
/**
 * Every method http.ts treats as a write. Kept in step with that file's own
 * `method?: "GET" | "POST" | "PUT" | "DELETE"` union and its
 * `(options.method ?? "GET") !== "GET"` write test — an invariant asserted
 * below rather than assumed.
 */
const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE"]);
const GUARDED_DIRS = [join("src", "cin7"), join("src", "audit")];
const VALID_CLASSIFICATIONS = new Set(["IDEMPOTENT_POST", "NON_IDEMPOTENT_CREATE", "RECONCILE_BEFORE_RETRY", "VERIFIED_SAFE_POST_UPDATE"]);

interface RegistryEntry {
  file: string;
  function: string;
  classification: string;
  note?: string;
}
interface Exemption {
  file: string;
  function: string;
  reason: string;
}
interface Registry {
  entries: RegistryEntry[];
  exemptFunctions: Exemption[];
}

export interface DiscoveredMutation {
  file: string;
  function: string;
  line: number;
  /** How the request's `method` was expressed — why this call counts as a mutation. */
  shape: "literal" | "conditional" | "dynamic";
  methods: string[];
}

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...listTsFiles(full));
      // http.ts IS the gateway; its own internal method handling is not a call site.
    } else if (entry.endsWith(".ts") && entry !== "http.ts") {
      files.push(full);
    }
  }
  return files;
}

/**
 * Resolves what a request's `method` expression can evaluate to.
 *
 * Returns every string literal reachable through conditionals, `||`, `??`,
 * parentheses and type assertions, plus `unknown: true` when any branch is
 * something this analysis cannot see through (an identifier, a call, a
 * property access, a template with substitutions, a spread). An unknown
 * branch makes the call mutation-capable by default — a dynamic method the
 * guard cannot prove read-only must never pass silently.
 */
function resolveMethodExpression(expr: ts.Expression): { values: string[]; unknown: boolean } {
  const values: string[] = [];
  let unknown = false;

  const walk = (node: ts.Expression): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    } else if (ts.isConditionalExpression(node)) {
      walk(node.whenTrue);
      walk(node.whenFalse);
    } else if (ts.isParenthesizedExpression(node)) {
      walk(node.expression);
    } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      walk(node.left);
      walk(node.right);
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      walk(node.expression);
    } else if (ts.isNonNullExpression(node)) {
      walk(node.expression);
    } else {
      unknown = true;
    }
  };

  walk(expr);
  return { values, unknown };
}

/** The nearest enclosing NAMED function, so the registry can be keyed at function rather than file granularity. */
function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    current = current.parent;
  }
  return "(module scope)";
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text;
  return null;
}

/**
 * Every mutation-capable gateway call in one source file, as (function, shape).
 *
 * Exported shape rather than a file path so the guard's own failure modes can
 * be tested against synthetic sources — see the fixture tests below.
 */
export function findMutationCalls(relPath: string, sourceText: string): DiscoveredMutation[] {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true);
  const found: DiscoveredMutation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && GATEWAY_FUNCTIONS.has(name)) {
        // cin7RawRequest takes a query object, never a method — it is the
        // read-only diagnostics escape hatch and cannot mutate.
        if (name === "cin7Request") {
          const options = node.arguments[2];
          let shape: DiscoveredMutation["shape"] | null = null;
          let methods: string[] = [];

          if (options && ts.isObjectLiteralExpression(options)) {
            const methodProp = options.properties.find(
              (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "method"
            );
            if (methodProp && ts.isPropertyAssignment(methodProp)) {
              const resolved = resolveMethodExpression(methodProp.initializer);
              methods = resolved.values;
              if (resolved.unknown) shape = "dynamic";
              else if (resolved.values.some((v) => MUTATION_METHODS.has(v.toUpperCase()))) {
                shape = resolved.values.length > 1 ? "conditional" : "literal";
              }
            } else if (methodProp) {
              // `method,` shorthand — the value comes from a binding this
              // analysis cannot see through.
              shape = "dynamic";
            } else if (options.properties.some((p) => ts.isSpreadAssignment(p))) {
              // A spread could carry a method; assume the worst.
              shape = "dynamic";
            }
            // No method property and no spread => the gateway's GET default.
          } else if (options) {
            // Options passed as something other than an object literal.
            shape = "dynamic";
          }

          if (shape) {
            found.push({
              file: relPath,
              function: enclosingFunctionName(node),
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              shape,
              methods,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

const HTTP_MODULE_SPECIFIERS = new Set(["@/cin7/http", "./http", "../cin7/http", "@/cin7/http.js"]);

export interface GatewayBinding {
  file: string;
  line: number;
  kind: "aliased-import" | "namespace-import" | "rebound" | "non-call-reference";
  detail: string;
}

/**
 * Every place the gateway's identity could be lost.
 *
 * The mutation scanner recognises a gateway call by its callee name, so any
 * alias or rebinding would hide the call from it while still travelling
 * through the gateway — which means cin7-gateway-boundary.test.ts (bare
 * fetch / duplicated credential headers) does not catch it either.
 *
 * The convention enforced here, chosen over building a cross-file call
 * graph: **the gateway functions are imported under their own names and
 * referenced only as the callee of a direct call.** A namespace import of
 * the http module is forbidden too, so `http.cin7Request(...)` is not a
 * second supported spelling — there is exactly one.
 */
export function findGatewayBindingViolations(relPath: string, sourceText: string): GatewayBinding[] {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: GatewayBinding[] = [];
  const at = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const visit = (node: ts.Node): void => {
    // import { cin7Request as go } / import * as http from "@/cin7/http"
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && HTTP_MODULE_SPECIFIERS.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        violations.push({ file: relPath, line: at(node), kind: "namespace-import", detail: `import * as ${bindings.name.text} from "${node.moduleSpecifier.text}"` });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.propertyName && GATEWAY_FUNCTIONS.has(el.propertyName.text)) {
            violations.push({ file: relPath, line: at(el), kind: "aliased-import", detail: `${el.propertyName.text} as ${el.name.text}` });
          }
        }
      }
    }

    // const go = cin7Request  /  const go = something.cin7Request
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const referenced =
        (ts.isIdentifier(init) && GATEWAY_FUNCTIONS.has(init.text) && init.text) ||
        (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.name) && GATEWAY_FUNCTIONS.has(init.name.text) && init.name.text);
      if (referenced) {
        violations.push({ file: relPath, line: at(node), kind: "rebound", detail: `${node.name.getText(sourceFile)} = ${init.getText(sourceFile)}` });
      }
    }

    // Any other mention of the identifier that is not the callee of a call —
    // passing it as an argument, returning it, storing it in an object, etc.
    if (ts.isIdentifier(node) && GATEWAY_FUNCTIONS.has(node.text)) {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      const isImportName = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
      const isDeclarationName =
        (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && (parent as { name?: ts.Node }).name === node;
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isPropertyAssignment(parent);
      if (!isCallee && !isImportName && !isDeclarationName && !isPropertyName) {
        violations.push({ file: relPath, line: at(node), kind: "non-call-reference", detail: node.text });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * cin7RawRequest is treated as read-only by the mutation scanner. That is
 * true only while http.ts keeps it GET-only, so the assumption is pinned
 * here rather than trusted: if a future edit gives it a method or body
 * option, or changes its hardcoded fetch method, this fails and the
 * classification architecture has to be revisited before it can ship.
 */
export function rawRequestShape(httpSource: string): { params: string[]; fetchMethods: string[]; mutationLiterals: string[] } {
  const sourceFile = ts.createSourceFile("http.ts", httpSource, ts.ScriptTarget.Latest, true);
  let decl: ts.FunctionDeclaration | undefined;
  const findDecl = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "cin7RawRequest") decl = node;
    ts.forEachChild(node, findDecl);
  };
  findDecl(sourceFile);
  if (!decl) return { params: ["(cin7RawRequest not found)"], fetchMethods: [], mutationLiterals: [] };

  const params = decl.parameters.map((p) => p.name.getText(sourceFile));
  const fetchMethods: string[] = [];
  const mutationLiterals: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "method") {
      fetchMethods.push(node.initializer.getText(sourceFile));
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "method") fetchMethods.push("(shorthand)");
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && MUTATION_METHODS.has(node.text.toUpperCase())) {
      mutationLiterals.push(node.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(decl);
  return { params, fetchMethods, mutationLiterals };
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Scans the real guarded surface. */
function discoverAll(): DiscoveredMutation[] {
  const out: DiscoveredMutation[] = [];
  for (const dir of GUARDED_DIRS) {
    for (const file of listTsFiles(join(ROOT, dir))) {
      out.push(...findMutationCalls(toPosix(relative(ROOT, file)), readFileSync(file, "utf8")));
    }
  }
  return out;
}

const key = (file: string, fn: string) => `${file}:${fn}`;

describe("Cin7 POST/PUT classification registry", () => {
  const registry: Registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const discovered = discoverAll();
  const discoveredKeys = new Set(discovered.map((d) => key(d.file, d.function)));
  const entryKeys = new Set(registry.entries.map((e) => key(e.file, e.function)));
  const exemptKeys = new Set(registry.exemptFunctions.map((e) => key(e.file, e.function)));

  it("every entry has a valid classification", () => {
    for (const entry of registry.entries) {
      expect(VALID_CLASSIFICATIONS.has(entry.classification), `${key(entry.file, entry.function)} has an unrecognized classification "${entry.classification}"`).toBe(true);
    }
  });

  it("every exemption carries a reason", () => {
    for (const exemption of registry.exemptFunctions) {
      expect(exemption.reason?.length ?? 0, `${key(exemption.file, exemption.function)} is exempt with no reason`).toBeGreaterThan(20);
    }
  });

  it("no function is both classified and exempt", () => {
    const both = [...entryKeys].filter((k) => exemptKeys.has(k));
    expect(both).toEqual([]);
  });

  /**
   * THE LOAD-BEARING CHECK. Function-level, so a registry row for
   * products.ts:pushProduct does not authorize a future
   * products.ts:createSomethingElse in the same file.
   */
  it("every discovered Cin7 mutation is classified or explicitly exempt, at file+function granularity", () => {
    const unclassified = discovered
      .filter((d) => !entryKeys.has(key(d.file, d.function)) && !exemptKeys.has(key(d.file, d.function)))
      .map((d) => `${key(d.file, d.function)} (line ${d.line}, ${d.shape} method${d.methods.length ? ` ${d.methods.join("|")}` : ""})`);
    expect(unclassified).toEqual([]);
  });

  it("no registry row is stale — its function must still exist AND still mutate", () => {
    const stale = registry.entries.filter((e) => !discoveredKeys.has(key(e.file, e.function))).map((e) => key(e.file, e.function));
    expect(stale).toEqual([]);
  });

  it("no exemption is stale — an exempt function must still exist and still mutate", () => {
    const stale = registry.exemptFunctions.filter((e) => !discoveredKeys.has(key(e.file, e.function))).map((e) => key(e.file, e.function));
    expect(stale).toEqual([]);
  });

  it("detects the dynamic and conditional method shapes the old text-matching guard missed", () => {
    const byKey = new Map(discovered.map((d) => [key(d.file, d.function), d]));

    // The known escape: production-bom's `exists ? "PUT" : "POST"`.
    const bom = byKey.get("src/cin7/production-bom.ts:pushProductionBom");
    expect(bom, "production-bom's conditional mutation was not discovered").toBeDefined();
    expect(bom!.shape).toBe("conditional");
    expect(bom!.methods.sort()).toEqual(["POST", "PUT"]);

    // The second escape found while repairing this guard: `method,` shorthand
    // where method is a parameter typed "POST" | "PUT".
    for (const fn of ["tryPurchaseRequest", "tryPurchaseOrderLines"]) {
      const probe = byKey.get(`src/cin7/debug.ts:${fn}`);
      expect(probe, `debug.ts:${fn} shorthand mutation was not discovered`).toBeDefined();
      expect(probe!.shape).toBe("dynamic");
    }
  });

  it("detects DELETE as a mutation, and no DELETE call site exists today", () => {
    // http.ts's own union is GET|POST|PUT|DELETE and it paces anything that
    // is not GET as a write, so DELETE must be mutation-capable here too.
    expect(MUTATION_METHODS.has("DELETE")).toBe(true);

    // There is deliberately no DELETE classification in the taxonomy. When
    // the first DELETE call site appears, the "classified or exempt" check
    // above fails for lack of a registry row, forcing the taxonomy decision
    // then rather than pre-inventing one now.
    const deletes = discovered.filter((d) => d.methods.some((m) => m.toUpperCase() === "DELETE"));
    expect(deletes, "a DELETE call site now exists — classify it and decide its taxonomy").toEqual([]);
  });

  it("no source file aliases, rebinds or otherwise loses the gateway's identity", () => {
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
        const rel = toPosix(relative(ROOT, full));
        // http.ts declares and exports them; it is the definition, not a caller.
        if (rel === "src/cin7/http.ts") continue;
        for (const v of findGatewayBindingViolations(rel, readFileSync(full, "utf8"))) {
          violations.push(`${v.file}:${v.line} ${v.kind} — ${v.detail}`);
        }
      }
    };
    walk(join(ROOT, "src"));
    // An alias would still travel through the gateway (so cin7-gateway-boundary
    // passes) while hiding the call from the mutation scanner above.
    expect(violations).toEqual([]);
  });

  it("cin7RawRequest is still GET-only — the scanner's read-only assumption about it", () => {
    const shape = rawRequestShape(readFileSync(join(ROOT, "src", "cin7", "http.ts"), "utf8"));

    // Signature: creds, path, query — no method, body, options or init.
    expect(shape.params).toEqual(["creds", "path", "query"]);
    // Its fetch method is the literal "GET", not a variable or a parameter.
    expect(shape.fetchMethods).toEqual(['"GET"']);
    // No POST/PUT/DELETE literal anywhere in its body.
    expect(shape.mutationLiterals).toEqual([]);
  });

  it("the guarded surface is exhaustive — no gateway call site exists outside src/cin7/ and src/audit/", () => {
    const stray: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
        const rel = toPosix(relative(ROOT, full));
        if (rel.startsWith("src/cin7/") || rel.startsWith("src/audit/")) continue;
        const source = readFileSync(full, "utf8");
        const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const name = calleeName(node.expression);
            if (name && GATEWAY_FUNCTIONS.has(name)) stray.push(`${rel}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
      }
    };
    walk(join(ROOT, "src"));
    // A gateway call outside the guarded directories would not be classified
    // by this registry at all — widen GUARDED_DIRS rather than deleting this.
    expect(stray).toEqual([]);
  });
});

/**
 * The guard's own failure modes, exercised against synthetic sources rather
 * than by editing real files. Each case is one way the previous guard could
 * be fooled.
 */
describe("Cin7 mutation scanner — failure modes", () => {
  const find = (src: string) => findMutationCalls("src/cin7/fixture.ts", src);

  it("detects a literal POST", () => {
    const found = find(`async function createThing(c){ await cin7Request(c, "/thing", { method: "POST", body: {} }); }`);
    expect(found.map((f) => [f.function, f.shape])).toEqual([["createThing", "literal"]]);
  });

  it("detects a literal PUT", () => {
    const found = find(`async function updateThing(c){ await cin7Request(c, "/thing", { method: "PUT", body: {} }); }`);
    expect(found).toHaveLength(1);
  });

  it("detects a conditional POST/PUT — the production-bom shape", () => {
    const found = find(`async function upsert(c, exists){ await cin7Request(c, "/thing", { method: exists ? "PUT" : "POST" }); }`);
    expect(found[0].shape).toBe("conditional");
    expect(found[0].methods.sort()).toEqual(["POST", "PUT"]);
  });

  it("detects a POST hidden behind ?? and || fallbacks", () => {
    expect(find(`async function f(c, m){ await cin7Request(c, "/t", { method: m ?? "POST" }); }`)).toHaveLength(1);
    expect(find(`async function g(c, m){ await cin7Request(c, "/t", { method: m || "PUT" }); }`)).toHaveLength(1);
  });

  it("treats an opaque dynamic method as a mutation rather than passing it silently", () => {
    expect(find(`async function f(c, m){ await cin7Request(c, "/t", { method: m }); }`)[0].shape).toBe("dynamic");
    expect(find(`async function g(c, m){ await cin7Request(c, "/t", { method: pick() }); }`)[0].shape).toBe("dynamic");
    expect(find(`async function h(c, o){ await cin7Request(c, "/t", { method: o.verb }); }`)[0].shape).toBe("dynamic");
  });

  it("treats the `method,` shorthand as a mutation — the debug.ts shape", () => {
    const found = find(`async function probe(c, method){ await cin7Request(c, "/t", { method, body: {} }); }`);
    expect(found[0].shape).toBe("dynamic");
  });

  it("treats a spread that could carry a method as a mutation", () => {
    expect(find(`async function f(c, opts){ await cin7Request(c, "/t", { ...opts }); }`)[0].shape).toBe("dynamic");
  });

  it("treats non-object options as a mutation", () => {
    expect(find(`async function f(c, opts){ await cin7Request(c, "/t", opts); }`)[0].shape).toBe("dynamic");
  });

  it("detects a literal DELETE — http.ts paces any non-GET as a write", () => {
    const found = find(`async function removeThing(c){ await cin7Request(c, "/thing", { method: "DELETE" }); }`);
    expect(found.map((f) => [f.function, f.shape])).toEqual([["removeThing", "literal"]]);
  });

  it("detects a conditional GET/DELETE — the DELETE branch is enough", () => {
    const found = find(`async function maybeRemove(c, gone){ await cin7Request(c, "/t", { method: gone ? "DELETE" : "GET" }); }`);
    expect(found).toHaveLength(1);
    expect(found[0].shape).toBe("conditional");
    expect(found[0].methods.sort()).toEqual(["DELETE", "GET"]);
  });

  it("does NOT classify an explicit literal GET as a mutation", () => {
    expect(find(`async function read(c){ await cin7Request(c, "/thing", { method: "GET" }); }`)).toEqual([]);
  });

  it("does NOT classify an ordinary GET as a mutation", () => {
    expect(find(`async function read(c){ await cin7Request(c, "/thing", { query: { page: 1 } }); }`)).toEqual([]);
    expect(find(`async function read2(c){ await cin7Request(c, "/thing"); }`)).toEqual([]);
    expect(find(`async function read3(c){ await cin7RawRequest(c, "/thing", { Page: "1" }); }`)).toEqual([]);
  });

  it("attributes a mutation to its own enclosing function, not the file", () => {
    const found = find(`
      async function readOnly(c){ await cin7Request(c, "/a", { query: {} }); }
      async function writer(c){ await cin7Request(c, "/b", { method: "POST" }); }
    `);
    expect(found.map((f) => f.function)).toEqual(["writer"]);
  });

  it("finds a SECOND mutating function in the same file — a registered file cannot hide a new one", () => {
    const found = find(`
      async function pushProduct(c){ await cin7Request(c, "/Product", { method: "PUT" }); }
      async function createSomethingElse(c){ await cin7Request(c, "/Other", { method: "POST" }); }
    `);
    expect(found.map((f) => f.function).sort()).toEqual(["createSomethingElse", "pushProduct"]);
  });
});

/**
 * The registry-matching rule itself, independent of the real repository —
 * proving the file-level skip that weakened the old guard cannot come back.
 */
describe("Cin7 mutation registry matching", () => {
  const entryKeys = new Set(["src/cin7/products.ts:pushProduct"]);
  const exemptKeys = new Set(["src/cin7/debug.ts:probeThing"]);
  const unclassified = (found: { file: string; function: string }[]) =>
    found.filter((d) => !entryKeys.has(key(d.file, d.function)) && !exemptKeys.has(key(d.file, d.function))).map((d) => key(d.file, d.function));

  it("accepts a mutation whose exact file+function is registered", () => {
    expect(unclassified([{ file: "src/cin7/products.ts", function: "pushProduct" }])).toEqual([]);
  });

  it("REJECTS a different function in an already-registered file", () => {
    expect(unclassified([{ file: "src/cin7/products.ts", function: "createSomethingElse" }])).toEqual(["src/cin7/products.ts:createSomethingElse"]);
  });

  it("REJECTS a mutation in an entirely unregistered file", () => {
    expect(unclassified([{ file: "src/cin7/brand-new.ts", function: "createThing" }])).toEqual(["src/cin7/brand-new.ts:createThing"]);
  });

  it("accepts an exempt function, and only that function in its file", () => {
    expect(unclassified([{ file: "src/cin7/debug.ts", function: "probeThing" }])).toEqual([]);
    expect(unclassified([{ file: "src/cin7/debug.ts", function: "newProbe" }])).toEqual(["src/cin7/debug.ts:newProbe"]);
  });
});

/**
 * The gateway-identity rules, against synthetic sources. Each case is a way
 * a real mutation could travel through the gateway while the name-based
 * mutation scanner above never saw it.
 */
describe("Cin7 gateway identity — alias and rebinding bypasses", () => {
  const check = (src: string) => findGatewayBindingViolations("src/cin7/fixture.ts", src);

  it("REJECTS an aliased import of cin7Request", () => {
    const v = check(`import { cin7Request as go } from "@/cin7/http";\nasync function createThing(c){ await go(c, "/Thing", { method: "POST" }); }`);
    expect(v.map((x) => x.kind)).toContain("aliased-import");
  });

  it("REJECTS an aliased import of cin7RawRequest", () => {
    expect(check(`import { cin7RawRequest as raw } from "@/cin7/http";`).map((x) => x.kind)).toContain("aliased-import");
  });

  it("REJECTS a local rebinding of the gateway", () => {
    expect(check(`import { cin7Request } from "@/cin7/http";\nconst go = cin7Request;`).map((x) => x.kind)).toContain("rebound");
    expect(check(`const go = cin7RawRequest;`).map((x) => x.kind)).toContain("rebound");
  });

  it("REJECTS rebinding through a property access", () => {
    expect(check(`const go = helpers.cin7Request;`).map((x) => x.kind)).toContain("rebound");
  });

  it("REJECTS a namespace import of the gateway module — one spelling only", () => {
    const v = check(`import * as http from "@/cin7/http";\nasync function f(c){ await http.cin7Request(c, "/t", { method: "POST" }); }`);
    expect(v.map((x) => x.kind)).toContain("namespace-import");
  });

  it("REJECTS passing the gateway around as a value", () => {
    expect(check(`import { cin7Request } from "@/cin7/http";\nregister(cin7Request);`).map((x) => x.kind)).toContain("non-call-reference");
  });

  it("ACCEPTS the one sanctioned form — a direct named import, called directly", () => {
    expect(check(`import { cin7Request } from "@/cin7/http";\nasync function pushThing(c){ await cin7Request(c, "/Thing", { method: "POST" }); }`)).toEqual([]);
    expect(check(`import { cin7Request, cin7RawRequest, Cin7ApiError } from "@/cin7/http";\nasync function f(c){ await cin7RawRequest(c, "/t"); }`)).toEqual([]);
  });

  it("does not flag an unrelated import from another module", () => {
    expect(check(`import { somethingElse as alias } from "@/lib/other";`)).toEqual([]);
  });
});

describe("cin7RawRequest GET-only invariant", () => {
  it("fails if the raw helper gains a method option", () => {
    const shape = rawRequestShape(`
      export async function cin7RawRequest(creds: C, path: string, query?: Q, options?: { method?: string }) {
        const r = await fetch(url, { method: options?.method ?? "GET" });
      }
    `);
    expect(shape.params).not.toEqual(["creds", "path", "query"]);
    expect(shape.fetchMethods).not.toEqual(['"GET"']);
  });

  it("fails if the raw helper's fetch method becomes a write", () => {
    const shape = rawRequestShape(`
      export async function cin7RawRequest(creds: C, path: string, query?: Q) {
        const r = await fetch(url, { method: "POST" });
      }
    `);
    expect(shape.fetchMethods).toEqual(['"POST"']);
    expect(shape.mutationLiterals).toContain("POST");
  });

  it("passes for the current GET-only shape", () => {
    const shape = rawRequestShape(`
      export async function cin7RawRequest(creds: C, path: string, query?: Q) {
        const r = await fetch(url, { method: "GET", redirect: "manual" });
      }
    `);
    expect(shape.params).toEqual(["creds", "path", "query"]);
    expect(shape.fetchMethods).toEqual(['"GET"']);
    expect(shape.mutationLiterals).toEqual([]);
  });
});
