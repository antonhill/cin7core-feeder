"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { MAPPING_MATCHERS, isPlausibleCandidate, type MappingCandidate } from "@/newquip/grower/mapping";
import type { ProductCommercials } from "@/newquip/grower/quote-bridge";

// READ-ONLY server actions for the NewQuip Grower POC. They only SELECT from the org's already-synced
// catalogue (products, price_tiers). There is deliberately no Cin7 client import, no insert/update/delete,
// and no quote-submit call anywhere in this file — enforced structurally by
// src/newquip/grower/__tests__/no-write.test.ts. Customer search and reference data reuse the existing
// quotes actions directly from the page.
//
// NOTE: a "use server" file may export ONLY async functions (types are erased and fine).

export interface GrowerActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

async function authorise(): Promise<string> {
  const { orgId } = await requireNewquipPocOrg();
  await requireModuleAccess(QUOTES_MODULE.href);
  return orgId;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * For each item, propose PLAUSIBLE candidates from the synced catalogue. Plausibility is the single shared
 * definition in mapping.ts (isPlausibleCandidate) — SQL only pre-filters. Never auto-confirms.
 */
export async function discoverGrowerProductsAction(): Promise<GrowerActionResult<Record<string, MappingCandidate[]>>> {
  try {
    const orgId = await authorise();
    const db = createServiceRoleClient();
    const out: Record<string, MappingCandidate[]> = {};
    const costBySku = new Map<string, number | null>();
    for (const m of MAPPING_MATCHERS) {
      const found = new Map<string, MappingCandidate>();
      for (const seed of m.seeds) {
        const safe = seed.replace(/[^\w\s.-]/g, "").trim();
        if (safe.length < 2) continue;
        const like = `%${safe}%`;
        const { data, error } = await db
          .from("products")
          .select("sku, name, average_cost")
          .eq("org_id", orgId)
          .eq("active", true)
          .or(`sku.ilike.${like},name.ilike.${like}`)
          .order("sku", { ascending: true })
          .limit(500);
        if (error) throw new Error(error.message);
        for (const p of data ?? []) {
          if (!isPlausibleCandidate(m.itemKey, p.name)) continue;
          const cost = p.average_cost == null ? null : Number(p.average_cost);
          costBySku.set(p.sku, cost);
          found.set(p.sku, { sku: p.sku, name: p.name, averageCost: cost, reason: m.reason });
        }
      }
      out[m.itemKey] = [...found.values()].slice(0, 25);
    }

    const skus = [...costBySku.keys()];
    if (skus.length > 0) {
      const { data: avail, error } = await db.from("product_availability").select("product_sku, available").eq("org_id", orgId).in("product_sku", skus);
      if (error) throw new Error(error.message);
      const totals = new Map<string, number>();
      for (const a of avail ?? []) totals.set(a.product_sku, (totals.get(a.product_sku) ?? 0) + Number(a.available ?? 0));
      for (const list of Object.values(out)) for (const c of list) c.available = totals.has(c.sku) ? totals.get(c.sku)! : null;
    }
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Current commercials (Average Cost, tier prices, active flag) for chosen SKUs. */
export async function lookupGrowerProductsAction(skus: string[]): Promise<GrowerActionResult<ProductCommercials[]>> {
  try {
    const orgId = await authorise();
    const wanted = [...new Set((skus ?? []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
    if (wanted.length === 0) return { ok: true, data: [] };
    const db = createServiceRoleClient();
    const { data: prods, error } = await db
      .from("products")
      .select("sku, name, active, average_cost")
      .eq("org_id", orgId)
      .in("sku", wanted);
    if (error) throw new Error(error.message);
    const { data: tiers, error: tErr } = await db
      .from("price_tiers")
      .select("product_sku, tier_code, amount")
      .eq("org_id", orgId)
      .in("product_sku", wanted);
    if (tErr) throw new Error(tErr.message);
    const bySku = new Map<string, Record<string, number>>();
    for (const t of tiers ?? []) {
      const m = bySku.get(t.product_sku) ?? {};
      m[t.tier_code] = Number(t.amount);
      bySku.set(t.product_sku, m);
    }
    return {
      ok: true,
      data: (prods ?? []).map((p) => ({
        sku: p.sku,
        name: p.name,
        active: Boolean(p.active),
        averageCost: p.average_cost == null ? null : Number(p.average_cost),
        tierPrices: bySku.get(p.sku) ?? {},
      })),
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
