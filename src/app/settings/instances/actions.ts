"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { encrypt, decrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { findProductWithBom, probeWorkCentrePaths, findCustomerAndSupplierExamples, checkCustomerReferenceFields, findCustomerRawByName } from "@/cin7/debug";
import { pushCustomer, type CanonicalCustomerAddressRow, type CanonicalCustomerContactRow } from "@/cin7/customers";
import { pushSupplier, type CanonicalSupplierAddressRow, type CanonicalSupplierContactRow } from "@/cin7/suppliers";
import { requireCurrentOrg } from "@/lib/current-org";

export interface InstanceRecord {
  id: string;
  name: string;
  accountId: string;
  baseUrl: string;
  active: boolean;
  keyLast4: string;
  createdAt: string;
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
  base_url: string;
  active: boolean;
  created_at: string;
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
    baseUrl: row.base_url,
    active: row.active,
    keyLast4,
    createdAt: row.created_at,
  };
}

export async function listInstances(): Promise<ActionResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("cin7_instances")
      .select("id, name, account_id, application_key_encrypted, base_url, active, created_at")
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
  baseUrl: string;
  active: boolean;
}): Promise<ActionResult> {
  if (!params.name.trim()) return { ok: false, error: "Name is required." };
  if (!params.accountId.trim()) return { ok: false, error: "Account ID is required." };
  if (!params.instanceId && !params.applicationKey) {
    return { ok: false, error: "Application key is required for a new instance." };
  }

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    if (params.instanceId) {
      const update: Record<string, unknown> = {
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        base_url: params.baseUrl.trim(),
        active: params.active,
        updated_at: new Date().toISOString(),
      };
      if (params.applicationKey) update.application_key_encrypted = encrypt(params.applicationKey);

      const { error } = await db
        .from("cin7_instances")
        .update(update)
        .eq("id", params.instanceId)
        .eq("org_id", orgId);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await db.from("cin7_instances").insert({
        org_id: orgId,
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        application_key_encrypted: encrypt(params.applicationKey!),
        base_url: params.baseUrl.trim() || "https://inventory.dearsystems.com/ExternalApi/v2",
        active: params.active,
      });
      if (error) return { ok: false, error: error.message };
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
  const { orgId } = await requireCurrentOrg();
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("cin7_instances")
    .select("account_id, application_key_encrypted, base_url")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Instance not found.");
  return {
    accountId: data.account_id,
    applicationKey: decrypt(data.application_key_encrypted),
    baseUrl: data.base_url,
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
    const creds = await loadInstanceCreds(instanceId);
    const result = await findCustomerAndSupplierExamples(creds);
    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
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
  try {
    const { orgId } = await requireCurrentOrg();
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
      } catch (e) {
        result.customer = { name: customer.name, error: e instanceof Error ? e.message : "Unknown error" };
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
      } catch (e) {
        result.supplier = { name: supplier.name, error: e instanceof Error ? e.message : "Unknown error" };
      }
    } else {
      result.supplier = "No suppliers imported yet.";
    }

    return { ok: true, message: JSON.stringify(result, null, 2) };
  } catch (e) {
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
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadInstanceCreds(instanceId);

    const { data: customer, error } = await db
      .from("customers")
      .select("name, location, sales_representative, account_receivable, sale_account, tax_rule, price_tier")
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
    const creds = await loadInstanceCreds(instanceId);
    const record = await findCustomerRawByName(creds, customerName);
    if (!record) return { ok: false, message: `No customer named "${customerName}" found in Cin7.` };
    return { ok: true, message: JSON.stringify(record, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteInstance(instanceId: string): Promise<ActionResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { error } = await db.from("cin7_instances").delete().eq("id", instanceId).eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}
