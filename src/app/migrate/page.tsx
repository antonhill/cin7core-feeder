"use client";

import { useEffect, useState, useTransition } from "react";
import { pullInstanceDataAction } from "./actions";
import { pushToCin7Action, type PushScopeSelection } from "@/app/import/actions";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { getBillingStatusAction } from "@/actions/billing";
import type { InstanceSyncOutcome } from "@/sync/sync-org";
import { Spinner } from "@/app/Spinner";
import type { PullInstanceResult } from "@/migrate/pull-instance";
import type { ImportKind } from "@/import/run-import";
import { ModuleHeader } from "@/app/ModuleHeader";
import { MIGRATE_MODULE } from "@/app/module-nav";

const KIND_LABELS: Record<string, string> = {
  products: "Products",
  assembly_bom: "Assembly BOM",
  customers: "Customers",
  customer_addresses: "Customer Addresses",
  suppliers: "Suppliers",
  supplier_addresses: "Supplier Addresses",
};
const KIND_ORDER: ImportKind[] = ["products", "assembly_bom", "customers", "customer_addresses", "suppliers", "supplier_addresses"];

// Only the products/customers/suppliers scopes exist — BOM/address kinds
// follow their parent, same rule the Import page's isolatedScopeFor uses.
const PUSH_PULLED_SCOPE: PushScopeSelection = { products: "last_import", customers: "last_import", suppliers: "last_import" };

function StepHeader({ step, title, done }: { step: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
          done ? "bg-indigo-600 text-white" : "bg-slate-200 text-slate-600"
        }`}
      >
        {step}
      </span>
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
    </div>
  );
}

function StatPill({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "bad" }) {
  if (!value) return null;
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-medium ${
        tone === "bad" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"
      }`}
    >
      {value} {label}
    </span>
  );
}

