import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * AT-12: strict no-network / no-Supabase / no-Cin7 boundary.
 *
 * Everything under src/rwtsa-demo (non-test), scripts/rwtsa-demo and (from PR-2) rwtsa-demo/ is the local,
 * offline demonstration. It must not be able to reach Supabase, Cin7, or any network, and it may import from
 * the rest of the codebase only through an explicit allowlist.
 *
 * The scanner is itself tested against offending snippets below, so this guard cannot silently pass.
 */

const ROOT = join(__dirname, "..", "..", "..");

/** `@/` modules the RWTSA demo may import besides its own. Extend deliberately, in review. */
const ALLOWED_ALIAS_PREFIXES = ["@/rwtsa-demo/"];
const ALLOWED_ALIAS_EXACT = new Set(["@/lib/csv-upload-limits"]);

const FORBIDDEN_BARE = new Set([
  "http", "https", "http2", "net", "tls", "dns", "dgram", "child_process", "cluster", "worker_threads", "vm", "inspector",
  "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dns", "node:dgram", "node:child_process", "node:cluster", "node:worker_threads", "node:vm", "node:inspector",
  "server-only",
]);

const FORBIDDEN_TOKENS: [RegExp, string][] = [
  [/\bfetch\s*\(/, "fetch("],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/https?:\/\//, "http(s):// URL literal"],
  [/\bcreateServiceRoleClient\b/, "createServiceRoleClient"],
  [/\bcreateClient\s*\(/, "createClient("],
  [/\bcreateServerClient\b/, "createServerClient"],
  [/\brequire\s*\(/, "require("],
  [/process\.env\.[A-Z_]*(SUPABASE|CIN7|DEAR_|SERVICE_ROLE|APPLICATION_KEY)/, "credential-bearing env var"],
];

export function scanSource(file: string, text: string): string[] {
  const problems: string[] = [];
  const info = ts.preProcessFile(text, true, true);
  for (const imp of info.importedFiles) {
    const spec = imp.fileName;
    if (spec.startsWith(".")) continue; // relative: stays inside this directory tree (checked by the file walk)
    if (spec.startsWith("@/")) {
      const ok = ALLOWED_ALIAS_PREFIXES.some((p) => spec.startsWith(p)) || ALLOWED_ALIAS_EXACT.has(spec);
      if (!ok) problems.push(`${file}: import of "${spec}" is outside the RWTSA allowlist`);
      continue;
    }
    if (FORBIDDEN_BARE.has(spec)) problems.push(`${file}: forbidden import "${spec}"`);
    if (spec.startsWith("@supabase/") || spec === "@supabase/ssr") problems.push(`${file}: Supabase import "${spec}"`);
  }
  // Strip comments before the token scan so prose may mention these words.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const [re, label] of FORBIDDEN_TOKENS) if (re.test(code)) problems.push(`${file}: forbidden ${label}`);
  // Dynamic import() with a non-literal argument could load anything.
  if (/\bimport\s*\(\s*[^"'`\s)]/.test(code)) problems.push(`${file}: non-literal dynamic import()`);
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("AT-12: no network, no Supabase, no Cin7 in the RWTSA demonstration code", () => {
  const files = [
    ...walk(join(ROOT, "src", "rwtsa-demo")),
    ...walk(join(ROOT, "scripts", "rwtsa-demo")),
    ...walk(join(ROOT, "rwtsa-demo")),
  ];

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("every file respects the import allowlist and token bans", () => {
    const problems = files.flatMap((f) => scanSource(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(problems).toEqual([]);
  });

  it("relative imports never escape into the rest of the application", () => {
    const escapes: string[] = [];
    for (const f of files) {
      const info = ts.preProcessFile(readFileSync(f, "utf8"), true, true);
      for (const imp of info.importedFiles) {
        if (!imp.fileName.startsWith(".")) continue;
        const target = join(f, "..", imp.fileName);
        const rel = relative(ROOT, target);
        if (!(rel.startsWith(join("src", "rwtsa-demo")) || rel.startsWith(join("scripts", "rwtsa-demo")) || rel.startsWith("rwtsa-demo"))) escapes.push(`${relative(ROOT, f)} -> ${imp.fileName}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  describe("the scanner itself catches violations", () => {
    const bad: [string, string][] = [
      ["supabase alias", `import { createServiceRoleClient } from "@/supabase/server";`],
      ["cin7 alias", `import { cin7Request } from "@/cin7/http";`],
      ["other app alias", `import { x } from "@/lib/billing";`],
      ["supabase package", `import { createClient } from "@supabase/supabase-js";`],
      ["node http", `import http from "node:http";`],
      ["child_process", `import { exec } from "child_process";`],
      ["server-only", `import "server-only";`],
      ["fetch call", `const r = await fetch(u);`],
      ["XMLHttpRequest", `new XMLHttpRequest();`],
      ["url literal", `const u = "https://example.com";`],
      ["require", `const x = require("fs");`],
      ["dynamic import", `const m = await import(name);`],
      ["env credential", `const k = process.env.NEXT_PUBLIC_SUPABASE_URL;`],
    ];
    for (const [label, src] of bad) it(`flags: ${label}`, () => expect(scanSource("x.ts", src).length).toBeGreaterThan(0));

    it("allows the sanctioned imports and ignores prose in comments", () => {
      const ok = `// we never call fetch( or https://x here\n/* require( */\nimport { a } from "@/rwtsa-demo/findings";\nimport { b } from "@/lib/csv-upload-limits";\nimport { c } from "./local";\nimport fs from "node:fs";`;
      expect(scanSource("x.ts", ok)).toEqual([]);
    });
  });
});
