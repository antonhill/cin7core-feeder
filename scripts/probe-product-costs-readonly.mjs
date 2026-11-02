// scripts/probe-product-costs-readonly.mjs
//
// READ-ONLY verification of the Cin7 supplier-cost fields the NewQuip "latest cost" estimate relies on (src/cin7/latest-cost.ts, src/lib/projects/latest-cost.ts).
// It answers, from REAL data: does GET /Product?IncludeSuppliers=true return Suppliers[] with Cost / FixedCost / LastSupplied / SupplierName? what types?
// how many products have a usable latest cost, how many are ambiguous, how many have none? Does the Sku filter return the exact product?
//
// SAFETY: every Cin7 call goes through get() below - the ONLY network function; GET only. Credentials come from the environment, are used in memory and are
// never printed or written. Output is STRUCTURE and COUNTS only (key names, JS types, tallies, the rule outcome per SKU); no supplier names or amounts are printed.
// Same credential modes and safety as scripts/probe-sale-invoices-readonly.mjs (see its header). Use --dry-run first.
//
//   node scripts/probe-product-costs-readonly.mjs --org-name "NewQuip" --dry-run
//   node scripts/probe-product-costs-readonly.mjs --org-name "NewQuip" --max 40
//   node scripts/probe-product-costs-readonly.mjs --org-name "NewQuip" --sku "<exact SKU>" --sku "<another>"   (check specific scope SKUs)
//   add --per-sku to ALSO print one block per product (product id, name, UoM, average cost, and each supplier record: id, name, currency, Cost, FixedCost, LastSupplied)
//   for the SKUs you named. Those are the owner's own business data (still no credentials), meant for the cost-loading workbook; do not use --per-sku on a broad sample.

import { createRequire } from "node:module";
import { decryptInstanceKey } from "./lib/probe-support.mjs";

const BASE = "https://inventory.dearsystems.com/ExternalApi/v2"; // canonical origin (src/cin7/api-origin.ts)
const PACE_MS = 1300; // ~46/min, under Cin7's 60/min
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MAX = Number(arg("--max")) || 100;
const ORG_NAME = arg("--org-name");
const INSTANCE_NAME = arg("--instance-name");
const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ACCOUNT_ID;
let APP_KEY;

// ── credentials ────────────────────────────────────────────────────────────────────────────────────────────
async function resolveCredentials() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const toolboxMode = ORG_NAME && supabaseUrl && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ENCRYPTION_KEY;

  if (toolboxMode) {
    const require = createRequire(import.meta.url);
    const { createClient } = require("@supabase/supabase-js");
    const db = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: orgs, error: orgErr } = await db.from("organizations").select("id, name, subscription_status").ilike("name", `%${ORG_NAME}%`);
    if (orgErr) throw new Error(`organizations lookup failed: ${orgErr.message}`);
    if (!orgs || orgs.length !== 1) {
      console.error(`Refusing to continue: "${ORG_NAME}" matched ${orgs?.length ?? 0} organisation(s); exactly one is required.`);
      for (const o of orgs ?? []) console.error(`  candidate: ${o.id}  "${o.name}"  (${o.subscription_status})`);
      process.exit(2);
    }
    const org = orgs[0];

    const { data: instances, error: instErr } = await db.from("cin7_instances").select("id, name, active").eq("org_id", org.id);
    if (instErr) throw new Error(`cin7_instances lookup failed: ${instErr.message}`);
    let candidates = (instances ?? []).filter((i) => i.active);
    if (INSTANCE_NAME) candidates = candidates.filter((i) => i.name.toLowerCase().includes(INSTANCE_NAME.toLowerCase()));
    if (candidates.length !== 1) {
      console.error(`Refusing to continue: ${candidates.length} matching active instance(s) in this organisation; exactly one is required (use --instance-name).`);
      for (const i of candidates) console.error(`  candidate instance: ${i.id}  "${i.name}"`);
      process.exit(2);
    }
    const inst = candidates[0];
    console.log(`Resolved organisation ${org.id} "${org.name}" (subscription: ${org.subscription_status}); instance ${inst.id} "${inst.name}".`);
    if (DRY_RUN) {
      console.log("DRY RUN: nothing was decrypted and no Cin7 call was made. Re-run without --dry-run if this is the NewQuip trial instance.");
      process.exit(0);
    }
    // Scoped to BOTH instance id and org id, exactly like loadCin7Credentials (src/cin7/load-credentials.ts).
    const { data: row, error: keyErr } = await db.from("cin7_instances").select("account_id, application_key_encrypted").eq("id", inst.id).eq("org_id", org.id).single();
    if (keyErr || !row) throw new Error(`credential lookup failed: ${keyErr?.message ?? "no row"}`);
    ACCOUNT_ID = row.account_id;
    APP_KEY = decryptInstanceKey(row.application_key_encrypted, process.env.ENCRYPTION_KEY);
    return `Toolbox credential path (org "${org.name}", instance "${inst.name}")`;
  }

  if (process.env.CIN7_ACCOUNT_ID && process.env.CIN7_APP_KEY) {
    ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID;
    APP_KEY = process.env.CIN7_APP_KEY;
    if (DRY_RUN) {
      console.log("DRY RUN (raw-credential mode): credentials present; no Cin7 call made.");
      process.exit(0);
    }
    return "raw CIN7_ACCOUNT_ID / CIN7_APP_KEY";
  }

  console.error('No usable credentials. Either set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + ENCRYPTION_KEY and pass --org-name "<org>", or set CIN7_ACCOUNT_ID + CIN7_APP_KEY. See the header of this file.');
  process.exit(1);
}