export default function MigratePage() {
  const picker = useInstancePicker();
  const sourceId = picker.instanceId;
  const setSourceId = picker.setInstanceId;

  const [pullResult, setPullResult] = useState<PullInstanceResult | null>(null);
  const [isPullPending, startPullTransition] = useTransition();

  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [pushOutcomes, setPushOutcomes] = useState<InstanceSyncOutcome[] | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [isPushPending, startPushTransition] = useTransition();

  // Optimistic default (true) so the button isn't disabled during the brief
  // window before this resolves — same convention as /import.
  const [canWrite, setCanWrite] = useState(true);
  const [, startBillingTransition] = useTransition();
  useEffect(() => {
    startBillingTransition(async () => {
      const res = await getBillingStatusAction();
      if (res.ok && res.data) setCanWrite(res.data.canWrite);
    });
  }, []);

  function handlePull() {
    if (!sourceId) return;
    setPullResult(null);
    setPushOutcomes(null);
    setTargetIds((prev) => prev.filter((id) => id !== sourceId));
    startPullTransition(async () => {
      setPullResult(await pullInstanceDataAction(sourceId));
    });
  }

  function toggleTarget(id: string) {
    setTargetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handlePush() {
    setPushError(null);
    setPushOutcomes(null);
    startPushTransition(async () => {
      const result = await pushToCin7Action(targetIds, PUSH_PULLED_SCOPE);
      if (!result.ok) {
        setPushError(result.error ?? "Unknown error");
        return;
      }
      setPushOutcomes(result.outcomes ?? []);
    });
  }

  const targetChoices = picker.selectableInstances.filter((i) => i.id !== sourceId);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={MIGRATE_MODULE}>
        Pull every Product, Assembly BOM, Customer, and Supplier live from one connected instance,
        then push the pulled data into another.
      </ModuleHeader>

      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Pulling overwrites the org&apos;s canonical data for any product SKU or customer/supplier
        Name that also exists in the source instance — canonical data isn&apos;t scoped to a
        single instance. Only use this when you want the source instance to become the org&apos;s
        source of truth.
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <StepHeader step={1} title="Pull from a source instance" done={pullResult?.ok === true} />

          <div className="mt-5 pl-11">
            <InstancePicker {...picker} onChange={setSourceId} />

            <button
              type="button"
              onClick={handlePull}
              disabled={isPullPending || !sourceId}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isPullPending && <Spinner className="mr-1.5" />}
              {isPullPending ? "Pulling…" : "Pull all data"}
            </button>

            {pullResult && !pullResult.ok && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {pullResult.error}
              </p>
            )}

            {pullResult?.ok && pullResult.results && (
              <div className="mt-4 flex flex-col gap-3">
                {KIND_ORDER.map((kind) => {
                  const result = pullResult.results?.[kind];
                  if (!result) return null;
                  const committedCount = result.rowCount - result.errorCount;
                  return (
                    <div key={kind} className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="font-medium text-emerald-900">
                        {KIND_LABELS[kind]}: {result.committed ? `${committedCount} row${committedCount === 1 ? "" : "s"} pulled` : "nothing to commit"}
                        {result.errorCount > 0 && ` — ${result.errorCount} invalid`}
                      </p>
                      {result.invalidRows.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm font-medium text-red-800">
                            {result.invalidRows.length} invalid row{result.invalidRows.length === 1 ? "" : "s"} — details
                          </summary>
                          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-red-700">
                            {result.invalidRows.map((r) => (
                              <li key={r.rowNumber}>
                                <span className="font-medium">Row {r.rowNumber}:</span> {r.errors.join("; ")}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {result.warnings.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm font-medium text-amber-800">
                            {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}
                          </summary>
                          <ul className="mt-2 list-disc pl-5 text-sm text-amber-700">
                            {result.warnings.map((w, i) => (
                              <li key={i}>
                                Row {w.rowNumber}: {w.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <StepHeader step={2} title="Push into another instance" done={pushOutcomes !== null} />
          <p className="mt-1 pl-11 text-base text-slate-500">
            Pushes only what was just pulled (scoped to the most recent import of each kind), not
            the org&apos;s whole catalog. The source instance is excluded here to avoid pushing
            data straight back to where it came from.
          </p>

          <div className="mt-5 pl-11">
            {targetChoices.length === 0 && (
              <p className="text-sm text-slate-400">Load instances above and pick a source first.</p>
            )}
            {targetChoices.length > 0 && (
              <div className="flex flex-col gap-2">
                {targetChoices.map((inst) => (
                  <label key={inst.id} className="flex items-center gap-2 text-base">
                    <input
                      type="checkbox"
                      checked={targetIds.includes(inst.id)}
                      onChange={() => toggleTarget(inst.id)}
                      className="h-4 w-4"
                    />
                    {inst.name}
                  </label>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={handlePush}
              disabled={isPushPending || targetIds.length === 0 || !pullResult?.ok || !canWrite}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isPushPending && <Spinner className="mr-1.5" />}
              {isPushPending ? "Pushing…" : `Push to ${targetIds.length || ""} instance${targetIds.length === 1 ? "" : "s"}`}
            </button>
            {!canWrite && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Available on a paid plan — this trial is read-only.
              </p>
            )}

            {pushError && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {pushError}
              </p>
            )}

            {pushOutcomes && (
              <div className="mt-4 flex flex-col gap-3">
                {pushOutcomes.map((outcome) => (
                  <div
                    key={outcome.instanceId}
                    className={`rounded-xl border p-4 ${outcome.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}
                  >
                    <p className={`font-medium ${outcome.ok ? "text-emerald-900" : "text-red-900"}`}>
                      {outcome.instanceName ?? outcome.instanceId}
                    </p>
                    {!outcome.ok && <p className="mt-1 text-sm text-red-700">{outcome.error}</p>}
                    {outcome.ok && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatPill label="products created" value={outcome.productsCreated ?? 0} />
                        <StatPill label="products updated" value={outcome.productsUpdated ?? 0} />
                        <StatPill label="products failed" value={outcome.productsFailed ?? 0} tone="bad" />
                        <StatPill label="customers created" value={outcome.customersCreated ?? 0} />
                        <StatPill label="customers updated" value={outcome.customersUpdated ?? 0} />
                        <StatPill label="customers failed" value={outcome.customersFailed ?? 0} tone="bad" />
                        <StatPill label="suppliers created" value={outcome.suppliersCreated ?? 0} />
                        <StatPill label="suppliers updated" value={outcome.suppliersUpdated ?? 0} />
                        <StatPill label="suppliers failed" value={outcome.suppliersFailed ?? 0} tone="bad" />
                      </div>
                    )}
                    {outcome.ok && outcome.errors && outcome.errors.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-red-900">
                          {outcome.errors.length} error{outcome.errors.length === 1 ? "" : "s"} — details
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1.5 text-sm text-red-700">
                          {outcome.errors.map((e, i) => (
                            <li key={i}>
                              <span className="font-medium">{e.sku}:</span>
                              <ul className="list-disc pl-5">
                                {e.error.map((line, j) => (
                                  <li key={j}>{line}</li>
                                ))}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
