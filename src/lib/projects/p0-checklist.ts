// P0 - READ-ONLY acceptance prerequisites (docs/projects-poc/cin7-acceptance-proof-plan.md). Pure orchestration over an injected read-only port:
// it performs only GETs, writes nothing anywhere, and NEVER substitutes anything. If the environment, the Cin7 instance, the customer or a
// SKU is not exactly what was asked for, that check FAILS with the facts; it does not pick an alternative customer, instance or database.
// Later checks that depend on a failed one are reported NOT_RUN (with the reason), not guessed.
import { supabaseWiring } from "./write-flag";

export type P0Status = "PASS" | "FAIL" | "MANUAL" | "NOT_RUN";
export interface P0Check { id: string; label: string; status: P0Status; detail: string }
export interface P0Report {
  checks: P0Check[];
  /** NOT_READY if any check failed or did not run; READY_PENDING_MANUAL when every automated check passed (manual items always remain). */
  verdict: "NOT_READY" | "READY_PENDING_MANUAL";
  counts: Record<P0Status, number>;
}

export interface P0SkuInput { sku: string; quantity: number; expectAssembly?: boolean }
export interface P0Input {
  customerName: string;
  location: string;
  taxRule: string;
  revenueAccount: string;
  skus: P0SkuInput[];
  /** The ExternalID the Sale would carry (NEWQUIP-PROJECTS-SALE:<project ref>); checked for pre-existence. */
  externalId: string;
}

/** The read-only Cin7 reads P0 needs. Structurally a subset of SaleCreationPort. */
export interface P0Port {
  customerExists(name: string): Promise<boolean>;
  customerDefaults(name: string): Promise<{ taxRule: string | null; revenueAccount: string | null; location: string | null } | null>;
  resolveProducts(skus: string[]): Promise<{ ids: Map<string, string>; missing: string[] }>;
  assemblySkus(skus: string[]): Promise<string[]>;
  stockAt(sku: string): Promise<Array<{ location: string | null; available: number | null }>>;
  findByExternalId(customer: string, externalId: string, sinceIso: string): Promise<Array<{ saleId: string; saleNumber: string | null }>>;
}

export interface P0Deps {
  env: Record<string, string | undefined>;
  /** ALL active Cin7 instances of the organisation, as found (never filtered or chosen by the caller). */
  instances: Array<{ id: string; name: string }>;
  expectedInstanceId: string;
  denylist: readonly string[];
  portFor: (instanceId: string) => P0Port;
  now?: Date;
}

const c = (id: string, label: string, status: P0Status, detail: string): P0Check => ({ id, label, status, detail });
const sameName = (a: string, b: string) => a === b;

