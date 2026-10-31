import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODE_EXTENSIONS, scanFile, scanTree, type Profile, type ScanContext } from "@/rwtsa-demo/__tests__/boundary-scanner";

/**
 * AT-12: import boundary for the RWTSA demonstration code.
 *
 * What this proves, and what it does not, is stated in boundary-scanner.ts. In short: it is a review-time TRIPWIRE
 * against accidental or unreviewed imports of Supabase, Cin7, network APIs and other application modules, applied to
 * the AST of every first-party file under the audited roots and their transitive first-party imports. It is NOT a
 * sandbox and gives no protection against deliberately malicious code or against third-party packages.
 */

const ROOT = realpathSync(path.join(__dirname, "..", "..", ".."));
const REAL_CTX: ScanContext = {
  rootDir: ROOT,
  boundaryRoots: [path.join(ROOT, "src", "rwtsa-demo"), path.join(ROOT, "scripts", "rwtsa-demo"), path.join(ROOT, "rwtsa-demo")],
  externalFiles: [path.join(ROOT, "src", "lib", "csv-upload-limits.ts"), path.join(ROOT, "src", "lib", "format-count.ts")],
};
const VIRTUAL_FILE = path.join(ROOT, "src", "rwtsa-demo", "workbook", "virtual-snippet.ts");

const snippet = (text: string, profile: Profile = "runtime", file = VIRTUAL_FILE) => scanFile(REAL_CTX, file, text, profile).violations;

describe("AT-12: the real audited tree", () => {
  const scan = scanTree(REAL_CTX);

  it("has no violations", () => {
    expect(scan.violations).toEqual([]);
  });

  it("scans a non-trivial number of files, including tests and the CLI script", () => {
    expect(scan.visited.length).toBeGreaterThan(20);
    expect(scan.visited.some((f) => f.endsWith(path.join("scripts", "rwtsa-demo", "validate.ts")))).toBe(true);
    expect(scan.visited.some((f) => f.includes(`${path.sep}__tests__${path.sep}`))).toBe(true);
  });

  it("follows the transitive closure into the two allowlisted first-party files outside the boundary", () => {
    for (const f of REAL_CTX.externalFiles) expect(scan.visited).toContain(realpathSync(f));
  });
});

describe("negative tests: every bypass identified in the review of PR #129 is now flagged", () => {
  const cases: [string, string][] = [
    // comment / string tricks that defeated the old regex stripping
    ["fetch after a // inside a string", `const s = "a//b"; await fetch(u);`],
    ["fetch between fake comment markers in strings", `const s = "/*"; await fetch(u); const t = "*/";`],
    // aliasing and indirect access
    ["alias then call", `const f = fetch; f(u);`],
    ["tagged template", "fetch`x`;"],
    ["computed global access", `globalThis["fe" + "tch"](u);`],
    ["globalThis.fetch", `globalThis.fetch(u);`],
    ["Bun.fetch", `Bun.fetch(u);`],
    ["string-literal element access", `const f = x["fetch"];`],
    ["constructor escape", `(() => {}).constructor("return fetch")();`],
    ["eval", `eval("1");`],
    ["new Function", `new Function("return 1")();`],
    // dynamic and indirect module loading
    ["dynamic import template", "await import(`node:${x}`);"],
    ["dynamic import concatenation", `await import("node:" + "http");`],
    ["dynamic import literal", `await import("node:http");`],
    ["require", `const x = require("fs");`],
    ["createRequire", `import { createRequire } from "node:module"; createRequire(import.meta.url)("node:http");`],
    ["import = require", `import h = require("http");`],
    ["import type of a forbidden module", `type T = import("undici").Dispatcher;`],
    // import allowlist (bare packages and Node modules)
    ["undici", `import { fetch as f } from "undici";`],
    ["axios", `import axios from "axios";`],
    ["node-fetch", `import f from "node-fetch";`],
    ["ws", `import WebSocket from "ws";`],
    ["node:http", `import http from "node:http";`],
    ["bare http", `import http from "http";`],
    ["node:dns/promises (subpath)", `import dns from "node:dns/promises";`],
    ["node:net/foo (subpath)", `import n from "node:net/foo";`],
    ["node:module", `import m from "node:module";`],
    ["child_process in runtime code", `import { exec } from "node:child_process";`],
    ["server-only", `import "server-only";`],
    ["supabase package", `import { createClient } from "@supabase/supabase-js";`],
    ["export * from a forbidden module", `export * from "node:http";`],
    ["export { } from a forbidden module", `export { request } from "node:https";`],
    // process access
    ["process.binding", `process.binding("tcp_wrap");`],
    ["process alias", `const p = process; p.env;`],
    ["process.env credential", `const k = process.env.NEXT_PUBLIC_SUPABASE_URL;`],
    ["process.env element access", `const k = process.env["SUPABASE_SERVICE_ROLE_KEY"];`],
    ["process.env destructuring", `const { SUPABASE_URL } = process.env;`],
    ["process.env spread", `const e = { ...process.env };`],
    ["process.env bare", `use(process.env);`],
    ["process.mainModule", `process.mainModule;`],
    // application-module aliases and traversal
    ["@/supabase", `import { createServiceRoleClient } from "@/supabase/server";`],
    ["@/cin7", `import { cin7Request } from "@/cin7/http";`],
    ["other @/lib module", `import { x } from "@/lib/billing";`],
    ["alias traversal", `import { x } from "@/rwtsa-demo/../supabase/server";`],
    ["relative escape to application code", `import { x } from "../../../src/cin7/http";`],
    ["prefix-trap sibling directory", `import { x } from "../../rwtsa-demo-x/y";`],
    ["unresolvable import fails closed", `import { x } from "./does-not-exist";`],
    // network literals
    ["http URL literal", `const u = "https://example.com";`],
    ["ws URL literal in a template", "const u = `wss://example.com/x`;"],
  ];
  for (const [label, src] of cases) it(`flags: ${label}`, () => expect(snippet(src).length).toBeGreaterThan(0));

  it("flags the same bypasses in test files too (tests are scanned, not exempt)", () => {
    for (const src of [`await fetch(u);`, `import axios from "axios";`, `await import("x");`, `const x = require("fs");`]) {
      expect(snippet(src, "test", path.join(ROOT, "src", "rwtsa-demo", "__tests__", "virtual.test.ts")).length).toBeGreaterThan(0);
    }
  });

  it("allows only the sanctioned things: comments and strings mentioning forbidden words, allowlisted imports, named RWTSA_ env vars", () => {
    const ok = [
      `// we never call fetch( or https://x here\n/* require( eval( */\nconst note = "do not fetch(url) // or import()";`,
      `import { a } from "@/rwtsa-demo/findings";`,
      `import { b } from "@/lib/csv-upload-limits";`,
      `import ExcelJS from "exceljs";\nimport { z } from "zod";\nimport fs from "node:fs";\nimport path from "node:path";\nimport { createHash } from "node:crypto";\nimport { homedir } from "node:os";`,
      `const p = process.env.RWTSA_WORKBOOK_PATH ?? process.env["RWTSA_LOCAL_DIR"]; process.exit(process.argv.length > 2 ? 0 : 1);`,
      `const o = { fetch: 1, self: 2 }; const { constructorName } = o as never; void constructorName;`,
    ];
    for (const src of ok) expect(snippet(src)).toEqual([]);
  });

  it("test profile additionally allows vitest/typescript/child_process and bare process.env, but nothing network-related", () => {
    const f = path.join(ROOT, "src", "rwtsa-demo", "__tests__", "virtual.test.ts");
    expect(snippet(`import { it } from "vitest";\nimport ts from "typescript";\nimport { execFileSync } from "node:child_process";\nconst e = { ...process.env };`, "test", f)).toEqual([]);
    expect(snippet(`import { it } from "vitest";`, "runtime").length).toBeGreaterThan(0);
  });
});

