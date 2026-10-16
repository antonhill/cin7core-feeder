// scripts/probe-sale-invoices-readonly.mjs
//
// READ-ONLY discovery probe for the Projects POC (Gate V1). Questions it answers from REAL data:
//   * does any existing Sale carry MORE THAN ONE invoice (Invoices[])?
//   * what does an invoice record look like (keys, statuses, totals, dates, lines vs additional charges)?
//   * how do invoice state, order state and fulfilment state relate (can a sale be part-fulfilled AND invoiced)?
//   * which reference fields exist for reconciliation (number, id, memo/reference/external id)?
//
// SAFETY — this script can only READ:
//   * HTTP: every Cin7 call goes through get() below — the ONLY network function; GET requests exclusively.
//   * Database (Toolbox-credential mode): SELECT-only reads of `organizations` and `cin7_instances`; a unit test
//     pins that every table read is a select and that no insert/update/upsert/delete/rpc call exists here.
//   * The decrypted Cin7 application key lives in memory only: never printed, never written to disk.
//   * Output is STRUCTURE and COUNTS only: no customer names, addresses or emails. Reference-style text
//     (memo / reference / external id) is shown as a masked SHAPE (letters->a/A, digits->9), not its content.
//   * redirect:"manual" so credentials can never be forwarded off the canonical Cin7 origin.
//
// SCOPE — NewQuip TRIAL only. In Toolbox mode the org must resolve UNIQUELY by name, and the instance must be
// unique and active; otherwise the script lists candidates (names/ids only) and stops. Use --dry-run first.
//
// ── Run from a trusted environment that ALREADY has the Toolbox credentials ───────────────────────────────
//   export SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  ENCRYPTION_KEY=...      # already in that environment
//   node scripts/probe-sale-invoices-readonly.mjs --org-name "NewQuip" --dry-run     # resolve org+instance only
//   node scripts/probe-sale-invoices-readonly.mjs --org-name "NewQuip" --max 100      # the probe
//   (add --instance-name "<name>" if the org has several active instances)
//
// ── Or, with the raw Cin7 credentials of the NewQuip trial account (no Toolbox database involved) ─────────
//   export CIN7_ACCOUNT_ID=...  CIN7_APP_KEY=...
//   node scripts/probe-sale-invoices-readonly.mjs --max 100
//
// Paste the output back; it is designed to be safe to share.

import { createRequire } from "node:module";
import { decryptInstanceKey, maskText, sumField, keyNames, tally, invoicePriority } from "./lib/probe-support.mjs";

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
console.log(`Mode: ${mode}. Detail-call budget: ${MAX}. GET only.\n`);

// ── 1) the whole sale list (1 call per 1000 rows): cheap cross-tab of invoice vs fulfilment state ─────────────
const allRows = [];
for (let page = 1; page <= 10; page++) {
  const res = await get("/saleList", { Page: page, Limit: 1000 });
  const rows = res.SaleList ?? [];
  allRows.push(...rows);
  if (rows.length < 1000) break;
}
const crossTab = {};
for (const r of allRows) {
  const k = `invoice=${r.CombinedInvoiceStatus ?? "?"} | picking=${r.CombinedPickingStatus ?? "?"} | packing=${r.CombinedPackingStatus ?? "?"} | shipping=${r.CombinedShippingStatus ?? "?"}`;
  crossTab[k] = (crossTab[k] ?? 0) + 1;
}
console.log("=== LIST-LEVEL VIEW (all sales returned by /saleList; no per-sale calls) ===");
console.log(
  JSON.stringify(
    {
      salesInList: allRows.length,
      listRowKeys: keyNames(allRows[0]),
      combinedInvoiceStatus: tally(allRows.map((r) => r.CombinedInvoiceStatus)),
      combinedShippingStatus: tally(allRows.map((r) => r.CombinedShippingStatus)),
      fulfilmentStatus: tally(allRows.map((r) => r.FulFilmentStatus)),
      orderStatus: tally(allRows.map((r) => r.OrderStatus)),
      salesWithInvoicedAmountAbove0: allRows.filter((r) => Number(r.SaleInvoicesTotalAmount) > 0).length,
      invoiceVsFulfilmentCrossTab: crossTab,
    },
    null,
    2,
  ),
);

