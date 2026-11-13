import "server-only";
import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

// NewQuip READ-ONLY Cin7 diagnostic. Reads LIVE Cin7 product / supplier data for a list of SKUs so it can be compared (locally, by the owner) with the source files.
// Nothing here writes to Cin7, to a quotation draft or to the Toolbox cache. Every request goes through Cin7ReadOnlyGate, which can only express a GET of an
// allowlisted path with allowlisted query keys. Failures are mapped to short codes: no credential, header, URL or raw Cin7 error body is ever returned or thrown.

export const ALLOWED_PATHS: readonly string[] = ["/Product", "/Supplier"];
export const ALLOWED_QUERY_KEYS: readonly string[] = ["SKU", "Name", "ID", "IncludeSuppliers", "IncludeBOM", "page", "limit"];
export const MAX_SKUS = 150;
const MAX_SKU_LEN = 64;
const SKU_CHARSET = /^[A-Za-z0-9._\-/ ]+$/;
const MAX_QUERY_VALUE_LEN = 128;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_RATE_LIMIT_RETRIES = 3;
const BACKOFF_MS = [2000, 4000, 8000];
const PACING_MS = 1000;

/** A short, safe failure code (never a message from Cin7, never a URL or credential). */
export class DiagnosticError extends Error {
  constructor(public code: string) { super(code); this.name = "DiagnosticError"; }
}

export type QueryValue = string | number | boolean;
/** The only thing the gate ever hands to a transport: method is always GET. */
export type GetTransport = (method: "GET", path: string, query: Record<string, string | number>) => Promise<unknown>;

export class Cin7ReadOnlyGate {
  constructor(private readonly transport: GetTransport) {}
  /** The ONLY operation: there is no method parameter, so a write cannot be expressed. */
  async get(path: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    if (typeof path !== "string" || !ALLOWED_PATHS.includes(path)) throw new DiagnosticError("path_not_allowed");
    const safe: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(query)) {
      if (!ALLOWED_QUERY_KEYS.includes(key)) throw new DiagnosticError("query_key_not_allowed");
      if (typeof value === "number") { if (!Number.isFinite(value)) throw new DiagnosticError("query_value_invalid"); safe[key] = value; }
      else if (typeof value === "boolean") safe[key] = value ? "true" : "false";
      else if (typeof value === "string" && value.length <= MAX_QUERY_VALUE_LEN && !/[\u0000-\u001f]/.test(value)) safe[key] = value;
      else throw new DiagnosticError("query_value_invalid");
    }
    return this.transport("GET", path, safe);
  }
}

/** The real transport: the existing Cin7 gateway, GET only, no internal retries (the diagnostic does its own bounded backoff). */
export function cin7Transport(creds: Cin7Credentials): GetTransport {
  return (method, path, query) => cin7Request<unknown>(creds, path, { method, query, maxRetries: 0 });
}

function codeOf(e: unknown): string {
  if (e instanceof DiagnosticError) return e.code;
  const status = e && typeof e === "object" ? (e as { status?: unknown }).status : undefined;
  if (typeof status === "number" && status > 0) return `http_${status}`;
  return "network";
}
const isRateLimit = (code: string) => code === "http_429" || code === "http_503";

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- input validation ----
export function validateSkus(input: unknown): { ok: true; skus: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Provide a list of SKUs." };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") return { ok: false, error: "Every SKU must be text." };
    const sku = raw.trim();
    if (!sku) continue; // blank lines are ignored
    if (sku.length > MAX_SKU_LEN) return { ok: false, error: `A SKU is longer than ${MAX_SKU_LEN} characters.` };
    if (!SKU_CHARSET.test(sku)) return { ok: false, error: "A SKU contains a character that is not allowed (letters, digits and . _ - / space only)." };
    if (!seen.has(sku)) { seen.add(sku); out.push(sku); }
  }
  if (!out.length) return { ok: false, error: "Provide at least one SKU." };
  if (out.length > MAX_SKUS) return { ok: false, error: `At most ${MAX_SKUS} SKUs per run.` };
  return { ok: true, skus: out };
}

// ---- result shapes ----
type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const SUBST = /substitut|alternat|alias|replace/i;

function substitutionFields(o: Raw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (SUBST.test(k)) out[k] = v;
  return out;
}