describe("walker and transitive closure on a temporary tree", () => {
  let tmp: string;
  let ctx: ScanContext;
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "rwtsa-boundary-")));
    for (const d of ["src/rwtsa-demo", "src/rwtsa-demo-x", "src/lib", "elsewhere"]) mkdirSync(path.join(tmp, d), { recursive: true });
    ctx = { rootDir: tmp, boundaryRoots: [path.join(tmp, "src", "rwtsa-demo")], externalFiles: [path.join(tmp, "src", "lib", "allowed.ts")] };
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    writeFileSync(path.join(tmp, rel), text);
  };

  it("scans every code extension (.ts .tsx .js .jsx .cts .cjs .mts .mjs) and reports each offender", () => {
    for (const ext of CODE_EXTENSIONS) put(`src/rwtsa-demo/bad${ext}`, `export const x = fetch("u");`);
    const { violations } = scanTree(ctx);
    for (const ext of CODE_EXTENSIONS) expect(violations.some((v) => v.includes(`bad${ext}:`))).toBe(true);
  });

  it("scans __tests__ directories", () => {
    put("src/rwtsa-demo/__tests__/x.test.ts", `await fetch("u");`);
    expect(scanTree(ctx).violations.some((v) => v.includes("x.test.ts"))).toBe(true);
  });

  it("follows allowed first-party imports transitively and flags what the allowed file itself imports", () => {
    put("src/lib/allowed.ts", `import axios from "axios";\nexport const a = 1;`);
    put("src/rwtsa-demo/uses-allowed.ts", `import { a } from "@/lib/allowed";\nexport const b = a;`);
    const { violations, visited } = scanTree(ctx);
    expect(visited).toContain(path.join(tmp, "src", "lib", "allowed.ts"));
    expect(violations.some((v) => v.includes(path.join("src", "lib", "allowed.ts")) && v.includes("axios"))).toBe(true);
  });

  it("flags a relative import into a sibling directory whose name merely starts with the boundary's name", () => {
    put("src/rwtsa-demo-x/helper.ts", `export const h = 1;`);
    put("src/rwtsa-demo/prefix-trap.ts", `import { h } from "../rwtsa-demo-x/helper";\nexport const y = h;`);
    expect(scanTree(ctx).violations.some((v) => v.includes("prefix-trap.ts") && v.includes("outside the audited boundary"))).toBe(true);
  });

  it("flags a symlink inside the boundary that points outside it", () => {
    put("elsewhere/leak.ts", `export const leak = 1;`);
    symlinkSync(path.join(tmp, "elsewhere", "leak.ts"), path.join(tmp, "src", "rwtsa-demo", "link.ts"));
    expect(scanTree(ctx).violations.some((v) => v.includes("link.ts") && v.includes("symlink"))).toBe(true);
  });
});