// ── 2) per-sale detail for the most informative sales first ───────────────────────────────────────────────────
const selected = [...allRows].sort((a, b) => invoicePriority(a) - invoicePriority(b)).slice(0, MAX);
const REF_KEYS = ["Memo", "Reference", "ExternalID", "CustomerReference", "Note", "TaskID", "InvoiceID", "ID"];

const agg = {
  inspected: 0,
  withInvoices: 0,
  withMultipleInvoices: 0,
  invoiceCountDistribution: {},
  saleStatuses: [],
  invoiceStatuses: [],
  invoiceKeys: new Set(),
  invoiceLineKeys: new Set(),
  additionalChargeKeys: new Set(),
  invoicesWithAdditionalCharges: 0,
  invoicesWithLines: 0,
  refFieldPresence: {},
  idFieldUsed: {},
  fulfilmentKeys: new Set(),
  invoicedAndPartiallyPacked: 0,
  invoicedBeforeAnyPack: 0,
  packedNotInvoiced: 0,
  invoicedQtyAbovePacked: 0,
  invoicedQtyAboveOrdered: 0,
  invoicesLinkedToAFulfilment: 0,
  invoicesCarryingLinkedFulfillmentNumber: 0,
  invoicesNotLinkedToAFulfilment: 0,
  multiFulfilmentSales: 0,
  salesWhereInvoiceSumAboveOrderLinesTotal: 0,
  salesWithComparableOrderTotal: 0,
};
const examples = [];

