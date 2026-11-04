import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const prod = (d: string) => walk(d).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
const LIVE = path.join(ROOT, "src", "rwtsa-live");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("RWTSA live module isolation", () => {
  it("only client.ts can touch the network, and only with GET", () => {
    for (const f of [...prod(LIVE), ...prod(path.join(ROOT, "scripts", "rwtsa-live"))]) {
      const t = strip(readFileSync(f, "utf8"));
      if (path.basename(f) !== "client.ts") expect(/\bfetch\b|XMLHttpRequest|WebSocket|node:https?|node:net|undici|axios/.test(t), f).toBe(false);
    }
    const client = strip(readFileSync(path.join(LIVE, "client.ts"), "utf8"));
    expect(/["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(client)).toBe(false);
    expect(client).toMatch(/method:\s*"GET"/);
  });
  it("imports no database, Toolbox integration, server-only or Cin7 HTTP/rate-limit modules", () => {
    for (const f of [...prod(LIVE), ...prod(path.join(ROOT, "scripts", "rwtsa-live"))]) {
      const imports = [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const i of imports) { expect(/supabase|server-only|@\/cin7\/(http|rate-limit|load-credentials|crypto)|@\/lib\//.test(i), `${f} -> ${i}`).toBe(false); }
    }
  });
  it("reads no process.env (credentials come only from the dedicated file)", () => {
    for (const f of [...prod(LIVE), ...prod(path.join(ROOT, "scripts", "rwtsa-live"))]) expect(/process\.env/.test(strip(readFileSync(f, "utf8"))), f).toBe(false);
  });
  it("is not imported by the RWTSA standalone shell, the engines or the planner (no automatic substitution of live values)", () => {
    for (const d of [path.join(ROOT, "src", "rwtsa-demo"), path.join(ROOT, "rwtsa-demo"), path.join(ROOT, "scripts", "rwtsa-demo")]) {
      for (const f of walk(d).filter((x) => /\.(ts|tsx|mjs|js)$/.test(x) && !x.includes("node_modules") && !x.includes(`${path.sep}.next${path.sep}`))) expect(/rwtsa-live/.test(readFileSync(f, "utf8").replace(/^.*boundary.*$/gm, "")) && !f.includes("__tests__"), f).toBe(false);
    }
  });
  it("starts no timer or poller", () => {
    for (const f of prod(LIVE)) expect(/setInterval|cron|schedule/i.test(strip(readFileSync(f, "utf8"))), f).toBe(false);
  });
});
