"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  debugCheckCustomerReferenceFields,
  debugCheckSaleStatuses,
  debugCheckSupplierReferenceFields,
  debugCompareAccounts,
  debugFetchCustomerByName,
  debugFindBomExample,
  debugFindCustomerSupplierExamples,
  debugFindFinishedGoodsExample,
  debugSurveyFinishedGoodsFields,
  debugSurveyCostBasisFields,
  debugSurveyProductionBomFields,
  debugCheckProductionBomForSkus,
  debugFetchProductionOrderDetail,
  debugProbeWorkCentrePaths,
  debugPushOneCustomerAndSupplier,
  deleteInstance,
  listInstances,
  testInstanceConnection,
  upsertInstance,
  type InstanceRecord,
} from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { INSTANCES_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";

const DEFAULT_BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2";

export default function InstancesSettingsPage() {
  return (
    <Suspense>
      <InstancesSettingsPageInner />
    </Suspense>
  );
}

function InstancesSettingsPageInner() {
  const searchParams = useSearchParams();
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = closed, "new" = add-instance modal, otherwise the instance id being edited
  const [modalTarget, setModalTarget] = useState<"new" | string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [refCheckNames, setRefCheckNames] = useState<Record<string, string>>({});
  const [accountCodes, setAccountCodes] = useState<Record<string, string>>({});
  const [productionBomSkus, setProductionBomSkus] = useState<Record<string, string>>({});
  const [productionOrderNumbers, setProductionOrderNumbers] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const result = await listInstances();
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
      setLoaded(true);
    });
  }, []);

  // Lets the onboarding checklist on "/" (onboarding-checklist.tsx) link
  // straight into the Add Instance modal instead of just the bare page.
  useEffect(() => {
    if (searchParams.get("openAdd") === "1") startTransition(() => setModalTarget("new"));
  }, [searchParams]);

  function handleSave(form: FormData, instanceId?: string) {
    setError(null);
    startTransition(async () => {
      const result = await upsertInstance({
        instanceId,
        name: String(form.get("name") ?? ""),
        accountId: String(form.get("accountId") ?? ""),
        applicationKey: String(form.get("applicationKey") ?? "") || undefined,
        baseUrl: String(form.get("baseUrl") ?? DEFAULT_BASE_URL),
        active: form.get("active") === "on",
      });
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
      setModalTarget(null);
    });
  }

  function handleTest(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Testing…" } }));
    startTransition(async () => {
      const result = await testInstanceConnection(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFindBomExample(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Searching…" } }));
    startTransition(async () => {
      const result = await debugFindBomExample(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleCheckSaleStatuses(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Checking…" } }));
    startTransition(async () => {
      const result = await debugCheckSaleStatuses(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleProbeWorkCentrePaths(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Probing (~10s)…" } }));
    startTransition(async () => {
      const result = await debugProbeWorkCentrePaths(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFindCustomerSupplierExamples(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching…" } }));
    startTransition(async () => {
      const result = await debugFindCustomerSupplierExamples(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFindFinishedGoodsExample(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching…" } }));
    startTransition(async () => {
      const result = await debugFindFinishedGoodsExample(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyFinishedGoodsFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying (multiple calls, may take a moment)…" } }));
    startTransition(async () => {
      const result = await debugSurveyFinishedGoodsFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyCostBasisFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying cost fields…" } }));
    startTransition(async () => {
      const result = await debugSurveyCostBasisFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductionBomFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying Production BOM fields (multiple calls)…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductionBomFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handlePushOneCustomerAndSupplier(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Pushing…" } }));
    startTransition(async () => {
      const result = await debugPushOneCustomerAndSupplier(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleCheckCustomerReferenceFields(instanceId: string) {
    const name = (refCheckNames[instanceId] ?? "").trim();
    if (!name) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Checking…" } }));
    startTransition(async () => {
      const result = await debugCheckCustomerReferenceFields(instanceId, name);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFetchCustomerByName(instanceId: string) {
    const name = (refCheckNames[instanceId] ?? "").trim();
    if (!name) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching…" } }));
    startTransition(async () => {
      const result = await debugFetchCustomerByName(instanceId, name);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleCheckSupplierReferenceFields(instanceId: string) {
    const name = (refCheckNames[instanceId] ?? "").trim();
    if (!name) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Checking…" } }));
    startTransition(async () => {
      const result = await debugCheckSupplierReferenceFields(instanceId, name);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleCompareAccounts(instanceId: string) {
    const codes = (accountCodes[instanceId] ?? "").trim();
    if (!codes) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching…" } }));
    startTransition(async () => {
      const result = await debugCompareAccounts(instanceId, codes);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleCheckProductionBomForSkus(instanceId: string) {
    const skus = (productionBomSkus[instanceId] ?? "").trim();
    if (!skus) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Checking…" } }));
    startTransition(async () => {
      const result = await debugCheckProductionBomForSkus(instanceId, skus);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFetchProductionOrderDetail(instanceId: string) {
    const orderNumber = (productionOrderNumbers[instanceId] ?? "").trim();
    if (!orderNumber) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching…" } }));
    startTransition(async () => {
      const result = await debugFetchProductionOrderDetail(instanceId, orderNumber);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleDelete(instanceId: string) {
    if (!confirm("Delete this Cin7 Core instance connection?")) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteInstance(instanceId);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
    });
  }

  const editingInstance = typeof modalTarget === "string" ? instances.find((i) => i.id === modalTarget) : undefined;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <ModuleHeader module={INSTANCES_MODULE}>Connect and manage the Cin7 Core instances your org syncs to.</ModuleHeader>
        <button
          onClick={() => setModalTarget("new")}
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500"
        >
          + Add instance
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {instances.map((inst) => (
          <div key={inst.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-lg font-semibold text-slate-900">
                  {inst.name} {!inst.active && <span className="text-sm font-normal text-slate-400">(inactive)</span>}
                </p>
                <p className="text-sm text-slate-500">
                  Account {inst.accountId} · Key ····{inst.keyLast4} · {inst.baseUrl}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button onClick={() => handleTest(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Test connection
                </button>
                <button onClick={() => handleFindBomExample(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Fetch BOM example
                </button>
                <button onClick={() => handleProbeWorkCentrePaths(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Probe Work Centre paths
                </button>
                <button onClick={() => handleFindCustomerSupplierExamples(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Fetch Customer/Supplier example
                </button>
                <button onClick={() => handleFindFinishedGoodsExample(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Fetch Assembly (FinishedGoods) example
                </button>
                <button onClick={() => handleSurveyFinishedGoodsFields(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Survey Assembly fields (resources/services?)
                </button>
                <button onClick={() => handleSurveyCostBasisFields(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Survey cost basis fields (Average/Latest/Fixed)
                </button>
                <button onClick={() => handleSurveyProductionBomFields(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Survey Production BOM fields
                </button>
                <button onClick={() => handlePushOneCustomerAndSupplier(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Test push 1 customer + 1 supplier
                </button>
                <button onClick={() => handleCheckSaleStatuses(inst.id)} disabled={isPending} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Check sale statuses
                </button>
                <button onClick={() => setModalTarget(inst.id)} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  Edit
                </button>
                <button onClick={() => handleDelete(inst.id)} className="rounded-full border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">
                  Delete
                </button>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                placeholder="Customer or supplier name"
                value={refCheckNames[inst.id] ?? ""}
                onChange={(e) => setRefCheckNames((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-64 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleCheckCustomerReferenceFields(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Check customer&rsquo;s reference fields
              </button>
              <button
                onClick={() => handleCheckSupplierReferenceFields(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Check supplier&rsquo;s reference fields
              </button>
              <button
                onClick={() => handleFetchCustomerByName(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Fetch this customer from Cin7
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="Account codes, e.g. 800,801"
                value={accountCodes[inst.id] ?? ""}
                onChange={(e) => setAccountCodes((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-64 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleCompareAccounts(inst.id)}
                disabled={isPending || !(accountCodes[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Compare account codes
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="SKUs to check, e.g. F12-CPL-SBEP-DEMO,F12-CPL-SZPC-DEMO"
                value={productionBomSkus[inst.id] ?? ""}
                onChange={(e) => setProductionBomSkus((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleCheckProductionBomForSkus(inst.id)}
                disabled={isPending || !(productionBomSkus[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Check Production BOM for SKUs
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="Manufacture Order number, e.g. MO-00036"
                value={productionOrderNumbers[inst.id] ?? ""}
                onChange={(e) => setProductionOrderNumbers((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleFetchProductionOrderDetail(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Fetch Production Order detail
              </button>
            </div>
            {testResults[inst.id] && (
              <pre
                className={`mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs ${testResults[inst.id].ok ? "text-emerald-700" : "text-red-700"}`}
              >
                {testResults[inst.id].message}
              </pre>
            )}
          </div>
        ))}
        {loaded && instances.length === 0 && <p className="text-base text-slate-500">No instances connected yet.</p>}
      </div>

      {modalTarget && (
        <InstanceModal
          instance={editingInstance}
          isPending={isPending}
          onClose={() => setModalTarget(null)}
          onSubmit={(form) => handleSave(form, editingInstance?.id)}
        />
      )}
    </main>
  );
}

function InstanceModal({
  instance,
  isPending,
  onSubmit,
  onClose,
}: {
  instance?: InstanceRecord;
  isPending: boolean;
  onSubmit: (form: FormData) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="instance-modal-title"
      >
        <div className="flex items-center justify-between">
          <h2 id="instance-modal-title" className="text-xl font-semibold text-slate-900">
            {instance ? "Edit instance" : "Add an instance"}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Name</span>
            <input name="name" defaultValue={instance?.name} required autoFocus className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Account ID</span>
            <input name="accountId" defaultValue={instance?.accountId} required className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">
              Application key {instance && <span className="text-sm font-normal text-slate-400">(leave blank to keep current)</span>}
            </span>
            <input name="applicationKey" type="password" className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Base URL</span>
            <input
              name="baseUrl"
              defaultValue={instance?.baseUrl ?? DEFAULT_BASE_URL}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-base">
            <input name="active" type="checkbox" defaultChecked={instance?.active ?? true} className="h-4 w-4" />
            Active
          </label>
          <div className="mt-2 flex gap-2">
            <button type="submit" disabled={isPending} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">
              {isPending && <Spinner className="mr-1.5" />}
              {isPending ? "Saving…" : instance ? "Save" : "Add"}
            </button>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2.5 text-base font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