export async function runP0(deps: P0Deps, input: P0Input): Promise<P0Report> {
  const checks: P0Check[] = [];
  const add = (x: P0Check) => { checks.push(x); return x; };

  // ── environment ──
  const deployment = deps.env.VERCEL_ENV ?? "local";
  add(c("ENV_NOT_PRODUCTION", "Not running on Production", deployment === "production" ? "FAIL" : "PASS", deployment === "production" ? "P0 must be run on the integration Preview, not Production." : `Deployment: ${deployment}.`));
  const flagOn = deps.env.NEWQUIP_CIN7_WRITES_ENABLED === "true";
  add(c("ENV_WRITE_FLAG_OFF", "Cin7 write flag is OFF", flagOn ? "FAIL" : "PASS", flagOn ? "NEWQUIP_CIN7_WRITES_ENABLED is \"true\" here. P0 is read-only and requires it OFF; unset it for this branch." : "Writes are off."));
  const wiring = supabaseWiring(deps.env);
  add(c("ENV_SUPABASE_PROJECT", "Supabase project is the required one", wiring.ok ? "PASS" : "FAIL", wiring.ok ? `Both URLs point at the required project (${wiring.serverRef}).` : `${wiring.detail}. Add branch-scoped Vercel overrides for this branch pointing at the required project; nothing was substituted.`));

  // ── Cin7 instance: exactly the expected one, found as the org's only active instance ──
  let instanceOk = false;
  if (deps.instances.length === 0) add(c("CIN7_INSTANCE", "Cin7 instance is the NewQuip POC instance", "FAIL", "This organisation has no active Cin7 instance."));
  else if (deps.instances.length > 1) add(c("CIN7_INSTANCE", "Cin7 instance is the NewQuip POC instance", "FAIL", `This organisation has ${deps.instances.length} active Cin7 instances (${deps.instances.map((i) => i.name).join(", ")}); P0 will not choose one. Deactivate the others or run P0 only where exactly one is active.`));
  else if (deps.instances[0].id !== deps.expectedInstanceId) add(c("CIN7_INSTANCE", "Cin7 instance is the NewQuip POC instance", "FAIL", `The only active instance is "${deps.instances[0].name}" (${deps.instances[0].id}), not the expected NewQuip POC instance (${deps.expectedInstanceId}).`));
  else { instanceOk = true; add(c("CIN7_INSTANCE", "Cin7 instance is the NewQuip POC instance", "PASS", `"${deps.instances[0].name}" (${deps.instances[0].id}).`)); }

  const blocked = !instanceOk || !wiring.ok || deployment === "production";
  const skip = (id: string, label: string) => add(c(id, label, "NOT_RUN", "Not run: the environment or Cin7 instance check above failed. Nothing was read from Cin7."));

  // ── inputs sanity (no Cin7 needed) ──
  const name = input.customerName.trim();
  const denied = deps.denylist.find((d) => name.toUpperCase().includes(d.toUpperCase()));
  add(c("CUSTOMER_NOT_OPERATIONAL", "Customer is not an operational customer", !name ? "FAIL" : denied ? "FAIL" : "PASS", !name ? "No customer name entered." : denied ? `"${name}" matches the operational customer "${denied}". A dedicated disposable customer is required.` : `"${name}" does not match ${deps.denylist.join(", ")}.`));
  const seen = new Set<string>();
  const dup = input.skus.find((s) => (seen.has(s.sku) ? true : (seen.add(s.sku), false)));
  const badQty = input.skus.find((s) => !s.sku.trim() || !Number.isFinite(s.quantity) || s.quantity <= 0);
  add(c("INPUT_SKUS", "SKU list is valid", input.skus.length === 0 ? "FAIL" : dup ? "FAIL" : badQty ? "FAIL" : "PASS",
    input.skus.length === 0 ? "No SKUs entered." : dup ? `SKU ${dup.sku} is listed twice.` : badQty ? `SKU "${badQty.sku}" needs a positive quantity.` : `${input.skus.length} SKU(s).`));

  if (blocked || !name) {
    for (const [id, label] of [["CUSTOMER_EXISTS", "Customer exists in Cin7 (exact name)"], ["CUSTOMER_DEFAULTS", "Customer defaults match the tax rule, account and location"], ["SKUS_EXIST", "Every SKU exists in Cin7"], ["SKU_ASSEMBLY", "Assembly configuration is as expected"], ["STOCK_AVAILABLE", "Stock is available at the location"], ["NO_EXISTING_SALE", "No Sale already carries the proof's ExternalID"]] as const) skip(id, label);
  } else {
    const port = deps.portFor(deps.instances[0].id);
    const exists = await port.customerExists(name);
    add(c("CUSTOMER_EXISTS", "Customer exists in Cin7 (exact name)", exists ? "PASS" : "FAIL", exists ? `"${name}" exists.` : `No customer named exactly "${name}" exists. Toolbox never creates customers and never picks a similar one: create it in Cin7 or correct the name.`));
    if (!exists) {
      for (const [id, label] of [["CUSTOMER_DEFAULTS", "Customer defaults match the tax rule, account and location"]] as const) add(c(id, label, "NOT_RUN", "Not run: the customer does not exist."));
    } else {
      const d = await port.customerDefaults(name);
      if (!d) add(c("CUSTOMER_DEFAULTS", "Customer defaults match the tax rule, account and location", "FAIL", "The customer's defaults could not be read."));
      else {
        const problems: string[] = [];
        if (!d.taxRule || !sameName(d.taxRule, input.taxRule)) problems.push(`tax rule is ${d.taxRule ? `"${d.taxRule}"` : "not set"}, expected "${input.taxRule}"`);
        if (!d.revenueAccount || d.revenueAccount !== input.revenueAccount) problems.push(`revenue account is ${d.revenueAccount ? `"${d.revenueAccount}"` : "not set"}, expected "${input.revenueAccount}"`);
        if (d.location && d.location !== input.location) problems.push(`default location is "${d.location}", expected "${input.location}"`);
        add(c("CUSTOMER_DEFAULTS", "Customer defaults match the tax rule, account and location", problems.length ? "FAIL" : "PASS", problems.length ? `The customer's ${problems.join("; ")}.` : `Tax rule "${d.taxRule}", revenue account "${d.revenueAccount}"${d.location ? `, default location "${d.location}"` : ""} match.`));
      }
    }

    const skus = input.skus.map((s) => s.sku.trim()).filter(Boolean);
    const res = skus.length ? await port.resolveProducts([...new Set(skus)]) : { ids: new Map<string, string>(), missing: [] as string[] };
    add(c("SKUS_EXIST", "Every SKU exists in Cin7", res.missing.length ? "FAIL" : skus.length ? "PASS" : "FAIL", res.missing.length ? `Missing from Cin7: ${res.missing.join(", ")}.` : skus.length ? `${res.ids.size} SKU(s) found by exact match.` : "No SKUs."));
    const present = skus.filter((s) => res.ids.has(s));
    const asm = new Set(present.length ? await port.assemblySkus(present) : []);
    const asmProblems = input.skus.filter((s) => res.ids.has(s.sku) && s.expectAssembly !== undefined && s.expectAssembly !== asm.has(s.sku)).map((s) => `${s.sku} is ${asm.has(s.sku) ? "an assembly" : "not an assembly"} but ${s.expectAssembly ? "an assembly" : "a plain product"} was expected`);
    add(c("SKU_ASSEMBLY", "Assembly configuration is as expected", asmProblems.length ? "FAIL" : "PASS", asmProblems.length ? `${asmProblems.join("; ")}.` : `Assemblies: ${[...asm].join(", ") || "none"}; BOM components are verified by hand.`));

    const stockProblems: string[] = [];
    for (const s of input.skus.filter((x) => res.ids.has(x.sku))) {
      const rows = (await port.stockAt(s.sku)).filter((r) => r.location === input.location);
      const avail = rows.length === 0 ? null : rows.reduce<number | null>((n, r) => (n === null || r.available === null ? null : n + r.available), 0);
      if (rows.length === 0) stockProblems.push(`${s.sku}: no stock row at "${input.location}"`);
      else if (avail === null) stockProblems.push(`${s.sku}: availability unreadable at "${input.location}"`);
      else if (avail < s.quantity) stockProblems.push(`${s.sku}: ${avail} available at "${input.location}", ${s.quantity} needed`);
    }
    add(c("STOCK_AVAILABLE", "Stock is available at the location", stockProblems.length ? "FAIL" : res.missing.length ? "NOT_RUN" : "PASS", stockProblems.length ? `${stockProblems.join("; ")}.` : res.missing.length ? "Not run for missing SKUs." : `Enough free stock at "${input.location}" for every quantity.`));

    const since = new Date((deps.now ?? new Date()).getTime() - 30 * 86_400_000).toISOString();
    const found = exists ? await port.findByExternalId(name, input.externalId, since) : [];
    add(c("NO_EXISTING_SALE", "No Sale already carries the proof's ExternalID", exists ? (found.length ? "FAIL" : "PASS") : "NOT_RUN", exists ? (found.length ? `Sale ${found.map((f) => f.saleNumber ?? f.saleId).join(", ")} already carries ${input.externalId}. Creation would be a duplicate.` : `None found in the last 30 days of this customer's Sales.`) : "Not run: the customer does not exist."));
  }

  // ── things Toolbox cannot read: the owner confirms them ──
  for (const [id, label, detail] of [
    ["MANUAL_CUSTOMER_DISPOSABLE", "Customer is dedicated and disposable", "Confirm in Cin7: created for this proof, no real orders, not shared with any operational account."],
    ["MANUAL_MOVEMENT_HISTORY", "Test SKU movement history reviewed", "Confirm in Cin7: the stock to be allocated/shipped is verified disposable (movement history checked)."],
    ["MANUAL_TAX_RULE_RATE", "Tax rule exists with the expected rate", `Confirm "${input.taxRule}" is the intended 15% sales rule in Cin7.`],
    ["MANUAL_REVENUE_ACCOUNT", "Revenue account exists in the chart of accounts", `Confirm account "${input.revenueAccount}" exists and is the intended revenue account.`],
    ["MANUAL_BOM", "Assembly BOM components and costing method", "Confirm the BOM components and FIFO costing in Cin7 (the check above reads only the assembly flag)."],
    ["MANUAL_DEFAULT_ADVANCED", "\"Default Load Advanced Sales Order\" setting (D15)", "Record whether it is on; creation does not depend on it but the answer is evidence."],
  ] as const) add(c(id, label, "MANUAL", detail));

  const counts: Record<P0Status, number> = { PASS: 0, FAIL: 0, MANUAL: 0, NOT_RUN: 0 };
  for (const k of checks) counts[k.status]++;
  return { checks, counts, verdict: counts.FAIL === 0 && counts.NOT_RUN === 0 ? "READY_PENDING_MANUAL" : "NOT_READY" };
}
