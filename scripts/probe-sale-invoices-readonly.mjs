// scripts/probe-sale-invoices-readonly.mjs
//
// READ-ONLY discovery probe for the Projects POC (Gate P0). Question it answers: in a real Cin7
// account, do Sales carry MULTIPLE Invoices[], what do invoice records look like (status, totals,
// lines vs additional charges), and is invoice state coupled to fulfilment state?
//
// SAFETY — this script can only READ:
//   * every call goes through get() below, the only function that talks to the network, and it
//     issues GET requests exclusively; there is no other request path in this file;
//   * it prints STRUCTURE and COUNTS only — never credentials, customer names, addresses or emails;
//   * redirect:"manual" so credentials can never be forwarded off the canonical Cin7 origin.
// Point it ONLY at the NewQuip TRIAL account.
//
// Run (credentials come from the environment; they are never printed or written anywhere):
//   export CIN7_ACCOUNT_ID='<NewQuip trial account id>'
//   export CIN7_APP_KEY='<application key>'
//   node scripts/probe-sale-invoices-readonly.mjs            # inspects up to 40 recent sales
//   node scripts/probe-sale-invoices-readonly.mjs --max 100
//
// Paste the output back; it is designed to be safe to share.

const BASE = "https://inventory.dearsystems.com/ExternalApi/v2"; // canonical origin (src/cin7/api-origin.ts)
const ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID;
const APP_KEY = process.env.CIN7_APP_KEY;
const MAX = Number(process.argv[process.argv.indexOf("--max") + 1]) || 40;
const PACE_MS = 1300; // ~46/min, under Cin7's 60/min

if (!ACCOUNT_ID || !APP_KEY) {
  console.error("Set CIN7_ACCOUNT_ID and CIN7_APP_KEY (see the header of this file).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  if (url.origin !== new URL(BASE).origin) throw new Error("refusing non-canonical origin");
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "api-auth-accountid": ACCOUNT_ID, "api-auth-applicationkey": APP_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  await sleep(PACE_MS);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);
const tally = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

const list = await get("/saleList", { Page: 1, Limit: Math.min(MAX, 100) });
const sales = (list.SaleList ?? []).slice(0, MAX);
console.log(`saleList returned ${sales.length} sale(s) (cap ${MAX}); list-row keys:`, keysOf(sales[0]));

const summary = { inspected: 0, withInvoices: 0, withMultipleInvoices: 0, invoiceCountDistribution: {}, invoiceStatuses: {}, saleStatuses: {}, linkedFulfilmentStates: {} };
const examples = [];
let invoiceKeys = [], invoiceLineKeys = [], additionalChargeKeys = [], fulfilmentKeys = [];

for (const row of sales) {
  const sale = await get("/sale", { ID: row.SaleID });
  summary.inspected++;
  const invoices = sale.Invoices ?? [];
  const fulfilments = sale.Fulfilments ?? [];
  summary.invoiceCountDistribution[invoices.length] = (summary.invoiceCountDistribution[invoices.length] ?? 0) + 1;
  if (invoices.length > 0) summary.withInvoices++;
  if (invoices.length > 1) summary.withMultipleInvoices++;
  summary.saleStatuses[sale.Status ?? "?"] = (summary.saleStatuses[sale.Status ?? "?"] ?? 0) + 1;
  for (const inv of invoices) summary.invoiceStatuses[inv.Status ?? "?"] = (summary.invoiceStatuses[inv.Status ?? "?"] ?? 0) + 1;
  if (invoices[0]) {
    invoiceKeys = keysOf(invoices[0]);
    invoiceLineKeys = keysOf(invoices[0].Lines?.[0]);
    additionalChargeKeys = keysOf(invoices[0].AdditionalCharges?.[0]);
  }
  if (fulfilments[0]) fulfilmentKeys = keysOf(fulfilments[0]);
  if (invoices.length > 1 && examples.length < 5) {
    examples.push({
      saleIdSuffix: String(row.SaleID).slice(-6),
      saleStatus: sale.Status,
      hasExternalId: Boolean(sale.ExternalID),
      invoices: invoices.map((i) => ({
        status: i.Status, numberFormat: String(i.InvoiceNumber ?? "").replace(/\d/g, "#"),
        total: i.Total, lines: i.Lines?.length ?? 0, additionalCharges: i.AdditionalCharges?.length ?? 0,
        hasTaskId: Boolean(i.TaskID), invoiceDate: i.InvoiceDate,
      })),
      fulfilments: fulfilments.map((f) => ({ status: f.FulfilmentStatus, pickStatus: f.Pick?.Status, packStatus: f.Pack?.Status, shipStatus: f.Ship?.Status })),
      orderTotal: sale.Order?.Total ?? sale.Total,
    });
  }
}

console.log("\n=== SUMMARY (structure/counts only) ===");
console.log(JSON.stringify(summary, null, 2));
console.log("\nInvoice record keys:", invoiceKeys);
console.log("Invoice Lines[] item keys:", invoiceLineKeys);
console.log("Invoice AdditionalCharges[] item keys:", additionalChargeKeys);
console.log("Fulfilment record keys:", fulfilmentKeys);
console.log("\n=== EXAMPLES: sales with more than one invoice (identifiers truncated, no names) ===");
console.log(JSON.stringify(examples, null, 2));
if (summary.withMultipleInvoices === 0) console.log("\nNo sale in this sample carries more than one invoice — widen with --max, or this account has none.");
