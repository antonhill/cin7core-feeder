import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

vi.mock("next/font/google", () => ({}));
import RootLayout, { metadata } from "@portal/app/layout";

const ROOT = resolve(__dirname, "..", "..", "..", "..");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === ".next" ? [] : e.isDirectory() ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [e.name]));

describe("the public portal is its own minimal application", () => {
  it("route inventory: exactly the response page and the token-checked PDF route (plus the root layout)", () => {
    const routes = walk(join(ROOT, "portal/app")).filter((f) => /(^|\/)(page|route|layout|loading|error|not-found|template|default|middleware|proxy)\.(t|j)sx?$/.test(f) && !f.includes("__tests__")).sort();
    expect(routes).toEqual(["api/quote-response/document/route.ts", "layout.tsx", "quote-response/page.tsx"]);
    expect(existsSync(join(ROOT, "portal/middleware.ts"))).toBe(false);
  });
  it("the root layout is a bare document: no shell, session, nav, staff identity, Demo bar or Toolbox branding - and the page is not indexable", () => {
    const html = renderToStaticMarkup(RootLayout({ children: <p>PAGE</p> }));
    expect(html).toContain("PAGE");
    for (const leak of ["sidebar", "<nav", "<aside", "Toolbox", "Cin7", "DEMO", "@"]) expect(html, leak).not.toContain(leak);
    expect(metadata.robots).toMatchObject({ index: false }); expect(metadata.referrer).toBe("no-referrer");
    expect(JSON.stringify(metadata.title) + JSON.stringify(metadata.description)).not.toMatch(/Toolbox|Cin7/);
  });
  it("security headers: strict same-origin CSP, no framing, no referrer, no caching, noindex, HSTS", async () => {
    const cfg = (await import("@portal/next.config")).default;
    const h = (await cfg.headers!())[0].headers; const get = (k: string) => h.find((x) => x.key === k)?.value ?? "";
    expect(get("Content-Security-Policy")).toMatch(/default-src 'self'/); expect(get("Content-Security-Policy")).toMatch(/connect-src 'self'/); expect(get("Content-Security-Policy")).toMatch(/frame-ancestors 'none'/); expect(get("Content-Security-Policy")).not.toMatch(/https?:\/\//);
    expect(get("Cache-Control")).toMatch(/no-store/); expect(get("Referrer-Policy")).toBe("no-referrer"); expect(get("X-Frame-Options")).toBe("DENY"); expect(get("X-Robots-Tag")).toMatch(/noindex/); expect(get("Strict-Transport-Security")).toMatch(/max-age/);
    expect((cfg as { poweredByHeader?: boolean }).poweredByHeader).toBe(false);
  });
  it("the Vercel project config has no crons and installs from the repo root", () => {
    const v = JSON.parse(readFileSync(join(ROOT, "portal/vercel.json"), "utf8"));
    expect(v.crons).toEqual([]); expect(v.installCommand).toBe("cd .. && npm ci"); expect(v.framework).toBe("nextjs");
  });
});

// Static import graph from the portal's entry files: nothing reachable may touch Cin7, projects, costing or other internal modules, and no client component may import server secrets.
describe("import graph reachable from the portal", () => {
  const exts = [".ts", ".tsx", "/index.ts", "/index.tsx"];
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : spec.startsWith("@portal/") ? join(ROOT, "portal", spec.slice(8)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const e of ["", ...exts]) { const p = base + e; if (existsSync(p) && statSync(p).isFile()) return p; }
    return null;
  };
  const parent = new Map<string, string>();
  const graph = (entries: string[]) => {
    const seen = new Set<string>(); parent.clear(); const stack = [...entries];
    while (stack.length) {
      const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
      const src = readFileSync(f, "utf8");
      const runtime = src.replace(/^\s*(import|export)\s+type\b[^;]*;?\s*$/gm, "").replace(/\{[^{}]*\}/g, (b) => b); // type-only imports are erased from the bundle
      for (const m of runtime.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;"']*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g)) { const r = resolveImport(f, m[1] ?? m[2]); if (r) { parent.set(r, parent.get(r) ?? f); stack.push(r); } }
    }
    return [...seen].map((f) => f.slice(ROOT.length + 1));
  };
  const files = graph([join(ROOT, "portal/app/layout.tsx"), join(ROOT, "portal/app/quote-response/page.tsx"), join(ROOT, "portal/app/quote-response/actions.ts"), join(ROOT, "portal/app/api/quote-response/document/route.ts")]);
  it("reaches no Cin7 gateway, project, costing, estimator, template or shell code", () => {
    const forbidden = [/src\/lib\/cin7/, /src\/cin7/, /src\/lib\/projects\//, /costing/i, /margin/i, /src\/newquip\/grower/, /src\/newquip\/rules/, /AppShell|AppNav|module-nav|tour-guide|DemoMode/, /src\/actions\//, /src\/app\//, /\/pdf\//i];
    const hits = files.filter((f) => !f.startsWith("portal/") && forbidden.some((r) => r.test(f)));
    expect(hits.map((h) => `${h}  <- ${(parent.get(join(ROOT, h)) ?? "").slice(ROOT.length + 1)}`)).toEqual([]);
  });
  it("the page (a client component) imports no server-side module except its own server actions", () => {
    const page = readFileSync(join(ROOT, "portal/app/quote-response/page.tsx"), "utf8");
    const imports = [...page.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./actions", "@/lib/newquip-portal/store", "react"]);
    expect(page).toMatch(/import type \{ PublicQuotation \}/); // type-only: erased from the client bundle
  });
  it("inventory of shared source (review this list when it changes)", () => {
    expect(files.filter((f) => !f.startsWith("portal/")).every((f) => f.startsWith("src/lib/") || f.startsWith("src/supabase/") || f.startsWith("src/newquip/quote/"))).toBe(true);
  });
});
