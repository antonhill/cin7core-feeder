"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { STOCKTAKE_MODULE } from "@/app/module-nav";
import { getStocktakeLocations, getStocktakeStagedStock } from "@/reports/query";
import { parseStocktakeFile, buildConfirmationLines, type StocktakeRow, type ConfirmationLine } from "@/reports/stocktake-assistant/build";

export interface StocktakeActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Every location this instance has synced stock in — a plain DB read (product_availability), no live Cin7 call, since a stocktake location by definition already has stock. */
export async function loadStocktakeLocationsAction(instanceId: string): Promise<StocktakeActionResult<string[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireModuleAccess(STOCKTAKE_MODULE.href);
    const db = createServiceRoleClient();
    const locations = await getStocktakeLocations(db, orgId, instanceId);
    return { ok: true, data: locations };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface StocktakePreviewData {
  originalRows: StocktakeRow[];
  confirmationLines: ConfirmationLine[];
}

/**
 * Read-only — no Cin7 write happens anywhere in this feature (the merge and
 * download are pure client-side logic over data already synced into this
 * app's own tables), so unlike every write feature in this app there's no
 * requireWriteAllowed gate here.
 */
export async function previewStocktakeAction(instanceId: string, location: string, formData: FormData): Promise<StocktakeActionResult<StocktakePreviewData>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!location) return { ok: false, error: "Choose a location." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a stocktake CSV file." };

  try {
    const csvText = await file.text();
    const { rows, error } = parseStocktakeFile(csvText);
    if (error) return { ok: false, error };

    const { orgId } = await requireModuleAccess(STOCKTAKE_MODULE.href);
    const db = createServiceRoleClient();
    const staged = await getStocktakeStagedStock(db, orgId, instanceId, location);

    return { ok: true, data: { originalRows: rows, confirmationLines: buildConfirmationLines(staged) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
