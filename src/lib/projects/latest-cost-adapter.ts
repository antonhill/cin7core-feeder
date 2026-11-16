import { Cin7ReadOnlyGate, cin7Transport } from "@/cin7/readonly-diagnostic";
import "server-only";
// The ONE place the NewQuip cost estimate touches the Cin7 API: a READ-ONLY lookup of each SKU's supplier price records. Credentials are loaded for the org's own
// instance, never leave the server and are never logged. (The Grower module itself stays sealed from Cin7; it asks this adapter.)
//
// Each Suppliers[] record becomes a RawSupplierPrice. Interpreted fields: SupplierName / SupplierID|ID, Cost (the supplier's Latest Price), LastSupplied, and
// Currency when the record carries one. When it does not, the price currency is the SUPPLIER'S currency from the Toolbox's synced supplier master (Cin7 shows
// supplier prices in supplier currency); an unknown supplier currency stays unknown and the price is unusable. FixedCost and AverageCost are never read here.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchProductCostRead } from "@/cin7/latest-cost";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import type { Cin7ProductSupplierRef, Cin7SupplierRef, IdentityLookups } from "@/newquip/pricing/estimator/supplier-identity";

import { rawFromCin7, type RawSupplierPrice } from "./supplier-price";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface SkuSupplierPrices { sku: string; found: boolean; stockUom: string | null; raws: RawSupplierPrice[] }

async function supplierCurrencies(db: Db, orgId: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (names.length === 0) return out;
  const r = await db.from("suppliers").select("name, currency").eq("org_id", orgId).in("name", names);
  if (r.error) return out; // unknown stays unknown: the affected prices are unusable, never assumed rand
  for (const row of (r.data ?? []) as Array<{ name: string; currency: string | null }>) if (row.currency) out.set(row.name, row.currency);
  return out;
}

/** Every supplier price record of each SKU (one read per SKU). A SKU Cin7 does not return exactly is `found: false`. */
export async function readSupplierPrices(db: Db, orgId: string, instanceId: string, skus: readonly string[]): Promise<Record<string, SkuSupplierPrices>> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const reads = new Map<string, Awaited<ReturnType<typeof fetchProductCostRead>>>();
  for (const sku of [...new Set(skus)]) reads.set(sku, await fetchProductCostRead(creds, sku));
  const names = [...new Set([...reads.values()].flatMap((p) => (p?.rawSuppliers ?? []).map((s) => (typeof s.SupplierName === "string" ? s.SupplierName : typeof s.Supplier === "string" ? s.Supplier : null))).filter((n): n is string => !!n))];
  const cur = await supplierCurrencies(db, orgId, names);
  const out: Record<string, SkuSupplierPrices> = {};
  for (const [sku, p] of reads) {
    out[sku] = p
      ? { sku, found: true, stockUom: p.uom, raws: p.rawSuppliers.map((s) => ({ ...rawFromCin7(s, (n) => (n ? cur.get(n) ?? null : null)), stockUnit: p.uom })) }
      : { sku, found: false, stockUom: null, raws: [] };
  }
  return out;
}

// ── READ-ONLY Cin7 supplier data for the Estimator's cost entry (GET /supplier and GET /Product?IncludeSuppliers=true). ──────────────────────────────────────────────────────────────────────────────────────
// The active supplier catalogue and one product's own supplier records. Nothing here writes to Cin7, and nothing is invented: every field below is one the repository has already confirmed live
// (docs/cin7-api-findings.md section 10 and src/cin7/product-supplier-options.ts): /supplier -> SupplierList[]: ID, Name, Status, Currency; /Product -> Suppliers[]: SupplierID, SupplierName, Cost, FixedCost,
// Currency, LastSupplied. A field Cin7 does not return stays null (never defaulted). The credentials are the org's own NewQuip instance, loaded server-side only.
const TTL_MS = 120_000;
const cache = new Map<string, { at: number; list: Cin7SupplierRef[] }>();
let inflight: Record<string, Promise<Cin7SupplierRef[]> | undefined> = {}; // concurrent callers share ONE read of the catalogue
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const day = (v: unknown): string | null => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

export function toSupplierRef(raw: Record<string, unknown>): Cin7SupplierRef | null {
  const id = str(raw.ID);
  const name = str(raw.Name);
  if (!id || !name) return null;
  const cur = str(raw.Currency);
  return { id, name, currency: cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null, active: (str(raw.Status) ?? "Active").toLowerCase() === "active" };
}

