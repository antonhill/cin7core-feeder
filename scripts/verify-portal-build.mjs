// Verifies the BUILT public customer portal (run after `cd portal && npx next build`): exactly the response page and the PDF route are served, no middleware/proxy logic from the
// internal Toolbox is bundled, and no server credential names or Cin7 / internal-module markers appear in the browser bundle. Exits non-zero on any violation.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "portal", ".next");
const fail = [];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

const routes = Object.keys(JSON.parse(readFileSync(join(dist, "server", "app-paths-manifest.json"), "utf8"))).filter((r) => !r.startsWith("/_")).sort();
const expected = ["/api/quote-response/document/route", "/quote-response/page"];
if (JSON.stringify(routes) !== JSON.stringify(expected)) fail.push(`unexpected routes: ${routes.join(", ")}`);

const mw = JSON.parse(readFileSync(join(dist, "server", "middleware-manifest.json"), "utf8"));
if (Object.keys(mw.middleware ?? {}).length || Object.keys(mw.functions ?? {}).length) fail.push("edge middleware is bundled in the portal");
const mwJs = join(dist, "server", "middleware.js");
if (existsSync(mwJs) && /getClaims|createServerClient|super_admins|org_members/.test(readFileSync(mwJs, "utf8"))) fail.push("internal session middleware is bundled in the portal");

const SERVER_ONLY = /SUPABASE_SERVICE_ROLE_KEY|service_role|RESEND_API_KEY|ENCRYPTION_KEY|CIN7_/;
const INTERNAL = /api\.cin7|inventory\.dearsystems|getClaims|super_admins|newquip_projects|supplier_price/;
for (const f of walk(join(dist, "static")).filter((p) => /\.(js|html|json)$/.test(p))) {
  const t = readFileSync(f, "utf8");
  if (SERVER_ONLY.test(t)) fail.push(`server credential name in browser bundle: ${f}`);
  if (INTERNAL.test(t)) fail.push(`internal marker in browser bundle: ${f}`);
}
for (const f of walk(join(dist, "server")).filter((p) => /\.(js)$/.test(p) && !p.endsWith(".map"))) {
  const t = readFileSync(f, "utf8");
  if (/api\.cin7\.com|inventory\.dearsystems\.com/.test(t)) fail.push(`Cin7 endpoint in the portal server bundle: ${f}`);
}
if (fail.length) { console.error("PORTAL BUILD CHECK FAILED\n- " + fail.join("\n- ")); process.exit(1); }
console.log(`portal build OK: routes = ${routes.join(", ")}; no middleware; no internal markers`);
