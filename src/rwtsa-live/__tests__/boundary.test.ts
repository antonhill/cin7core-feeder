import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { importersOf, scanSource, type Role } from "./boundary-scan";

const ROOT = path.join(__dirname, "..", "..", "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { if (n === "node_modules" || n === ".next" || n === ".git") return []; const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const isCode = (f: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f);
const LIVE = path.join(ROOT, "src", "rwtsa-live");
const SCRIPTS = path.join(ROOT, "scripts", "rwtsa-live");
const prodFiles = () => [...walk(LIVE), ...walk(SCRIPTS)].filter((f) => isCode(f) && !f.includes(`${path.sep}__tests__${path.sep}`));
const roleOf = (f: string): Role => (f.startsWith(SCRIPTS) ? "script" : f === path.join(LIVE, "client.ts") ? "client" : "module");
const VF = path.join(ROOT, "src", "rwtsa-live", "snippet.ts");
const bad = (src: string, role: Role = "module", file = VF) => scanSource(src, file, role);

describe("RWTSA live module: AST boundary over the real tree", () => {
  it("scans a non-trivial set of files", () => { expect(prodFiles().length).toBeGreaterThan(10); });
  it("has no violations (network only in client.ts, GET only, no env, no dynamic loading, allowlisted imports)", () => {
    const all = prodFiles().flatMap((f) => scanSource(readFileSync(f, "utf8"), path.relative(ROOT, f), roleOf(f)));
    expect(all).toEqual([]);
  });
  it("only client.ts holds the Cin7 auth header names", () => {
    const withHeaders = prodFiles().filter((f) => /api-auth-/i.test(readFileSync(f, "utf8")));
    expect(withHeaders).toEqual([path.join(LIVE, "client.ts")]);
  });
});

describe("negative tests: every bypass shape is flagged", () => {
  it.each([
    ["fetch after a // inside a string (comment-stripping trick)", `const s = "a//b"; await fetch(u);`],
    ["fetch between fake comment markers in strings", `const s = "/*"; await fetch(u); const t = "*/";`],
    ["line comment inside a string hiding the rest of the line", `const u = "//"; fetch(u);`],
    ["alias then call", `const f = fetch; f(u);`],
    ["globalThis computed access", `globalThis["fe" + "tch"](u);`],
    ["globalThis.fetch", `globalThis.fetch(u);`],
    ["element access to fetch", `const f = x["fetch"];`],
    ["constructor escape", `(() => {}).constructor("return fetch")();`],
    ["eval", `eval("1");`],
    ["new Function", `new Function("return 1")();`],
    ["dynamic import literal", `await import("node:http");`],
    ["dynamic import template", "await import(`node:${x}`);"],
    ["dynamic import concatenation", `await import("node:" + "http");`],
    ["require", `const x = require("fs");`],
    ["createRequire", `import { createRequire } from "node:module"; createRequire(import.meta.url)("node:http");`],
    ["import = require", `import h = require("http");`],
    ["import type of a forbidden module", `type T = import("undici").Dispatcher;`],
    ["undici", `import { fetch as f } from "undici";`],
    ["axios", `import axios from "axios";`],
    ["node:http", `import http from "node:http";`],
    ["node:net subpath", `import n from "node:net/foo";`],
    ["export-from a network module", `export * from "node:https";`],
    ["side-effect import of a network module", `import "node:http2";`],
    ["supabase", `import { createServiceRoleClient } from "@/supabase/server";`],
    ["Toolbox Cin7 gateway", `import { cin7Request } from "@/cin7/http";`],
    ["Toolbox Cin7 rate limiter", `import { acquireCin7Slot } from "@/cin7/rate-limit";`],
    ["server-only", `import "server-only";`],
    ["other app library", `import { x } from "@/lib/fx";`],
    ["process.env", `const k = process.env.HOME;`],
    ["process[env]", `const k = process["env"];`],
    ["setInterval poller", `setInterval(() => {}, 1000);`],
    ["Cin7 auth header name outside client.ts", `const h = "api-auth-accountid";`],
    ["auth header in a template", "const h = `api-auth-${x}`;"],
    ["URL literal", `const u = "https://evil.example/x";`],
    ["POST literal", `const m = "POST";`],
    ["method other than GET", `const o = { method: m };`],
    ["WebSocket", `new WebSocket(u);`],
    ["relative import escaping the module into the Toolbox gateway", `import { cin7Request } from "../cin7/http";`],
    ["relative import escaping to the Supabase admin helper", `import { a } from "../../lib/supabase/admin";`],
    ["alias path that climbs out with ..", `import x from "@/rwtsa-live/../cin7/rate-limit";`],
    ["global (Node's globalThis alias)", `global["fe" + "tch"](u);`],
    ["process.getBuiltinModule", `process.getBuiltinModule("node:https");`],
    ["destructured process.env", `const { env } = process;`],
    ["Object.entries(process)", `Object.entries(process);`],
    ["Reflect", `Reflect.get(x, "y");`],
    ["shorthand method", `const method = m; const o = { method };`],
    ["computed method key", `const o = { ["method"]: m };`],
    ["new Request", `new Request(u, init);`],
    ["concatenated method literal", `const m = "PO" + "ST";`],
    ["concatenated header name", `const h = "api-auth-" + "accountid";`],
    ["recursive setTimeout poller", `const tick = () => setTimeout(tick, 1000);`],
    ["setImmediate", `setImmediate(() => {});`],
  ])("flags: %s", (_n, src) => { expect(bad(src).length, src).toBeGreaterThan(0); });

  it("the client role may call fetch and hold the header names, but still cannot use a non-GET method or a URL literal", () => {
    expect(bad(`const r = await (opts.fetchImpl ?? fetch)(u, { method: "GET", headers: { "api-auth-accountid": a } });`, "client")).toEqual([]);
    expect(bad(`await fetch(u, { method: "POST" });`, "client").length).toBeGreaterThan(0);
    expect(bad(`await fetch("https://evil.example", { method: "GET" });`, "client").length).toBeGreaterThan(0);
    expect(bad(`await import("node:http");`, "client").length).toBeGreaterThan(0);
  });
  it("relative imports that stay inside the module are fine; a sibling client.ts elsewhere gets no client privileges", () => {
    expect(bad(`import { a } from "./policy"; import { b } from "../types";`, "module", path.join(LIVE, "__tests__", "x.ts"))).toEqual([]);
    const sub = path.join(LIVE, "sub", "client.ts");
    expect(scanSource(`await fetch(u, { method: "GET" });`, sub, roleOf(sub)).length).toBeGreaterThan(0);
  });
  it("scripts may use only the two audited workbook adapter modules from the RWTSA tree", () => {
    expect(bad(`import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";`, "script")).toEqual([]);
    expect(bad(`import { x } from "@/rwtsa-demo/engine";`, "script").length).toBeGreaterThan(0);
    expect(bad(`import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";`, "module").length).toBeGreaterThan(0);
  });
});

describe("nothing outside the live module imports it (no automatic substitution of live values)", () => {
  const OWN = [LIVE, SCRIPTS];
  it("no file anywhere in src/, scripts/ or rwtsa-demo/ imports rwtsa-live, found by AST (not by text)", () => {
    const files = [path.join(ROOT, "src"), path.join(ROOT, "scripts"), path.join(ROOT, "rwtsa-demo")].flatMap(walk).filter((f) => isCode(f) && !OWN.some((o) => f.startsWith(o)));
    expect(files.length).toBeGreaterThan(200);
    const hits = files.flatMap((f) => importersOf(readFileSync(f, "utf8"), f, "rwtsa-live").map((h) => `${path.relative(ROOT, f)} -> ${h}`));
    expect(hits).toEqual([]);
  });
  it("the finder itself catches static, dynamic, require, export-from and import-type shapes", () => {
    for (const s of [`import x from "@/rwtsa-live/snapshot";`, `await import("@/rwtsa-live/store");`, `const q = require("../rwtsa-live/x");`, `export * from "@/rwtsa-live/run";`, `type T = import("@/rwtsa-live/types").Role;`]) expect(importersOf(s, "a.ts", "rwtsa-live").length, s).toBe(1);
    expect(importersOf(`// import "@/rwtsa-live/x"\nconst s = "rwtsa-live";`, "a.ts", "rwtsa-live")).toEqual([]);
  });
});
