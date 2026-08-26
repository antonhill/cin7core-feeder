// scripts/probe-quote-create.mjs
//
// Phase 3 DISCOVERY PROBE for the Quotation + Margin module: learn Cin7 Core's real
// Sale/Quote CREATE contract (endpoint + payload + status values) against the "Spark Demo"
// SANDBOX before any create code is written into the app. PO-create took ~7 rounds to pin
// down; this is the same iterative "attempt a minimal call, read Cin7's own validation
// errors, refine" loop, kept OUT of the app so nothing ships on unverified guesses.
//
// This is a standalone, self-contained Node script (no toolbox imports) on purpose:
//   • no `server-only` throw, no Supabase/decrypt, no path aliases — just `node`.
//   • it mirrors the sanctioned gateway's request shape (src/cin7/http.ts): the same
//     api-auth headers, redirect:"manual" (never leak creds off-origin), JSON, and a
//     bounded per-request timeout. It does NOT go through the distributed rate limiter —
//     acceptable ONLY for a hand-run probe of a few calls; it self-paces with a delay and
//     the whole point is to run it rarely, by hand, against a sandbox.
//
// SAFETY: only ever run this against a throwaway SANDBOX account (Spark Demo, confirmed safe
// 2026-08-26). The --create step creates a REAL draft sale/quote in that account. Never point
// it at a real customer account.
//
// ── How to run ────────────────────────────────────────────────────────────────────────────
//   Get the sandbox's Cin7 API credentials from the Cin7 portal (Spark Demo → Settings →
//   Integrations & API → API, the Account ID + an Application Key), then:
//
//     export CIN7_ACCOUNT_ID='<spark-demo-account-id>'
//     export CIN7_APP_KEY='<spark-demo-application-key>'
//
//   Read-only context first (no writes — confirms creds + finds a customer/location/product):
//     node scripts/probe-quote-create.mjs
//
//   Then attempt the create (writes a draft sale + quote lines to the SANDBOX):
//     node scripts/probe-quote-create.mjs --create
//
//   Paste the full output back and we refine the payloads below round by round.
//   (If your shell needs the toolbox toolchain: prefix with
//    `export PATH="/opt/homebrew/bin:$PATH"; export NODE_EXTRA_CA_CERTS=/opt/homebrew/etc/ca-certificates/cert.pem;`)

const BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2"; // canonical origin (src/cin7/api-origin.ts)
const ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID;
const APP_KEY = process.env.CIN7_APP_KEY;
const DO_CREATE = process.argv.includes("--create");
const TIMEOUT_MS = 20_000;
const PACE_MS = 1300; // ~46/min, under Cin7's 60/min