// ── the ONLY network function ─────────────────────────────────────────────────────────────────────────────
async function get(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  if (url.origin !== new URL(BASE).origin) throw new Error("refusing non-canonical origin");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "api-auth-accountid": ACCOUNT_ID, "api-auth-applicationkey": APP_KEY, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    await sleep(PACE_MS);
    if (res.ok) return res.json();
    // Cin7 signals its 60/min limit with 503 (no Retry-After). Retrying a GET is always safe.
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    throw new Error(`GET ${path} -> HTTP ${res.status}`);
  }
}


const mode = await resolveCredentials();
const SKUS = process.argv.flatMap((a, i, all) => (a === "--sku" && all[i + 1] ? [all[i + 1]] : []));
console.log(`Mode: ${mode}. GET only. Budget: ${MAX} products.\n`);

// The same rule as resolveLatestCost (src/lib/projects/latest-cost.ts): most recently supplied usable cost; ambiguity and absence are MISSING.
const cents = (n) => Math.round(n * 100);
function latest(suppliers) {
  const usable = suppliers.filter((s) => typeof s.Cost === "number" && Number.isFinite(s.Cost) && s.Cost > 0);
  if (usable.length === 0) return suppliers.length === 0 ? "MISSING:no-supplier-record" : "MISSING:no-supplier-cost";
  if (usable.length === 1) return "LATEST:single";
  const dated = usable.filter((s) => typeof s.LastSupplied === "string" && s.LastSupplied);
  if (dated.length) {
    const t = Math.max(...dated.map((s) => new Date(s.LastSupplied).getTime()));
    const top = dated.filter((s) => new Date(s.LastSupplied).getTime() === t);
    return new Set(top.map((s) => cents(s.Cost))).size === 1 ? "LATEST:newest-dated" : "MISSING:ambiguous-same-date";
  }
  return new Set(usable.map((s) => cents(s.Cost))).size === 1 ? "LATEST:identical" : "MISSING:ambiguous-undated";
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const supplierKeys = new Map(); // key -> Map(type -> count)
const productKeys = new Map();
const outcomes = new Map();
let products = 0, withSuppliers = 0, filterExact = 0, filterWrong = 0, avgPresent = 0;
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const PER_SKU = process.argv.includes("--per-sku") && SKUS.length > 0;
const show = (v) => (v === undefined ? "(absent)" : v === null ? "null" : String(v));
const seeProduct = (p) => {
  products++;
  if (PER_SKU) {
    const sup = Array.isArray(p.Suppliers) ? p.Suppliers : [];
    console.log(`SKU ${show(p.SKU)} | id ${show(p.ID)} | name ${show(p.Name)} | uom ${show(p.UOM)} | type ${show(p.Type)} | bom ${show(p.BillOfMaterial)} | averageCost ${show(p.AverageCost)} | suppliers ${sup.length}`);
    for (const s of sup) console.log(`    supplier id ${show(s.SupplierID ?? s.ID)} | name ${show(s.SupplierName ?? s.Supplier)} | currency ${show(s.Currency)} | Cost ${show(s.Cost)} | FixedCost ${show(s.FixedCost)} | LastSupplied ${show(s.LastSupplied)} | outcome-if-alone ${latest([s])}`);
    console.log(`    -> Toolbox latest-cost rule: ${latest(sup)}`);
  }
  if (typeof p.AverageCost === "number") avgPresent++;
  for (const k of ["AverageCost", "Suppliers", "SKU", "CostingMethod"]) bump(productKeys.get(k) ?? productKeys.set(k, new Map()).get(k), typeOf(p[k]));
  const sup = Array.isArray(p.Suppliers) ? p.Suppliers : [];
  if (sup.length) withSuppliers++;
  for (const s of sup) for (const [k, v] of Object.entries(s)) bump(supplierKeys.get(k) ?? supplierKeys.set(k, new Map()).get(k), typeOf(v));
  bump(outcomes, latest(sup));
};

if (SKUS.length) {
  for (const sku of SKUS.slice(0, MAX)) {
    const res = await get("/Product", { SKU: sku, page: 1, limit: 1, IncludeSuppliers: "true" });
    const p = res.Products?.[0];
    if (p && p.SKU === sku) { filterExact++; seeProduct(p); } else filterWrong++;
  }
  console.log(`Requested SKUs: ${Math.min(SKUS.length, MAX)}; exact SKU filter matched: ${filterExact}; not found / filter ignored: ${filterWrong}`);
} else {
  const res = await get("/Product", { page: 1, limit: Math.min(MAX, 100), IncludeSuppliers: "true" });
  for (const p of res.Products ?? []) seeProduct(p);
  console.log(`Sampled first page: ${products} products`);
}
console.log(`Products with at least one Suppliers[] record: ${withSuppliers}/${products}; AverageCost present (number): ${avgPresent}/${products}\n`);
console.log("Product keys used (type -> count):");
for (const [k, m] of productKeys) console.log(`  ${k}: ${[...m].map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log("\nSuppliers[] record keys (type -> count):");
for (const [k, m] of [...supplierKeys].sort()) console.log(`  ${k}: ${[...m].map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log("\nLatest-cost rule outcome (count of products):");
for (const [k, n] of [...outcomes].sort()) console.log(`  ${k}: ${n}`);
console.log("\nExpected fields: Cost (number), FixedCost (number), LastSupplied (string date), SupplierName (string). Any 'expected' key missing above means the assumption is wrong.");
