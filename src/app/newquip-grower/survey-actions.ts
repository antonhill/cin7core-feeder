"use server";

// NewQuip COST-SOURCE SURVEY (read-only). GET of /Product and the supplier catalogue only, through Cin7ReadOnlyGate (no method parameter: a write cannot be expressed).
// Writes NOTHING: no Cin7 write, no database write (not even an audit row), no quotation or pricing-source change. Cost-bearing output: internal, never cached, never for a Rep.
// Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { isQueryableString } from "@/cin7/readonly-diagnostic";
import { listCin7Suppliers, readRawProductsForSurvey } from "@/lib/projects/latest-cost-adapter";
import { referencedSkus } from "@/newquip/grower/commercial";
import { PENNING_COMPONENTS } from "@/newquip/grower/penning";
import { DEMO_DEFAULTS } from "@/newquip/grower/demo-defaults";
import { classifySku, pickUnitFields, type MasterSupplier, type RawSupplierRecord, type SurveyInput, type SurveyResult } from "@/newquip/pricing/cost-survey";
import { authoriseActor } from "./actor";

export interface SurveyUniverse { skus: string[]; sources: Record<string, string[]>; /** true when the quotation read hit its row cap, so SKUs from older quotations may be missing. */ truncated: boolean }
export interface SurveyChunk { generatedAt: string; results: SurveyResult[]; inputs: SurveyInput[]; productKeys: string[]; supplierKeys: string[]; errors: Record<string, string> }
export interface SurveyActionResult<T> { ok: boolean; error?: string; data?: T }

const MSG = "The survey could not be completed. Nothing was changed.";
const MAX_CHUNK = 12;

async function costActor() {
  const a = await authoriseActor();
  if (a.demo || !a.canSeeCost) throw new Error("not allowed");
  return a;
}
type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dateOnly = (v: unknown): string | null => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s; };

/** The SKUs NewQuip maps: the commercial mappings, the demo defaults, the active saved package mappings and every SKU already in a quotation's pricing. Reads only. */
export async function getCostSurveyUniverseAction(): Promise<SurveyActionResult<SurveyUniverse>> {
  try {
    const a = await costActor();
    const db = createServiceRoleClient();
    const sources: Record<string, string[]> = {};
    const add = (sku: unknown, src: string) => { if (typeof sku === "string" && sku.trim()) (sources[sku.trim()] ??= []).includes(src) || sources[sku.trim()].push(src); };
    referencedSkus().forEach((s) => add(s, "commercial mapping"));
    PENNING_COMPONENTS.forEach((c) => add(c.sku, "penning component"));
    Object.values(DEMO_DEFAULTS.estimator?.confirmedMappings ?? {}).forEach((s) => add(s, "grower default"));
    const { data: maps, error: mapErr } = await db.from("newquip_package_mappings").select("lines").eq("org_id", a.orgId).eq("status", "ACTIVE");
    for (const m of maps ?? []) for (const l of (m.lines as Array<{ sku?: string }>) ?? []) add(l.sku, "saved package mapping");
    if (mapErr) throw new Error("read failed");
    const CAP = 2000;
    const { data: qs, error: qErr } = await db.from("newquip_quotes").select("skus:draft->estimator->pricing->skus").eq("org_id", a.orgId).order("created_at", { ascending: false }).limit(CAP);
    if (qErr) throw new Error("read failed");
    for (const q of qs ?? []) { const s = (q as { skus?: unknown }).skus; if (isObj(s)) Object.keys(s).forEach((k) => add(k, "existing quotation")); }
    return { ok: true, data: { skus: Object.keys(sources).sort(), sources, truncated: (qs ?? []).length >= CAP } };
  } catch { return { ok: false, error: MSG }; }
}

/** Reads up to 12 SKUs from Cin7 (GET only, paced, bounded backoff) and classifies each. */
export async function surveyCin7SkusAction(skus: string[]): Promise<SurveyActionResult<SurveyChunk>> {
  try {
    const a = await costActor(); // authority first: an unauthorised caller learns nothing about input validity
    if (!Array.isArray(skus) || skus.length === 0 || skus.length > MAX_CHUNK || !skus.every((s) => typeof s === "string" && /^[A-Za-z0-9._\-/]{1,64}(?: [A-Za-z0-9._\-/]+)*$/.test(s) && isQueryableString(s))) throw new TypeError("bad request");
    const db = createServiceRoleClient();
    const dir = await listCin7Suppliers(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID);
    const master = new Map<string, MasterSupplier>(dir.map((s) => [s.id, { id: s.id, name: s.name, currency: s.currency, active: s.active }]));
    const inputs: SurveyInput[] = [], errors: Record<string, string> = {};
    const productKeys = new Set<string>(), supplierKeys = new Set<string>();
    const reads = await readRawProductsForSurvey(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, skus);
    for (const sku of skus) {
      const r = reads[sku];
      if (!r || "error" in r) { errors[sku] = r && "error" in r ? r.error : "network"; continue; }
      const p = r.raw;
      if (!p) { inputs.push({ sku, found: false, productStatus: null, productName: null, uom: null, averageCost: null, suppliers: [], unitFields: {} }); continue; }
      Object.keys(p).forEach((k) => productKeys.add(k));
      const sups = (Array.isArray(p.Suppliers) ? (p.Suppliers as unknown[]).filter(isObj) : []);
      sups.forEach((s) => Object.keys(s).forEach((k) => supplierKeys.add(k)));
      const suppliers: RawSupplierRecord[] = sups.map((s) => ({ supplierId: str(s.SupplierID), supplierName: str(s.SupplierName), cost: num(s.Cost), fixedCost: num(s.FixedCost), currency: str(s.Currency), lastSupplied: dateOnly(s.LastSupplied) }));
      const unitFields = { ...pickUnitFields(p), ...Object.assign({}, ...sups.map((s, i) => pickUnitFields(s, `supplier${i}.`))) };
      inputs.push({ sku, found: true, productStatus: str(p.Status), productName: str(p.Name), uom: str(p.UOM), averageCost: num(p.AverageCost), suppliers, unitFields });
    }
    const today = new Date().toISOString().slice(0, 10);
    return { ok: true, data: { generatedAt: new Date().toISOString(), inputs, results: inputs.map((i) => classifySku(i, master, today)), productKeys: [...productKeys].sort(), supplierKeys: [...supplierKeys].sort(), errors } };
  } catch (e) { return { ok: false, error: e instanceof TypeError ? "The request was not valid." : MSG }; }
}