/** Every supplier in the org's Cin7 instance (cached for two minutes so a search box does not re-read the catalogue on every keystroke). */
export async function listCin7Suppliers(db: Db, orgId: string, instanceId: string, now = Date.now()): Promise<Cin7SupplierRef[]> {
  const key = `${orgId}:${instanceId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.list;
  const running = inflight[key];
  if (running) return running;
  const p = (async () => {
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const list = (await fetchAllSuppliers(creds)).map(toSupplierRef).filter((x): x is Cin7SupplierRef => x !== null);
    cache.set(key, { at: now, list });
    return list;
  })().finally(() => { inflight[key] = undefined; });
  inflight[key] = p;
  return p;
}
export function clearSupplierCache(): void { cache.clear(); inflight = {}; }

export interface ProductSupplierRead { found: boolean; productName: string | null; /** Cin7's AverageCost: an UNDATED figure, only ever shown as information, never used as a supplier cost. */ averageCost: number | null; suppliers: Cin7ProductSupplierRef[] }

export function toProductSupplierRefs(raw: Record<string, unknown>[]): Cin7ProductSupplierRef[] {
  const out: Cin7ProductSupplierRef[] = [];
  for (const s of raw) {
    const supplierId = str(s.SupplierID); // never the row's own ID: only the supplier's id is an identity
    const supplierName = str(s.SupplierName) ?? str(s.Supplier);
    if (!supplierId || !supplierName) continue;
    const cur = str(s.Currency);
    out.push({ supplierId, supplierName, cost: typeof s.Cost === "number" && Number.isFinite(s.Cost) && s.Cost > 0 ? s.Cost : null, currency: cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null, lastSupplied: day(s.LastSupplied) });
  }
  return out;
}

export async function readProductSuppliers(db: Db, orgId: string, instanceId: string, sku: string): Promise<ProductSupplierRead> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const p = await fetchProductCostRead(creds, sku);
  if (!p) return { found: false, productName: null, averageCost: null, suppliers: [] };
  return { found: true, productName: p.name || null, averageCost: p.averageCost, suppliers: toProductSupplierRefs(p.rawSuppliers) };
}

/** The lookups the server rule uses when a cost is saved. A failed read is "unavailable" (never "not found"), so an outage can never accept or reject by guesswork. */
export function cin7IdentityLookups(db: Db, orgId: string, instanceId: string): IdentityLookups {
  return {
    async supplier(id) {
      try { return { status: "ok", value: (await listCin7Suppliers(db, orgId, instanceId)).find((s) => s.id === id) ?? null }; } catch { return { status: "unavailable" }; }
    },
    async productSuppliers(sku) {
      try { const r = await readProductSuppliers(db, orgId, instanceId, sku); return { status: "ok", value: r.found ? r.suppliers : null }; } catch { return { status: "unavailable" }; }
    },
  };
}

/**
 * SURVEY READ (read-only): the raw /Product records for a short list of SKUs, GET only through the diagnostic's read-only gate (allowed paths and query keys are enforced there;
 * there is no method parameter, so a write cannot be expressed). Paced, with bounded backoff on rate limiting. A SKU Cin7 does not return exactly is `null`; a failed read is a short code.
 */
export async function readRawProductsForSurvey(db: Db, orgId: string, instanceId: string, skus: readonly string[]): Promise<Record<string, { raw: Record<string, unknown> | null } | { error: string }>> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const gate = new Cin7ReadOnlyGate(cin7Transport(creds));
  const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const out: Record<string, { raw: Record<string, unknown> | null } | { error: string }> = {};
  let first = true;
  for (const sku of skus) {
    if (!first) await nap(700);
    first = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = (await gate.get("/Product", { SKU: sku, IncludeSuppliers: true, page: 1, limit: 10 })) as { Products?: unknown[] } | null;
        const p = (Array.isArray(resp?.Products) ? resp!.Products! : []).find((x): x is Record<string, unknown> => !!x && typeof x === "object" && (x as { SKU?: unknown }).SKU === sku);
        out[sku] = { raw: p ?? null };
        break;
      } catch (e) {
        const st = (e as { status?: number })?.status;
        if ((st === 429 || st === 503) && attempt < 3) { await nap(2000 * 2 ** attempt); continue; }
        out[sku] = { error: st ? `http_${st}` : "network" };
        break;
      }
    }
  }
  return out;
}