export interface SupplierEntry {
  supplierName: string | null; supplierId: string | null;
  /** The supplier RECORD's own Currency on the product, or null. Never inferred from the (stale) Toolbox suppliers table. */
  recordCurrency: string | null;
  /** Live /Supplier master Currency (filled after the supplier lookups), or null. */
  masterCurrency: string | null;
  /** Raw Suppliers[].Cost and Suppliers[].FixedCost exactly as Cin7 returned them. Not interpreted. */
  cost: number | null; fixedCost: number | null;
  supplierInventoryCode: string | null; lastSupplied: string | null;
  currencyConflict: boolean; currencyUnknown: boolean;
  substitutionFields: Record<string, unknown>;
}
export interface BomComponent { code: string | null; name: string | null; qty: number | null; wastagePercent: number | null; wastageQty: number | null; costPercentage: number | null; raw: Raw; substitutionFields: Record<string, unknown> }
export interface SkuResult {
  sku: string; found: boolean; error: string | null;
  status: string | null; type: string | null; uom: string | null; costingMethod: string | null; averageCost: number | null;
  suppliers: SupplierEntry[];
  bom: { type: string | null; components: BomComponent[]; services: Raw[] } | null;
  rawBomLineKeys: string[]; rawSupplierKeys: string[];
  substitutionFields: Record<string, unknown>;
}
export interface SupplierMaster { name: string; found: boolean; currency: string | null; status: string | null; error: string | null }
export interface DiagnosticSummary {
  requested: number; found: number; missing: number; inactive: number; noSupplier: number; multipleSuppliers: number;
  currencyConflicts: number; currencyUnknown: number; bomMissing: number; errors: number;
}
export interface DiagnosticResult {
  generatedAt: string; readOnly: true; aborted: boolean;
  fieldNotes: Record<string, string>;
  summary: DiagnosticSummary; skus: SkuResult[]; supplierMasters: SupplierMaster[];
}

const FIELD_NOTES: Record<string, string> = {
  cost: "Cin7 /Product Suppliers[].Cost exactly as returned (not interpreted: not confirmed as the latest price or as a per-unit price).",
  fixedCost: "Cin7 /Product Suppliers[].FixedCost exactly as returned (not interpreted).",
  recordCurrency: "Suppliers[].Currency on the product's own supplier record, or null when the record carries none. Never inferred.",
  masterCurrency: "Currency on the LIVE /Supplier master record (exact name match), or null.",
  currencyConflict: "Both currencies are known and differ.",
  currencyUnknown: "Neither the record nor the live supplier master gives a currency.",
  rawBomLineKeys: "Every key seen on any BOM component object, so substitute/alternative fields are discovered rather than assumed.",
};

function parseSupplier(s: Raw): SupplierEntry {
  return {
    supplierName: str(s.SupplierName) ?? str(s.Supplier), supplierId: str(s.SupplierID) ?? str(s.ID),
    recordCurrency: str(s.Currency), masterCurrency: null,
    cost: num(s.Cost), fixedCost: num(s.FixedCost),
    supplierInventoryCode: str(s.SupplierInventoryCode) ?? str(s.SupplierSKU) ?? str(s.SupplierProductCode), lastSupplied: str(s.LastSupplied),
    currencyConflict: false, currencyUnknown: false, substitutionFields: substitutionFields(s),
  };
}
function parseComponent(c: Raw): BomComponent {
  return {
    code: str(c.ProductCode) ?? str(c.ComponentProductCode) ?? str(c.SKU), name: str(c.Name) ?? str(c.ComponentName),
    qty: num(c.Quantity), wastagePercent: num(c.WastagePercent), wastageQty: num(c.WastageQuantity), costPercentage: num(c.CostPercentage),
    raw: c, substitutionFields: substitutionFields(c),
  };
}
const objs = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isObj) : []);

function emptyResult(sku: string, error: string | null): SkuResult {
  return { sku, found: false, error, status: null, type: null, uom: null, costingMethod: null, averageCost: null, suppliers: [], bom: null, rawBomLineKeys: [], rawSupplierKeys: [], substitutionFields: {} };
}

function parseProduct(sku: string, p: Raw): SkuResult {
  const supplierRaw = objs(p.Suppliers);
  const compRaw = objs(p.BillOfMaterialsProducts);
  const svcRaw = objs(p.BillOfMaterialsServices);
  const isBom = p.BillOfMaterial === true || compRaw.length > 0 || svcRaw.length > 0;
  return {
    sku, found: true, error: null,
    status: str(p.Status), type: str(p.Type), uom: str(p.UOM), costingMethod: str(p.CostingMethod), averageCost: num(p.AverageCost),
    suppliers: supplierRaw.map(parseSupplier),
    bom: isBom ? { type: str(p.BOMType), components: compRaw.map(parseComponent), services: svcRaw } : null,
    rawBomLineKeys: [...new Set(compRaw.flatMap((c) => Object.keys(c)))].sort(),
    rawSupplierKeys: [...new Set(supplierRaw.flatMap((s) => Object.keys(s)))].sort(),
    substitutionFields: substitutionFields(p),
  };
}

