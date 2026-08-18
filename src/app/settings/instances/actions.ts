"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { encrypt, decrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";
import { findProductWithBom, probeWorkCentrePaths, findCustomerAndSupplierExamples, checkCustomerReferenceFields, checkSupplierReferenceFields, findCustomerRawByName, findAccountsByCodes, checkSaleStatuses, findFinishedGoodsExample, surveyFinishedGoodsFields, surveyCostBasisFields, surveyProductionBomFields, surveyProductionBomForSkus, surveyProductionOrderDetail, surveyProductionOrderRoutingTasks, surveyProductionOrderOperationStatus, surveyProductionRun, surveyProductionOrderStatuses, surveyPurchaseDetailFields, surveyProductAvailabilityFields, surveySaleFulfillmentFields, surveyBackorderEtaFields, testSaleShipByWriteBack, testProductSupplierLink, surveyProductSupplierOptionsFields, findProductSupplierOptionsExample, testCreatePurchaseOrder, checkProductAvailabilityForSkus, checkProductSupplierOptionsForUnparsedFields, probeUpdatedSinceFiltering } from "@/cin7/debug";
import { pushCustomer, type CanonicalCustomerAddressRow, type CanonicalCustomerContactRow } from "@/cin7/customers";
import { pushSupplier, type CanonicalSupplierAddressRow, type CanonicalSupplierContactRow } from "@/cin7/suppliers";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requirePrivilegedOrgAdmin, requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { getBillingStatus } from "@/lib/billing";
import { logActivity, type ActivityActor } from "@/lib/activity-log";
import { Cin7ApiError } from "@/cin7/http";

export interface InstanceRecord {
  id: string;
  name: string;
  accountId: string;
  active: boolean;
  keyLast4: string;
  createdAt: string;
  /** P5.3 (LBL brief): orders with an effective date (ship_by, falling back to order_date) before this hide from Pick Today / Ship Today / the Shipping Calendar — null means no floor, the default. Per-instance, not per-org: different instances can be at different points in their own history cleanup. */
  fulfilmentViewStartDate: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  instances?: InstanceRecord[];
}

async function toRecord(row: {
  id: string;
  name: string;
  account_id: string;
  application_key_encrypted: string;
  active: boolean;
  created_at: string;
  fulfilment_view_start_date: string | null;
}): Promise<InstanceRecord> {
  let keyLast4 = "????";
  try {
    const plain = decrypt(row.application_key_encrypted);
    keyLast4 = plain.slice(-4);
  } catch {
    keyLast4 = "????"; // ENCRYPTION_KEY mismatch or corrupt row — never surface the raw error to the UI
  }
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    active: row.active,
    keyLast4,
    createdAt: row.created_at,
    fulfilmentViewStartDate: row.fulfilment_view_start_date,
  };
}

/**
 * Security re-audit closure, Blocker 3: shared logging point for every real
 * write from the diagnostic/credential surface (Cin7 credential CRUD, and
 * the 4 debug* actions that make genuine Cin7 writes) — every one of these
 * was previously entirely unlogged, leaving zero forensic trail for a
 * compromised or malicious super-admin session's writes into a customer's
 * live Cin7 account, or for who changed/rotated a customer's own Cin7
 * credentials. Deliberately never called from the 27 read-only debug*
 * actions — logging a read doesn't inflate coverage, it just adds noise.
 */
