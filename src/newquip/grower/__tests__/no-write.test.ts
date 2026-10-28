import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Structural no-write guard: the POC must be read-only with respect to Cin7. Rather than trust the UI
// hiding a button, this scans every non-test source file of the POC and fails on anything that could
// write — the Cin7 write modules, the quote save/submit/delete actions, raw fetch, or a mutating
// Supabase call.

const ROOT = path.resolve(__dirname, "../../../");
const DIRS = [path.join(ROOT, "newquip"), path.join(ROOT, "app/newquip-grower")];
// The quote store legitimately writes to the LOCAL database (that is the POC's persistence); it is scanned separately below
// for every Cin7/Xero/network pattern, just not for local Supabase mutations.
const STORE_DIRS = [path.join(ROOT, "lib/newquip-quotes")];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const read = (dirs: string[]) => dirs.flatMap(files).map((p) => ({ p: path.relative(ROOT, p), s: readFileSync(p, "utf8") }));
const sources = read(DIRS);
const storeSources = read(STORE_DIRS);

const FORBIDDEN: [string, RegExp][] = [
  ["Cin7 sale/quote write module", /@\/cin7\/sale-quote-write/],
  ["any Cin7 write module", /@\/cin7\/(?!reference-lookups|customers\b)[\w-]*(write|push|create|update)[\w-]*/i],
  ["the Cin7 HTTP client", /@\/cin7\/http/],
  ["Cin7 credentials loader", /load-credentials/],
  ["quote submit/save/delete action", /\b(submitQuoteAction|saveQuoteAction|deleteQuoteAction)\b/],
  ["quote submit idempotency", /@\/lib\/quote-submit/],
  ["raw fetch", /\bfetch\s*\(/],
  ["mutating HTTP verb", /method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/],
  // (a hash digest's `.update(` is not a database write)
  ["supabase insert/update/upsert/delete", /(?<!createHash\("sha256"\))\.(insert|update|upsert|delete)\s*\(/],
  ["supabase rpc", /\.rpc\s*\(/],
];

describe("NewQuip POC has no Cin7 write capability", () => {
  it("found source files to scan", () => expect(sources.length).toBeGreaterThan(5));
  for (const [what, re] of FORBIDDEN) {
    it(`no ${what}`, () => {
      const hits = sources.filter(({ s }) => re.test(s)).map(({ p }) => p);
      expect(hits).toEqual([]);
    });
  }
});

const STORE_FORBIDDEN = FORBIDDEN.filter(([what]) => !/supabase insert/.test(what));
describe("the quote store has no Cin7 / Xero / network write capability", () => {
  it("found store files to scan", () => expect(storeSources.length).toBeGreaterThan(1));
  for (const [what, re] of [...STORE_FORBIDDEN, ["Xero", /xero/i] as [string, RegExp], ["Cin7 import of any kind", /@\/cin7\//] as [string, RegExp]]) {
    it(`no ${what}`, () => expect(storeSources.filter(({ s }) => re.test(s)).map(({ p }) => p)).toEqual([]));
  }
});

describe("actions file honours the 'use server' rule", () => {
  const actions = readFileSync(path.join(ROOT, "app/newquip-grower/actions.ts"), "utf8");
  it("exports only async functions or erased types", () => {
    const exports = [...actions.matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]);
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) expect(e).toMatch(/^(async function |interface |type )/);
    expect(actions).not.toMatch(/export\s+(const|let|var|\{|default)/);
  });
  it("every action is gated by the NewQuip org check (directly, or through the shared step() that authorises first)", () => {
    const fns = [...actions.matchAll(/^export async function (\w+)[^{]*\{([\s\S]*?)\n\}/gm)];
    expect(fns.length).toBeGreaterThan(8);
    for (const [, name, body] of fns) expect(body, name).toMatch(/await authorise\(\)|return step\(/);
    const stepFn = /async function step\([\s\S]*?\n\}/.exec(actions)![0];
    expect(stepFn).toContain("await authorise()");
  });
});