/** One GET with bounded backoff on rate limiting (429 / Cin7's 503). Throws a DiagnosticError with a short code. */
async function getWithBackoff(gate: Cin7ReadOnlyGate, sleep: Sleep, path: string, query: Record<string, QueryValue>): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return await gate.get(path, query); }
    catch (e) {
      const code = codeOf(e);
      if (isRateLimit(code) && attempt < MAX_RATE_LIMIT_RETRIES) { await sleep(BACKOFF_MS[attempt] ?? 8000); continue; }
      throw new DiagnosticError(code);
    }
  }
}

export interface InspectOptions { sleep?: Sleep; now?: () => Date }

/** Sequential, paced, abort-after-3-consecutive-errors. `skus` must already be validated (validateSkus). */
export async function inspectSkus(gate: Cin7ReadOnlyGate, skus: string[], opts: InspectOptions = {}): Promise<DiagnosticResult> {
  const sleep = opts.sleep ?? realSleep;
  const results: SkuResult[] = [];
  let consecutive = 0;
  let aborted = false;
  let first = true;
  for (const sku of skus) {
    if (aborted) { results.push(emptyResult(sku, "skipped_after_abort")); continue; }
    if (!first) await sleep(PACING_MS);
    first = false;
    try {
      const resp = await getWithBackoff(gate, sleep, "/Product", { SKU: sku, IncludeSuppliers: "true", IncludeBOM: "true", page: 1, limit: 1 });
      consecutive = 0;
      const p = isObj(resp) ? objs(resp.Products)[0] : undefined;
      results.push(p && p.SKU === sku ? parseProduct(sku, p) : emptyResult(sku, null)); // exact SKU only: Cin7 may ignore the filter
    } catch (e) {
      results.push(emptyResult(sku, codeOf(e)));
      if (++consecutive >= MAX_CONSECUTIVE_ERRORS) aborted = true;
    }
  }

  // Live supplier master for the distinct supplier names (exact name match).
  const masters = new Map<string, SupplierMaster>();
  const names = [...new Set(results.flatMap((r) => r.suppliers.map((s) => s.supplierName)).filter((n): n is string => !!n))].sort();
  let supplierErrors = 0;
  for (const name of names) {
    if (aborted || supplierErrors >= MAX_CONSECUTIVE_ERRORS) { masters.set(name, { name, found: false, currency: null, status: null, error: "skipped_after_abort" }); continue; }
    await sleep(PACING_MS);
    try {
      const resp = await getWithBackoff(gate, sleep, "/Supplier", { Name: name, page: 1, limit: 1 });
      supplierErrors = 0;
      const s = isObj(resp) ? objs(resp.SupplierList)[0] : undefined;
      masters.set(name, s && s.Name === name ? { name, found: true, currency: str(s.Currency), status: str(s.Status), error: null } : { name, found: false, currency: null, status: null, error: null });
    } catch (e) {
      supplierErrors++;
      masters.set(name, { name, found: false, currency: null, status: null, error: codeOf(e) });
    }
  }

  let currencyConflicts = 0; let currencyUnknown = 0;
  for (const r of results) for (const s of r.suppliers) {
    s.masterCurrency = s.supplierName ? masters.get(s.supplierName)?.currency ?? null : null;
    s.currencyConflict = !!s.recordCurrency && !!s.masterCurrency && s.recordCurrency.toUpperCase() !== s.masterCurrency.toUpperCase();
    s.currencyUnknown = !s.recordCurrency && !s.masterCurrency;
    if (s.currencyConflict) currencyConflicts++;
    if (s.currencyUnknown) currencyUnknown++;
  }

  const foundRows = results.filter((r) => r.found);
  const summary: DiagnosticSummary = {
    requested: skus.length, found: foundRows.length, missing: results.filter((r) => !r.found && !r.error).length,
    inactive: foundRows.filter((r) => r.status !== null && r.status.toLowerCase() !== "active").length,
    noSupplier: foundRows.filter((r) => r.suppliers.length === 0).length,
    multipleSuppliers: foundRows.filter((r) => r.suppliers.length > 1).length,
    currencyConflicts, currencyUnknown,
    bomMissing: foundRows.filter((r) => r.bom === null).length,
    errors: results.filter((r) => !!r.error).length + [...masters.values()].filter((m) => !!m.error).length,
  };
  return { generatedAt: (opts.now?.() ?? new Date()).toISOString(), readOnly: true, aborted, fieldNotes: FIELD_NOTES, summary, skus: results, supplierMasters: [...masters.values()] };
}