if (!ACCOUNT_ID || !APP_KEY) {
  console.error("Missing CIN7_ACCOUNT_ID and/or CIN7_APP_KEY env vars — see the header of this file.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Cin7 call, mirroring the gateway's request shape. Returns { status, json?, text }. Never throws. */
async function cin7(path, { method = "GET", query, body } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const started = Date.now();
  let status = 0;
  let text = "";
  try {
    const res = await fetch(url.toString(), {
      method,
      redirect: "manual",
      headers: {
        "api-auth-accountid": ACCOUNT_ID,
        "api-auth-applicationkey": APP_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.type === "opaqueredirect" ? -1 : res.status;
    text = await res.text().catch(() => "");
  } catch (e) {
    text = `FETCH ERROR: ${e?.message ?? e}`;
  }
  const ms = Date.now() - started;
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body — usually a wrong path (Cin7 serves an HTML page) */
  }
  console.log(`\n▶ ${method} ${path}${query ? " " + JSON.stringify(query) : ""}  → ${status} (${ms}ms)`);
  if (body !== undefined) console.log("  body sent:", JSON.stringify(body));
  if (json !== undefined) {
    const preview = JSON.stringify(json, null, 2);
    console.log(preview.length > 4000 ? preview.slice(0, 4000) + "\n  …(truncated)" : preview);
  } else {
    console.log("  raw:", text.slice(0, 1500));
  }
  return { status, json, text };
}

function firstOf(obj, keys) {
  for (const k of keys) if (Array.isArray(obj?.[k]) && obj[k].length) return obj[k][0];
  return undefined;
}

async function main() {
  console.log(`Cin7 Sale/Quote create probe — account ${ACCOUNT_ID.slice(0, 8)}…  mode=${DO_CREATE ? "CREATE (writes)" : "context (read-only)"}`);

  // ── Step 1: read context — confirm creds and find a real customer / location / product. ──
  const products = await cin7("/product", { query: { Page: 1, Limit: 1 } });
  await sleep(PACE_MS);
  const customers = await cin7("/customer", { query: { Page: 1, Limit: 1 } });
  await sleep(PACE_MS);
  const locations = await cin7("/ref/location", { query: { Page: 1, Limit: 5 } });

  const product = firstOf(products.json, ["Products", "ProductList"]);
  const customer = firstOf(customers.json, ["CustomerList", "Customers"]);
  const location = firstOf(locations.json, ["LocationList", "Locations"]);

  console.log("\n── context found ──");
  console.log("  product:", product ? { ID: product.ID ?? product.ProductID, SKU: product.SKU, Name: product.Name, AverageCost: product.AverageCost } : "NONE");
  console.log("  customer:", customer ? { ID: customer.ID ?? customer.CustomerID, Name: customer.Name } : "NONE");
  console.log("  location:", location ? { ID: location.ID, Name: location.Name } : (locations.json ? "shape? see raw above" : "NONE"));

  if (!DO_CREATE) {
    console.log("\n✅ Context read complete (no writes). Re-run with --create to attempt the sale/quote create.");
    return;
  }

  if (!customer || !location) {
    console.log("\n⚠ Cannot attempt create without a customer and a location — check the shapes above and tell me the right keys.");
    return;
  }

  // ── Step 2: create the sale header (ROUND 1 GUESS — refine from the error). ──
  // Best guess from SALE_WRITABLE_FIELDS + the DRAFT-status create pattern (PO/StockTransfer).
  // Cin7 marks Location as required and Customer-or-CustomerID as required; SkipQuote:false keeps
  // it at the Quote stage. External ID is our reconciliation key (mirrors PO/Stock-Transfer).
  const today = new Date().toISOString().slice(0, 10);
  const custName = customer.Name;
  const locName = location?.Name ?? location;
  await sleep(PACE_MS);
  const header = await cin7("/sale", {
    method: "POST",
    body: {
      Customer: custName,
      Location: locName,
      SaleOrderDate: today,
      SkipQuote: false,
      TaxRule: "Tax on Sales", // common default; error will name the valid rule if wrong
      TaxInclusive: false,
      ExternalID: `PROBE-${Date.now()}`,
    },
  });

  const saleId = header.json?.ID ?? header.json?.SaleID;
  if (!saleId) {
    console.log("\n⚠ No SaleID returned — read the error/body above; adjust the /sale header payload and re-run.");
    return;
  }
  console.log(`\n✓ Sale header created: ${saleId}`);

  // ── Step 3: add quote lines (ROUND 1 GUESS — refine from the error). ──
  // /sale/quote is a distinct sub-resource (docs/cin7-api-findings.md §13h; QuoteStatuses unconfirmed).
  await sleep(PACE_MS);
  await cin7("/sale/quote", {
    method: "POST",
    body: {
      SaleID: saleId,
      Status: "DRAFT",
      Lines: [
        {
          ProductID: product?.ID ?? product?.ProductID,
          SKU: product?.SKU,
          Name: product?.Name,
          Quantity: 1,
          Price: 100,
          Discount: 0,
          Tax: 0,
          Total: 100,
        },
      ],
    },
  });

  console.log("\n✅ Create attempt done. Paste the full output above and we refine the payloads round by round.");
  console.log(`   (Sandbox now has a probe sale ${saleId} / ExternalID PROBE-*; delete these in Cin7 when done.)`);
}

main().catch((e) => {
  console.error("Probe crashed:", e);
  process.exit(1);
});