for (const row of selected) {
  const sale = await get("/sale", { ID: row.SaleID });
  agg.inspected++;
  const invoices = sale.Invoices ?? [];
  const fulfils = sale.Fulfilments ?? [];
  agg.invoiceCountDistribution[invoices.length] = (agg.invoiceCountDistribution[invoices.length] ?? 0) + 1;
  agg.saleStatuses.push(sale.Status);
  if (fulfils.length > 1) agg.multiFulfilmentSales++;
  for (const f of fulfils) keyNames(f).forEach((k) => agg.fulfilmentKeys.add(k));
  if (invoices.length === 0) continue;
  agg.withInvoices++;
  if (invoices.length > 1) agg.withMultipleInvoices++;

  const live = invoices.filter((i) => String(i.Status ?? "").toUpperCase() !== "VOIDED");
  const orderedQty = sumField(sale.Order?.Lines, "Quantity");
  const packedQty = fulfils.reduce((n, f) => n + sumField(f.Pack?.Lines, "Quantity"), 0);
  const invoicedQty = live.reduce((n, i) => n + sumField(i.Lines, "Quantity"), 0);
  if (invoicedQty > 0 && packedQty > 0 && packedQty < orderedQty) agg.invoicedAndPartiallyPacked++;
  if (invoicedQty > 0 && packedQty === 0) agg.invoicedBeforeAnyPack++;
  if (packedQty > 0 && invoicedQty === 0) agg.packedNotInvoiced++;
  if (invoicedQty > packedQty) agg.invoicedQtyAbovePacked++;
  if (orderedQty > 0 && invoicedQty > orderedQty) agg.invoicedQtyAboveOrdered++;

  const invoiceRecords = invoices.map((i) => {
    keyNames(i).forEach((k) => agg.invoiceKeys.add(k));
    const lines = Array.isArray(i.Lines) ? i.Lines : [];
    const charges = Array.isArray(i.AdditionalCharges) ? i.AdditionalCharges : [];
    if (lines.length) agg.invoicesWithLines++;
    if (charges.length) agg.invoicesWithAdditionalCharges++;
    lines.forEach((l) => keyNames(l).forEach((k) => agg.invoiceLineKeys.add(k)));
    charges.forEach((c) => keyNames(c).forEach((k) => agg.additionalChargeKeys.add(k)));
    agg.invoiceStatuses.push(i.Status);
    const refs = {};
    for (const k of REF_KEYS) {
      if (i[k] !== undefined && i[k] !== null && i[k] !== "") {
        refs[k] = { shape: maskText(i[k]) };
        agg.refFieldPresence[k] = (agg.refFieldPresence[k] ?? 0) + 1;
      }
    }
    const idKey = ["InvoiceID", "ID", "TaskID"].find((k) => i[k]);
    if (idKey) agg.idFieldUsed[idKey] = (agg.idFieldUsed[idKey] ?? 0) + 1;
    const linked = fulfils.filter((f) => f.LinkedInvoiceNumber && f.LinkedInvoiceNumber === i.InvoiceNumber).length;
    // the invoice-side half of the cross-reference seen on another account (LBL): which fulfilment this invoice covers
    if (i.LinkedFulfillmentNumber !== undefined && i.LinkedFulfillmentNumber !== null && i.LinkedFulfillmentNumber !== "") agg.invoicesCarryingLinkedFulfillmentNumber++;
    if (linked > 0) agg.invoicesLinkedToAFulfilment++;
    else agg.invoicesNotLinkedToAFulfilment++;
    return {
      idField: idKey ?? null,
      id: idKey ? i[idKey] : null,
      number: i.InvoiceNumber ?? null,
      status: i.Status ?? null,
      invoiceDate: i.InvoiceDate ?? null,
      dueDate: i.InvoiceDueDate ?? null,
      total: i.Total ?? null,
      totalBeforeTax: i.TotalBeforeTax ?? null,
      tax: i.Tax ?? null,
      linesTotal: sumField(lines, "Total"),
      additionalChargesTotal: sumField(charges, "Total"),
      lineCount: lines.length,
      additionalChargeCount: charges.length,
      linkedFulfilments: linked,
      linkedFulfillmentNumber: i.LinkedFulfillmentNumber ?? null,
      references: refs,
    };
  });

  const orderLinesTotal = sumField(sale.Order?.Lines, "Total");
  if (orderLinesTotal > 0) {
    agg.salesWithComparableOrderTotal++;
    const invSum = live.reduce((n, i) => n + (Number(i.Total) || sumField(i.Lines, "Total") + sumField(i.AdditionalCharges, "Total")), 0);
    if (invSum > orderLinesTotal + 0.01) agg.salesWhereInvoiceSumAboveOrderLinesTotal++;
  }

  if (examples.length < 25 || invoices.length > 1) {
    examples.push({
      saleId: row.SaleID,
      saleStatus: sale.Status ?? null,
      orderStatus: row.OrderStatus ?? null,
      list: {
        invoice: row.CombinedInvoiceStatus ?? null,
        picking: row.CombinedPickingStatus ?? null,
        packing: row.CombinedPackingStatus ?? null,
        shipping: row.CombinedShippingStatus ?? null,
        fulfilment: row.FulFilmentStatus ?? null,
      },
      hasExternalId: Boolean(sale.ExternalID),
      externalIdShape: maskText(sale.ExternalID),
      invoiceCount: invoices.length,
      invoices: invoiceRecords,
      fulfilments: fulfils.map((f) => ({
        number: f.FulfillmentNumber ?? null,
        status: f.FulFilmentStatus ?? null,
        pick: f.Pick?.Status ?? null,
        pack: f.Pack?.Status ?? null,
        ship: f.Ship?.Status ?? null,
        linkedInvoice: f.LinkedInvoiceNumber || null,
      })),
      quantities: { ordered: orderedQty, packed: packedQty, invoiced: invoicedQty },
      orderLinesTotal,
      invoiceTotalsSum: invoiceRecords.reduce((n, r) => n + (Number(r.total) || r.linesTotal + r.additionalChargesTotal), 0),
    });
  }
}

const out = { ...agg, saleStatuses: tally(agg.saleStatuses), invoiceStatuses: tally(agg.invoiceStatuses) };
for (const s of ["invoiceKeys", "invoiceLineKeys", "additionalChargeKeys", "fulfilmentKeys"]) out[s] = [...agg[s]].sort();

console.log("\n=== PER-SALE DETAIL SUMMARY (structure/counts only) ===");
console.log(JSON.stringify(out, null, 2));
console.log("\n=== EXAMPLES: sales with invoices (all multi-invoice sales, plus the first 25 invoiced sales; no names) ===");
console.log(JSON.stringify(examples, null, 2));
if (agg.withMultipleInvoices === 0) {
  console.log(`\nNo inspected sale carries more than one invoice (inspected ${agg.inspected} of ${allRows.length}). Widen with --max, or this account has none. Nothing was created.`);
}