async function logPrivilegedWrite(params: {
  orgId: string;
  instanceId?: string | null;
  actor: ActivityActor;
  action: string;
  outcome: "success" | "failed" | "ambiguous";
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const db = createServiceRoleClient();
  await logActivity(db, {
    orgId: params.orgId,
    instanceId: params.instanceId,
    actor: params.actor,
    action: params.action,
    summary: params.summary,
    // Security re-audit closure, Blocker 3: never log the Cin7 Application
    // Key, a decrypted credential, or any other secret — `detail` here is
    // always caller-supplied, non-credential metadata (order numbers, SKUs,
    // row counts, outcome classification), never the raw request/response
    // body of a credential-bearing call.
    detail: { outcome: params.outcome, ...params.detail },
  });
}

export async function listInstances(): Promise<ActionResult> {
  try {
    // Instance config carries Account IDs + key metadata — owner/admin only.
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — credential metadata.
    const { orgId } = await requirePrivilegedOrgAdmin("view Cin7 instance configuration");
    const db = createServiceRoleClient();
    // Security re-audit P0-1: base_url deliberately not selected — nothing
    // in this file needs it anymore, and it stays out of the InstanceRecord
    // handed to the client.
    const { data, error } = await db
      .from("cin7_instances")
      .select("id, name, account_id, application_key_encrypted, active, created_at, fulfilment_view_start_date")
      .eq("org_id", orgId)
      .order("created_at");
    if (error) return { ok: false, error: error.message };

    return { ok: true, instances: await Promise.all((data ?? []).map(toRecord)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function upsertInstance(params: {
  instanceId?: string;
  name: string;
  accountId: string;
  applicationKey?: string;
  active: boolean;
  /** "" clears the floor (no restriction); omitted on create defaults to no floor. */
  fulfilmentViewStartDate?: string;
}): Promise<ActionResult> {
  if (!params.name.trim()) return { ok: false, error: "Name is required." };
  if (!params.accountId.trim()) return { ok: false, error: "Account ID is required." };
  if (!params.instanceId && !params.applicationKey) {
    return { ok: false, error: "Application key is required for a new instance." };
  }

  try {
    // Create / update / replace-key — owner/admin only.
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — writes credentials.
    const { orgId, userId, email } = await requirePrivilegedOrgAdmin("manage Cin7 instances");
    const db = createServiceRoleClient();
    const actor: ActivityActor = { userId, email };

    if (params.instanceId) {
      // Security re-audit P0-1: base_url is intentionally never written here
      // anymore — see the insert branch's comment below.
      const update: Record<string, unknown> = {
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        active: params.active,
        fulfilment_view_start_date: params.fulfilmentViewStartDate?.trim() || null,
        updated_at: new Date().toISOString(),
      };
      if (params.applicationKey) update.application_key_encrypted = encrypt(params.applicationKey);

      const { error } = await db
        .from("cin7_instances")
        .update(update)
        .eq("id", params.instanceId)
        .eq("org_id", orgId);
      if (error) {
        await logPrivilegedWrite({
          orgId,
          instanceId: params.instanceId,
          actor,
          action: "instance.update",
          outcome: "failed",
          summary: `Failed to update Cin7 instance "${params.name.trim()}"`,
          detail: { error: error.message },
        });
        return { ok: false, error: error.message };
      }
      // Security re-audit closure, Blocker 3: never log the Application Key
      // itself — only whether this update rotated it.
      await logPrivilegedWrite({
        orgId,
        instanceId: params.instanceId,
        actor,
        action: "instance.update",
        outcome: "success",
        summary: `Updated Cin7 instance "${params.name.trim()}"${params.applicationKey ? " (rotated Application Key)" : ""}`,
        detail: { name: params.name.trim(), accountId: params.accountId.trim(), active: params.active, rotatedKey: Boolean(params.applicationKey) },
      });
    } else {
      const [{ count }, billing] = await Promise.all([
        db.from("cin7_instances").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        getBillingStatus(orgId),
      ]);
      if ((count ?? 0) >= billing.maxInstances) {
        return {
          ok: false,
          error:
            billing.maxInstances === 1
              ? "Your trial allows 1 connected instance — subscribe to connect another."
              : `Your plan allows ${billing.maxInstances} connected instances.`,
        };
      }

      const { data: inserted, error } = await db
        .from("cin7_instances")
        .insert({
          org_id: orgId,
          name: params.name.trim(),
          account_id: params.accountId.trim(),
          application_key_encrypted: encrypt(params.applicationKey!),
          // Security re-audit P0-1: base_url used to be a free-text field an
          // org admin could edit — every credential-bearing call ignores it
          // regardless (see cin7/api-origin.ts's CIN7_API_ORIGIN), so an
          // editable value was pure attack surface with no real effect.
          // Always the canonical origin now; there is no UI to change it.
          base_url: CIN7_API_ORIGIN,
          active: params.active,
        })
        .select("id")
        .single();
      if (error) {
        await logPrivilegedWrite({
          orgId,
          actor,
          action: "instance.create",
          outcome: "failed",
          summary: `Failed to create Cin7 instance "${params.name.trim()}"`,
          detail: { error: error.message },
        });
        return { ok: false, error: error.message };
      }
      await logPrivilegedWrite({
        orgId,
        instanceId: inserted?.id,
        actor,
        action: "instance.create",
        outcome: "success",
        summary: `Created Cin7 instance "${params.name.trim()}"`,
        detail: { name: params.name.trim(), accountId: params.accountId.trim(), active: params.active },
      });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

async function loadInstanceCreds(instanceId: string) {
  // Chokepoint for every diagnostic below: loading decrypted creds + running live Cin7
  // calls is owner/admin only. testInstanceConnection and all debug* actions go through here.
  //
  // Security re-audit P0-1: this used to select+return the DB-stored, user-editable
  // base_url and hand it straight to raw-fetch diagnostic helpers (cin7/client.ts,
  // cin7/debug.ts) — a stored base_url could redirect these credential-bearing
  // calls off Cin7 entirely. Mirrors loadCin7Credentials' (cin7/load-credentials.ts)
  // already-safe pattern: never select base_url at all, always hand back the
  // canonical, hardcoded origin.
  const { orgId } = await requireOrgAdmin("run Cin7 instance diagnostics");
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("cin7_instances")
    .select("account_id, application_key_encrypted")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Instance not found.");
  return {
    accountId: data.account_id,
    applicationKey: decrypt(data.application_key_encrypted),
    baseUrl: CIN7_API_ORIGIN,
  };
}

export async function testInstanceConnection(instanceId: string): Promise<TestConnectionResult> {
  try {
    const creds = await loadInstanceCreds(instanceId);
    const result = await testConnection(creds);
    return { ok: result.ok, message: `[${result.status || "network"}] ${result.message}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: scans this instance for a product that already has a
 * Bill of Materials configured and returns its raw JSON, so we can see
 * Cin7's own authoritative field shape instead of guessing further.
 */
export async function debugFindBomExample(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (find BOM example)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await findProductWithBom(creds);
    if (!result.found) return { ok: false, message: "No product with a configured BOM was found." };
    return { ok: true, message: JSON.stringify(result.product, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: /production/workcenters keeps returning Cin7's branded
 * "Page not found" page despite two independent sources confirming that
 * path and the account genuinely having Work Centres configured. Tries
 * several plausible casing/path variants live and reports which succeed.
 */
export async function debugProbeWorkCentrePaths(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (probe work centre paths)");
    const creds = await loadInstanceCreds(instanceId);
    const results = await probeWorkCentrePaths(creds);
    const anySucceeded = results.some((r) => r.looksLikeJson);
    return { ok: anySucceeded, message: JSON.stringify(results, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: confirms /customer and /supplier live, ahead of building
 * a push client for the new Customer/Supplier import feature — same
 * verify-before-building step used for Product/BOM.
 */
export async function debugFindCustomerSupplierExamples(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (find customer/supplier examples)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await findCustomerAndSupplierExamples(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: ahead of adding Quantity/BOM-cost to the Assemblies
 * report, dumps one FinishedGoods record's full raw JSON (every key, not
 * just what Cin7FinishedGoodsListEntry types) plus an attempted detail-
 * endpoint call — see findFinishedGoodsExample's own comment for why.
 */
export async function debugFindFinishedGoodsExample(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (find finished goods example)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await findFinishedGoodsExample(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: ahead of adding resources/additional-costs to the
 * Assemblies report's per-build detail view, scans several assemblies
 * (prioritizing different products) and reports the union of every
 * list/detail field seen — see surveyFinishedGoodsFields's own comment for
 * why a single-record check isn't enough to rule a field out.
 */
export async function debugSurveyFinishedGoodsFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey finished goods fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyFinishedGoodsFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: ahead of building the cost estimator's toggleable
 * Average/Latest/Fixed cost basis, confirms whether `AverageCost` and
 * `Suppliers[].Cost`/`FixedCost` actually appear populated on this
 * instance's real live GET /Product data — see surveyCostBasisFields's own
 * comment for why neither field can be trusted yet.
 */
export async function debugSurveyCostBasisFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey cost basis fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyCostBasisFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: ahead of extending the cost estimator to Production BOMs,
 * confirms two unknowns neither this codebase nor docs/cin7-api-findings.md
 * has settled yet — which products have a Production BOM at all (no
 * confirmed bulk-list flag like Assembly BOM's BillOfMaterial), and what a
 * real GET /production/productionBOM response's full Operations/Components/
 * Resources shape looks like (only .Version has ever been read from it so
 * far, in production-bom.ts's findProductionBomVersion).
 */
export async function debugSurveyProductionBomFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey production BOM fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyProductionBomFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: checks specific SKUs directly rather than discovering
 * candidates by paginating the bulk list — for when the candidates are
 * already known (e.g. from Cin7's own InventoryList CSV export's
 * `ProductionBOM` Yes/No column, confirmed 2026-07-08 to be the same signal
 * as the live API's `BOMType === "Production"`, and easier to search across
 * a full catalog export than to paginate live for a rare flag).
 */
export async function debugCheckProductionBomForSkus(instanceId: string, skusInput: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check production BOM for SKUs)");
    const creds = await loadInstanceCreds(instanceId);
    const skus = skusInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!skus.length) return { ok: false, message: "Enter one or more comma-separated SKUs." };

    const result = await surveyProductionBomForSkus(creds, skus);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: confirms live whether specific SKUs have any Product
 * Availability record in Cin7 at all — see checkProductAvailabilityForSkus's
 * own comment for why this matters (distinguishing "never stocked
 * anywhere" from a sync gap).
 */
export async function debugCheckProductAvailabilityForSkus(instanceId: string, skusInput: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check product availability for SKUs)");
    const creds = await loadInstanceCreds(instanceId);
    const skus = skusInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!skus.length) return { ok: false, message: "Enter one or more comma-separated SKUs." };

    const result = await checkProductAvailabilityForSkus(creds, skus);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: fetches a completed Manufacture Order's full detail
 * (Operations -> Components/Resources) by its order number (e.g.
 * "MO-00036") — a genuinely different Cin7 resource from
 * /production/productionBOM (the BOM *definition*, confirmed to never carry
 * cost data on this account). A completed order's Components/Resources are
 * expected to carry real Cost/TotalCost fields per the community client
 * spec; this confirms that live.
 */
export async function debugFetchProductionOrderDetail(instanceId: string, orderNumber: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (fetch production order detail)");
    const creds = await loadInstanceCreds(instanceId);
    const trimmed = orderNumber.trim();
    if (!trimmed) return { ok: false, message: "Enter a Manufacture Order number, e.g. MO-00036." };

    const result = await surveyProductionOrderDetail(creds, trimmed);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: Advanced Manufacturing anticipation work (new client,
 * 2026-07-14) — dumps every /production/orderList row sharing an order's
 * ProductionOrderID (the Type "O" header plus any Type "R" routing
 * sub-rows), raw and unfiltered, to see whether a routing sub-row carries
 * per-stage/work-centre progress that the order's own Operations array
 * doesn't (see surveyProductionOrderRoutingTasks's own comment).
 */
export async function debugSurveyProductionOrderRoutingTasks(instanceId: string, orderNumber: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey production order routing tasks)");
    const creds = await loadInstanceCreds(instanceId);
    const trimmed = orderNumber.trim();
    if (!trimmed) return { ok: false, message: "Enter a Manufacture Order number, e.g. MO-00036." };

    const result = await surveyProductionOrderRoutingTasks(creds, trimmed);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: Advanced Manufacturing anticipation work, continued —
 * tests whether per-operation progress (Start/Suspend/Resume/Complete
 * state, actual vs planned time — confirmed present in Cin7's own UI) is
 * reachable via an omitted-by-default Include*=true flag on
 * /production/order, or a separate operation-level resource. Several extra
 * live calls (~10, ~1.1s apart) — expect this to take a few seconds.
 */
export async function debugSurveyProductionOrderOperationStatus(instanceId: string, orderNumber: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey production order operation status)");
    const creds = await loadInstanceCreds(instanceId);
    const trimmed = orderNumber.trim();
    if (!trimmed) return { ok: false, message: "Enter a Manufacture Order number, e.g. MO-00019." };

    const result = await surveyProductionOrderOperationStatus(creds, trimmed);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: Advanced Manufacturing anticipation work — probes the
 * separate GET /production/order/run resource found in the community
 * Apiary spec, which documents per-operation Status/actual quantities/
 * wastage/resource costs that /production/order never exposed.
 */
export async function debugSurveyProductionRun(instanceId: string, orderNumber: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey production run)");
    const creds = await loadInstanceCreds(instanceId);
    const trimmed = orderNumber.trim();
    if (!trimmed) return { ok: false, message: "Enter a Manufacture Order number, e.g. MO-00019." };

    const result = await surveyProductionRun(creds, trimmed);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: tallies real Status/OrderStatus values across every
 * Production Order on this instance, ahead of a planned Kanban board
 * grouped by pre-production status (draft/planned/released) — every
 * order checked so far shows OrderStatus "RELEASED" even when fully
 * completed, so this confirms whether DRAFT/PLANNED are real values here
 * before any column labels get built around them.
 */
export async function debugSurveyProductionOrderStatuses(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey production order statuses)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyProductionOrderStatuses(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: Phase 1 of the planned Inventory Movement report — checks
 * whether GET /purchase?ID= actually returns StockReceived.Lines[] (real
 * received quantities/dates) as the community client spec suggests, before
 * building any sync/schema around it.
 */
export async function debugSurveyPurchaseDetailFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey purchase detail fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyPurchaseDetailFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: Phase 3.3b — does Cin7's `UpdatedSince` list-filter param
 * actually narrow /purchaseList, /finishedGoodsList, and
 * /production/orderList, or would trusting it silently drop rows? See
 * probeUpdatedSinceFiltering's own doc comment (src/cin7/debug.ts) for the
 * 2026-08-15 live findings this recorded against the Spark Demo instance —
 * re-run this against a real instance before ever extending the watermark
 * optimization already shipped for purchases to a new endpoint.
 */
export async function debugProbeUpdatedSinceFiltering(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (probe UpdatedSince filtering)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await probeUpdatedSinceFiltering(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Blocking Step 0 for the Stock Health report — /ref/productavailability has never been called live in this codebase; confirms the real list key/field names before any sync/schema is built around it. */
export async function debugSurveyProductAvailabilityFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey product availability fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyProductAvailabilityFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Blocking Step 0 for a Replenish rebuild — hunts for Cin7's "Product Supplier Options" model (Lead/Safety/ReorderQuantity/MinimumToReorder/SupplyIntervals per product+supplier+location, per a doc screenshot reviewed 2026-07-23) which has never been fetched by this codebase, confirming which endpoint/flag (if any) actually surfaces it before any reorder-logic rebuild is designed around it. */
export async function debugSurveyProductSupplierOptionsFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey product supplier options fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyProductSupplierOptionsFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Targeted follow-up to debugSurveyProductSupplierOptionsFields — fetches one exact SKU (a real confirmed-populated example, found via Cin7's own product-edit UI) under several Include flag combos and dumps the raw record so the right field/flag can be diffed out directly rather than relying on a blind bulk scan. */
export async function debugFindProductSupplierOptionsExample(instanceId: string, sku: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (find product supplier options example)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await findProductSupplierOptionsExample(creds, sku);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Checks whether Cin7 exposes a real MOQ ("Minimum to Order") field on ProductSupplierOptions distinct from MinimumToReorder (the reorder-trigger threshold, already parsed) — see checkProductSupplierOptionsForUnparsedFields' own comment. */
export async function debugCheckProductSupplierOptionsForUnparsedFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check product supplier options for unparsed fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await checkProductSupplierOptionsForUnparsedFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Blocking Step 0 for the Order Fulfillment Dashboard — confirms whether CombinedPickingStatus/CombinedPackingStatus/CombinedShippingStatus/CombinedPaymentStatus/Carrier/CombinedTrackingNumbers actually appear on /saleList, and whether GET /sale?ID= really returns Order.Lines[].BackorderQuantity + Fulfilments[].Pick/Pack/Ship as the community spec documents, before any schema/sync is built around them. */
export async function debugSurveySaleFulfillmentFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey sale fulfillment fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveySaleFulfillmentFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Blocking Step 0 for a possible "backorder ETA" feature — confirms whether GET /purchase (or /advanced-purchase)'s Order.Lines[] carries any per-line expected-date field, or whether the purchase-order-level RequiredBy (already synced) is the only ETA Cin7 exposes at all, before designing any schema/UI around it. */
export async function debugSurveyBackorderEtaFields(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (survey backorder ETA fields)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await surveyBackorderEtaFields(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only, blocking Step 0 for the shipping calendar's
 * drag-to-reschedule feature — a real write test (no-op: writes the sale's
 * own current ShipBy back unchanged) against ONE named order, not a blind
 * or bulk write. Pick a real, low-stakes test order (e.g. one of the
 * account's own dummy/test customers) rather than a live customer's order.
 */
export async function debugTestSaleShipByWriteBack(instanceId: string, orderNumber: string): Promise<TestConnectionResult> {
  let orgId: string | undefined;
  let actor: ActivityActor | undefined;
  try {
    await requirePrivilegedSuperAdmin("write-test a Cin7 sale's ShipBy field");
    const current = await requireCurrentOrg();
    orgId = current.orgId;
    actor = { userId: current.userId, email: current.email };
    const creds = await loadInstanceCreds(instanceId);
    const result = await testSaleShipByWriteBack(creds, orderNumber);
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "diagnostics.sale_shipby_writeback",
      outcome: "success",
      summary: `Diagnostic ShipBy write-back succeeded on order ${orderNumber}`,
      detail: { orderNumber },
    });
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    if (orgId && actor) {
      const ambiguous = e instanceof Cin7ApiError && e.ambiguous;
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "diagnostics.sale_shipby_writeback",
        outcome: ambiguous ? "ambiguous" : "failed",
        summary: `Diagnostic ShipBy write-back ${ambiguous ? "ambiguous (network failure — Cin7 may or may not have applied it)" : "failed"} on order ${orderNumber}`,
        detail: { orderNumber, error: e instanceof Error ? e.message : "Unknown error" },
      });
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: confirms whether a product's Suppliers array needs a
 * resolved SupplierID (not just SupplierName) to be accepted — see
 * testProductSupplierLink's own comment. `input` is "SKU,Supplier Name"
 * (the supplier name itself may contain commas were it not for the fact
 * every real one seen so far doesn't — split on the first comma only).
 */
export async function debugTestProductSupplierLink(instanceId: string, input: string): Promise<TestConnectionResult> {
  let orgId: string | undefined;
  let actor: ActivityActor | undefined;
  try {
    await requirePrivilegedSuperAdmin("write-test a Cin7 product's supplier link");
    const current = await requireCurrentOrg();
    orgId = current.orgId;
    actor = { userId: current.userId, email: current.email };
    const commaIndex = input.indexOf(",");
    if (commaIndex < 0) return { ok: false, message: 'Enter "SKU,Supplier Name", e.g. Cardboard80,Box Shop Packaging' };
    const sku = input.slice(0, commaIndex).trim();
    const supplierName = input.slice(commaIndex + 1).trim();
    if (!sku || !supplierName) return { ok: false, message: 'Enter "SKU,Supplier Name", e.g. Cardboard80,Box Shop Packaging' };

    const creds = await loadInstanceCreds(instanceId);
    const result = await testProductSupplierLink(creds, sku, supplierName);
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "diagnostics.product_supplier_link",
      outcome: "success",
      summary: `Diagnostic product/supplier link write succeeded (${sku} / ${supplierName})`,
      detail: { sku, supplierName },
    });
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    if (orgId && actor) {
      const ambiguous = e instanceof Cin7ApiError && e.ambiguous;
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "diagnostics.product_supplier_link",
        outcome: ambiguous ? "ambiguous" : "failed",
        summary: `Diagnostic product/supplier link write ${ambiguous ? "ambiguous (network failure — Cin7 may or may not have applied it)" : "failed"}`,
        detail: { input, error: e instanceof Error ? e.message : "Unknown error" },
      });
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only, and a genuine WRITE: creates a real (DRAFT-status) test
 * Purchase Order in Cin7 — see testCreatePurchaseOrder's own comment for why
 * this trial-and-error approach is needed (no confirmed POST /purchase
 * shape exists anywhere in this codebase). `input` is "SKU,Supplier
 * Name,Quantity,Location Name".
 */
export async function debugTestCreatePurchaseOrder(instanceId: string, input: string): Promise<TestConnectionResult> {
  let orgId: string | undefined;
  let actor: ActivityActor | undefined;
  try {
    await requirePrivilegedSuperAdmin("create a test Cin7 Purchase Order");
    const current = await requireCurrentOrg();
    orgId = current.orgId;
    actor = { userId: current.userId, email: current.email };
    const parts = input.split(",").map((p) => p.trim());
    if (parts.length !== 4 || parts.some((p) => !p)) {
      return { ok: false, message: 'Enter "SKU,Supplier Name,Quantity,Location Name", e.g. Cardboard80,Box Shop Packaging,1,Main Warehouse' };
    }
    const [sku, supplierName, quantityRaw, locationName] = parts;
    const quantity = Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, message: "Quantity must be a positive number" };

    const creds = await loadInstanceCreds(instanceId);
    const result = await testCreatePurchaseOrder(creds, sku, supplierName, quantity, locationName);
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "diagnostics.create_purchase_order",
      outcome: "success",
      summary: `Diagnostic test Purchase Order created (${sku} x${quantity} from ${supplierName})`,
      detail: { sku, supplierName, quantity, locationName },
    });
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    if (orgId && actor) {
      // Security re-audit closure, Blocker 3: this diagnostic tool has no
      // reconciliation mechanism (a pre-existing, documented residual risk —
      // see the security closure matrix's Hardening H3) — an ambiguous
      // outcome here means Cin7 may genuinely have created a real DRAFT PO
      // even though this call reports failure. Logging the ambiguity
      // honestly (rather than as a flat "failed") is this pass's own
      // required fix — it does not add reconciliation itself.
      const ambiguous = e instanceof Cin7ApiError && e.ambiguous;
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "diagnostics.create_purchase_order",
        outcome: ambiguous ? "ambiguous" : "failed",
        summary: `Diagnostic test Purchase Order ${ambiguous ? "ambiguous (network failure — Cin7 may have created it anyway, no reconciliation exists for this diagnostic tool)" : "failed"}`,
        detail: { input, error: e instanceof Error ? e.message : "Unknown error" },
      });
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: pushes just ONE customer and ONE supplier (not the whole
 * catalog) to confirm the new push client's payload shape actually works
 * live, before trusting it on the full "Push to instances" flow — that
 * button syncs every product/customer/supplier in one HTTP request, which
 * with 175+ customer/supplier rows now in the hub would very likely exceed
 * Vercel's 60s function timeout before we even learned whether the payload
 * shape was right.
 */
export async function debugPushOneCustomerAndSupplier(instanceId: string): Promise<TestConnectionResult> {
  let orgId: string | undefined;
  let actor: ActivityActor | undefined;
  try {
    await requirePrivilegedSuperAdmin("push a test customer/supplier to Cin7");
    const current = await requireCurrentOrg();
    orgId = current.orgId;
    actor = { userId: current.userId, email: current.email };
    const db = createServiceRoleClient();
    const creds = await loadInstanceCreds(instanceId);

    const { data: customer, error: customerError } = await db
      .from("customers")
      .select("*")
      .eq("org_id", orgId)
      .order("name")
      .limit(1)
      .maybeSingle();
    if (customerError) throw new Error(`customers: ${customerError.message}`);

    const { data: supplier, error: supplierError } = await db
      .from("suppliers")
      .select("*")
      .eq("org_id", orgId)
      .order("name")
      .limit(1)
      .maybeSingle();
    if (supplierError) throw new Error(`suppliers: ${supplierError.message}`);

    const result: Record<string, unknown> = {};
    // Security re-audit closure, Blocker 3: per-entity outcome tracked
    // separately (rather than one flat "did this call throw") so the audit
    // record can distinguish "no customer/supplier imported yet" from a
    // genuine failure, and a genuine failure from an ambiguous one.
    let customerOutcome: "success" | "failed" | "ambiguous" | "skipped" = "skipped";
    let supplierOutcome: "success" | "failed" | "ambiguous" | "skipped" = "skipped";

    if (customer) {
      const { data: addresses } = await db
        .from("customer_addresses")
        .select("address_type, address_default_for_type, address_line_1, address_line_2, city, state, postcode, country")
        .eq("org_id", orgId)
        .eq("name", customer.name);
      const { data: contacts } = await db
        .from("customer_contacts")
        .select("contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email")
        .eq("org_id", orgId)
        .eq("name", customer.name);
      try {
        const pushResult = await pushCustomer(
          creds,
          customer,
          (addresses ?? []) as CanonicalCustomerAddressRow[],
          (contacts ?? []) as CanonicalCustomerContactRow[]
        );
        result.customer = { name: customer.name, ...pushResult };
        customerOutcome = "success";
      } catch (e) {
        result.customer = { name: customer.name, error: e instanceof Error ? e.message : "Unknown error" };
        customerOutcome = e instanceof Cin7ApiError && e.ambiguous ? "ambiguous" : "failed";
      }
    } else {
      result.customer = "No customers imported yet.";
    }

    if (supplier) {
      const { data: addresses } = await db
        .from("supplier_addresses")
        .select("address_type, address_default_for_type, address_line_1, address_line_2, city, state, postcode, country")
        .eq("org_id", orgId)
        .eq("name", supplier.name);
      const { data: contacts } = await db
        .from("supplier_contacts")
        .select("contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email")
        .eq("org_id", orgId)
        .eq("name", supplier.name);
      try {
        const pushResult = await pushSupplier(
          creds,
          supplier,
          (addresses ?? []) as CanonicalSupplierAddressRow[],
          (contacts ?? []) as CanonicalSupplierContactRow[]
        );
        result.supplier = { name: supplier.name, ...pushResult };
        supplierOutcome = "success";
      } catch (e) {
        result.supplier = { name: supplier.name, error: e instanceof Error ? e.message : "Unknown error" };
        supplierOutcome = e instanceof Cin7ApiError && e.ambiguous ? "ambiguous" : "failed";
      }
    } else {
      result.supplier = "No suppliers imported yet.";
    }

    const overallOutcome = [customerOutcome, supplierOutcome].includes("ambiguous")
      ? "ambiguous"
      : [customerOutcome, supplierOutcome].includes("failed")
        ? "failed"
        : "success";
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "diagnostics.push_customer_supplier",
      outcome: overallOutcome,
      summary: `Diagnostic test push — customer: ${customerOutcome}, supplier: ${supplierOutcome}`,
      detail: { customerName: customer?.name ?? null, supplierName: supplier?.name ?? null, customerOutcome, supplierOutcome },
    });

    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    if (orgId && actor) {
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "diagnostics.push_customer_supplier",
        outcome: "failed",
        summary: "Diagnostic test push failed before either entity was attempted",
        detail: { error: e instanceof Error ? e.message : "Unknown error" },
      });
    }
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: checks a named customer's Location/SalesRepresentative/
 * AccountReceivable/SaleAccount/TaxRule/PriceTier against this instance's
 * actual reference books, one call per field, and reports exists/missing
 * for each — built to pin down a vague "Account with specified ID not
 * found" push error once the regular pre-flight check (which covers the
 * first four of these) had already passed.
 */
export async function debugCheckCustomerReferenceFields(instanceId: string, customerName: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check customer reference fields)");
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadInstanceCreds(instanceId);

    const { data: customer, error } = await db
      .from("customers")
      .select("name, location, sales_representative, account_receivable, sale_account, tax_rule, price_tier, payment_term")
      .eq("org_id", orgId)
      .eq("name", customerName)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!customer) return { ok: false, message: `No customer named "${customerName}" found.` };

    const results = await checkCustomerReferenceFields(creds, customer);
    return { ok: true, message: JSON.stringify({ customer: customer.name, results }, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Supplier equivalent of debugCheckCustomerReferenceFields — same reasoning, AccountPayable/TaxRule/PaymentTerm only (no Location/SalesRepresentative/PriceTier on suppliers). */
export async function debugCheckSupplierReferenceFields(instanceId: string, supplierName: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check supplier reference fields)");
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadInstanceCreds(instanceId);

    const { data: supplier, error } = await db
      .from("suppliers")
      .select("name, account_payable, tax_rule, payment_term")
      .eq("org_id", orgId)
      .eq("name", supplierName)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!supplier) return { ok: false, message: `No supplier named "${supplierName}" found.` };

    const results = await checkSupplierReferenceFields(creds, supplier);
    return { ok: true, message: JSON.stringify({ supplier: supplier.name, results }, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: fetches a named customer's raw, current record directly
 * from Cin7 — built to check whether a push actually cleared a field (e.g.
 * DisplayName/AttributeSet showing a stale value) rather than trusting what
 * our own payload *sent*. If Cin7 still shows a value after we sent "" for
 * it, that's Cin7 ignoring/not-clearing on empty string, not a bug in what
 * we transmitted.
 */
export async function debugFetchCustomerByName(instanceId: string, customerName: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (fetch customer by name)");
    const creds = await loadInstanceCreds(instanceId);
    const record = await findCustomerRawByName(creds, customerName);
    if (!record) return { ok: false, message: `No customer named "${customerName}" found in Cin7.` };
    return { ok: true, message: JSON.stringify(record, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: fetches the full Chart-of-Accounts record for each of a
 * comma-separated list of codes and returns them side by side — built to
 * find the real distinguishing field between an account code that works for
 * AccountPayable/AccountReceivable and one that exists but is still rejected
 * by the real push (Cin7's own docs: "only special account [payable/
 * receivable] accounts are valid").
 */
export async function debugCompareAccounts(instanceId: string, codesInput: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (compare accounts)");
    const creds = await loadInstanceCreds(instanceId);
    const codes = codesInput
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!codes.length) return { ok: false, message: "Enter one or more comma-separated account codes." };

    const results = await findAccountsByCodes(creds, codes);
    return { ok: true, message: JSON.stringify(results, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: the sales sync filters /saleList to
 * CombinedInvoiceStatus=AUTHORISED, but a live sync returned zero sales
 * against an instance that clearly has invoices. Fetches /saleList with no
 * status filter and tallies real CombinedInvoiceStatus values, to confirm
 * (rather than guess) whether AUTHORISED is too narrow.
 */
export async function debugCheckSaleStatuses(instanceId: string): Promise<TestConnectionResult> {
  try {
    await requirePrivilegedSuperAdmin("run Cin7 diagnostics (check sale statuses)");
    const creds = await loadInstanceCreds(instanceId);
    const result = await checkSaleStatuses(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteInstance(instanceId: string): Promise<ActionResult> {
  try {
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — deletes credentials.
    const { orgId, userId, email } = await requirePrivilegedOrgAdmin("delete Cin7 instances");
    const db = createServiceRoleClient();
    const actor: ActivityActor = { userId, email };
    const { error } = await db.from("cin7_instances").delete().eq("id", instanceId).eq("org_id", orgId);
    if (error) {
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "instance.delete",
        outcome: "failed",
        summary: `Failed to delete Cin7 instance ${instanceId}`,
        detail: { error: error.message },
      });
      return { ok: false, error: error.message };
    }
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "instance.delete",
      outcome: "success",
      summary: `Deleted Cin7 instance ${instanceId}`,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}
