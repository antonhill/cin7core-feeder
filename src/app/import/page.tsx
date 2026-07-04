"use client";

import { useActionState, useState, useTransition } from "react";
import { importCsvAction, pushToCin7Action, type ImportActionState } from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { InstanceSyncOutcome } from "@/sync/sync-org";

const INITIAL_STATE: ImportActionState = { status: "idle" };

const KINDS = [
  { value: "products", label: "Products (InventoryList)" },
  { value: "assembly_bom", label: "Assembly BOM" },
  { value: "production_bom", label: "Production BOM" },
  { value: "suppliers", label: "Suppliers" },
  { value: "supplier_addresses", label: "Supplier Addresses" },
  { value: "customers", label: "Customers" },
  { value: "customer_addresses", label: "Customer Addresses" },
];

/** camelCase commit-summary key -> readable label, e.g. "productsUpserted" -> "Products upserted". */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

export default function ImportPage() {
  const [state, formAction, isImportPending] = useActionState(importCsvAction, INITIAL_STATE);

  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoadingInstances, startLoadTransition] = useTransition();

  const [pushOutcomes, setPushOutcomes] = useState<InstanceSyncOutcome[] | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [isPushPending, startPushTransition] = useTransition();

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const result = await listInstancesForPicker();
      if (!result.ok) {
        setInstancesError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
    });
  }

  function toggleInstance(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handlePush() {
    setPushError(null);
    setPushOutcomes(null);
    startPushTransition(async () => {
      const result = await pushToCin7Action(selectedIds);
      if (!result.ok) {
        setPushError(result.error ?? "Unknown error");
        return;
      }
      setPushOutcomes(result.outcomes ?? []);
    });
  }

  const activeInstances = instances.filter((i) => i.active);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Import &amp; Sync</h1>
      <p className="mt-2 text-lg text-slate-500">
        Import a CSV, choose where it goes, then push it to Cin7 Core.
      </p>

      <div className="mt-10 flex flex-col gap-6">
        {/* Step 1 — Import */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <StepHeader step={1} title="Import a CSV" done={state.status === "success"} />

          <form action={formAction} className="mt-5 flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-base">
                <span className="font-medium text-slate-700">Import type</span>
                <select
                  name="kind"
                  required
                  className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5 text-base">
                <span className="font-medium text-slate-700">CSV file</span>
                <input
                  name="file"
                  type="file"
                  accept=".csv,text/csv"
                  required
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={isImportPending}
              className="mt-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isImportPending ? "Importing…" : "Import"}
            </button>
          </form>

          {state.status === "error" && (
            <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.message}
            </p>
          )}

          {state.status === "success" && state.result && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="font-medium text-emerald-900">
                {state.result.committed
                  ? `Imported ${state.result.rowCount - state.result.errorCount} row${state.result.rowCount - state.result.errorCount === 1 ? "" : "s"}`
                  : "Nothing to commit"}
                {state.result.errorCount > 0 && ` — ${state.result.errorCount} invalid`}
              </p>
              {state.result.commitSummary && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.entries(state.result.commitSummary).map(([key, value]) => (
                    <StatPill key={key} label={humanizeKey(key).toLowerCase()} value={value} />
                  ))}
                </div>
              )}
              {state.result.invalidRows.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-emerald-900">
                    {state.result.invalidRows.length} invalid row{state.result.invalidRows.length === 1 ? "" : "s"} — details
                  </summary>
                  <ul className="mt-2 list-disc pl-5 text-sm text-red-700">
                    {state.result.invalidRows.map((r) => (
                      <li key={r.rowNumber}>
                        Row {r.rowNumber}: {r.errors.join("; ")}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>

        {/* Step 2 — Choose instance(s) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <StepHeader step={2} title="Choose instance(s)" done={selectedIds.length > 0} />
          <p className="mt-1 pl-11 text-base text-slate-500">
            Pushes your org&apos;s current canonical data (products + Assembly BOM + Customers +
            Suppliers, each with their addresses) to whichever instances you select here.
          </p>

          <div className="mt-5 pl-11">
            <button
              type="button"
              onClick={handleLoadInstances}
              disabled={isLoadingInstances}
              className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {isLoadingInstances ? "Loading…" : "Load instances"}
            </button>

            {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}

            {instances.length > 0 && (
              <div className="mt-4 flex flex-col gap-2">
                {instances.map((inst) => (
                  <label key={inst.id} className="flex items-center gap-2 text-base">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(inst.id)}
                      onChange={() => toggleInstance(inst.id)}
                      disabled={!inst.active}
                      className="h-4 w-4"
                    />
                    {inst.name} {!inst.active && <span className="text-sm text-slate-400">(inactive — skipped)</span>}
                  </label>
                ))}
                <div className="mt-1 flex gap-3 text-sm text-indigo-600">
                  <button type="button" onClick={() => setSelectedIds(activeInstances.map((i) => i.id))} className="hover:underline">
                    Select all
                  </button>
                  <button type="button" onClick={() => setSelectedIds([])} className="hover:underline">
                    Clear
                  </button>
                </div>
              </div>
            )}
            {instances.length === 0 && !instancesError && (
              <p className="mt-2 text-sm text-slate-400">No instances loaded yet.</p>
            )}
          </div>
        </section>

        {/* Step 3 — Push */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <StepHeader step={3} title="Push to Cin7 Core" done={pushOutcomes !== null} />

          <div className="mt-5 pl-11">
            <button
              type="button"
              onClick={handlePush}
              disabled={isPushPending || selectedIds.length === 0}
              className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isPushPending
                ? "Pushing…"
                : `Push to ${selectedIds.length || ""} instance${selectedIds.length === 1 ? "" : "s"}`}
            </button>

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
                        <StatPill label="products skipped (unchanged)" value={outcome.productsSkipped ?? 0} />
                        <StatPill label="products failed" value={outcome.productsFailed ?? 0} tone="bad" />
                        <StatPill label="production BOMs pushed" value={outcome.productionBomsPushed ?? 0} />
                        <StatPill label="production BOMs failed" value={outcome.productionBomsFailed ?? 0} tone="bad" />
                        <StatPill label="customers created" value={outcome.customersCreated ?? 0} />
                        <StatPill label="customers updated" value={outcome.customersUpdated ?? 0} />
                        <StatPill label="customers skipped (unchanged)" value={outcome.customersSkipped ?? 0} />
                        <StatPill label="customers failed" value={outcome.customersFailed ?? 0} tone="bad" />
                        <StatPill label="suppliers created" value={outcome.suppliersCreated ?? 0} />
                        <StatPill label="suppliers updated" value={outcome.suppliersUpdated ?? 0} />
                        <StatPill label="suppliers skipped (unchanged)" value={outcome.suppliersSkipped ?? 0} />
                        <StatPill label="suppliers failed" value={outcome.suppliersFailed ?? 0} tone="bad" />
                      </div>
                    )}
                    {outcome.ok && outcome.errors && outcome.errors.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-red-900">
                          {outcome.errors.length} error{outcome.errors.length === 1 ? "" : "s"} — details
                        </summary>
                        <ul className="mt-2 list-disc pl-5 text-sm text-red-700">
                          {outcome.errors.map((e, i) => (
                            <li key={i}>
                              {e.sku}: {e.error}
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
