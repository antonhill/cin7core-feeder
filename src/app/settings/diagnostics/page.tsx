"use client";

import { useEffect, useState, useTransition } from "react";
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
  debugSurveyProductionOrderRoutingTasks,
  debugSurveyProductionOrderOperationStatus,
  debugSurveyProductionRun,
  debugSurveyProductionOrderStatuses,
  debugSurveyPurchaseDetailFields,
  debugSurveyProductAvailabilityFields,
  debugSurveyProductSupplierOptionsFields,
  debugFindProductSupplierOptionsExample,
  debugSurveySaleFulfillmentFields,
  debugSurveyBackorderEtaFields,
  debugTestSaleShipByWriteBack,
  debugTestProductSupplierLink,
  debugTestCreatePurchaseOrder,
  debugProbeWorkCentrePaths,
  debugPushOneCustomerAndSupplier,
  listInstances,
  type InstanceRecord,
} from "../instances/actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { DIAGNOSTICS_MODULE } from "@/app/module-nav";

/**
 * Super-admin only (gated by ./layout.tsx) — live debugging/field-discovery
 * tools against a connected instance's real Cin7 data, split out of Settings
 * > Cin7 Instances so ordinary customers never see them (confirmed live
 * 2026-07-11 they were cluttering that page — some of these are genuine
 * writes against a customer's live Cin7 account, not just reads).
 */
export default function DiagnosticsPage() {
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [refCheckNames, setRefCheckNames] = useState<Record<string, string>>({});
  const [accountCodes, setAccountCodes] = useState<Record<string, string>>({});
  const [productionBomSkus, setProductionBomSkus] = useState<Record<string, string>>({});
  const [productionOrderNumbers, setProductionOrderNumbers] = useState<Record<string, string>>({});
  const [shipByTestOrderNumbers, setShipByTestOrderNumbers] = useState<Record<string, string>>({});
  const [supplierLinkTests, setSupplierLinkTests] = useState<Record<string, string>>({});
  const [supplierOptionsSkus, setSupplierOptionsSkus] = useState<Record<string, string>>({});
  const [createPoTests, setCreatePoTests] = useState<Record<string, string>>({});
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

  function handleSurveyProductionOrderRoutingTasks(instanceId: string) {
    const orderNumber = (productionOrderNumbers[instanceId] ?? "").trim();
    if (!orderNumber) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching routing tasks…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductionOrderRoutingTasks(instanceId, orderNumber);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductionOrderOperationStatus(instanceId: string) {
    const orderNumber = (productionOrderNumbers[instanceId] ?? "").trim();
    if (!orderNumber) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Probing operation-status fields/paths (~10 calls, takes a few seconds)…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductionOrderOperationStatus(instanceId, orderNumber);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductionRun(instanceId: string) {
    const orderNumber = (productionOrderNumbers[instanceId] ?? "").trim();
    if (!orderNumber) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching /production/order/run…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductionRun(instanceId, orderNumber);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductionOrderStatuses(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Tallying Status/OrderStatus across every production order…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductionOrderStatuses(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyPurchaseDetailFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying purchase detail fields (multiple calls)…" } }));
    startTransition(async () => {
      const result = await debugSurveyPurchaseDetailFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductAvailabilityFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying product availability fields…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductAvailabilityFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyProductSupplierOptionsFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Hunting for Product Supplier Options fields (many calls)…" } }));
    startTransition(async () => {
      const result = await debugSurveyProductSupplierOptionsFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFindProductSupplierOptionsExample(instanceId: string) {
    const sku = (supplierOptionsSkus[instanceId] ?? "").trim();
    if (!sku) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Fetching one SKU under several Include flag combos…" } }));
    startTransition(async () => {
      const result = await debugFindProductSupplierOptionsExample(instanceId, sku);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveySaleFulfillmentFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying sale fulfillment fields (multiple calls)…" } }));
    startTransition(async () => {
      const result = await debugSurveySaleFulfillmentFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleSurveyBackorderEtaFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Surveying backorder ETA fields (multiple calls)…" } }));
    startTransition(async () => {
      const result = await debugSurveyBackorderEtaFields(instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleTestSaleShipByWriteBack(instanceId: string) {
    const orderNumber = (shipByTestOrderNumbers[instanceId] ?? "").trim();
    if (!orderNumber) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Writing (no-op ShipBy round-trip)…" } }));
    startTransition(async () => {
      const result = await debugTestSaleShipByWriteBack(instanceId, orderNumber);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleTestProductSupplierLink(instanceId: string) {
    const input = (supplierLinkTests[instanceId] ?? "").trim();
    if (!input) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Writing (resolving SupplierID, testing product PUT)…" } }));
    startTransition(async () => {
      const result = await debugTestProductSupplierLink(instanceId, input);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleTestCreatePurchaseOrder(instanceId: string) {
    const input = (createPoTests[instanceId] ?? "").trim();
    if (!input) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Writing (resolving IDs, trying candidate PO shapes)…" } }));
    startTransition(async () => {
      const result = await debugTestCreatePurchaseOrder(instanceId, input);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={DIAGNOSTICS_MODULE}>
        Live debugging and field-discovery tools against a connected instance — super-admin only.
      </ModuleHeader>

      {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-6 flex flex-col gap-3">
        {instances.map((inst) => (
          <div key={inst.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-lg font-semibold text-slate-900">
              {inst.name} <span className="text-sm font-normal text-slate-400">({inst.accountId})</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
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
              <button
                onClick={() => handleSurveyProductionOrderRoutingTasks(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey routing tasks (Type &quot;R&quot; rows, Adv. Mfg)
              </button>
              <button
                onClick={() => handleSurveyProductionOrderOperationStatus(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Probe operation status fields/paths (Adv. Mfg)
              </button>
              <button
                onClick={() => handleSurveyProductionRun(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Fetch /production/order/run (Adv. Mfg — actuals)
              </button>
              <button
                onClick={() => handleSurveyProductionOrderStatuses(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey Status/OrderStatus values (whole account, Adv. Mfg)
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => handleSurveyPurchaseDetailFields(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey purchase detail fields (Inventory Movement Phase 1)
              </button>
              <button
                onClick={() => handleSurveyProductAvailabilityFields(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey product availability fields (Stock Health)
              </button>
              <button
                onClick={() => handleSurveyProductSupplierOptionsFields(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey Product Supplier Options fields (Replenish rebuild)
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="SKU e.g. New Item for Smart"
                value={supplierOptionsSkus[inst.id] ?? ""}
                onChange={(e) => setSupplierOptionsSkus((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-96 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleFindProductSupplierOptionsExample(inst.id)}
                disabled={isPending || !(supplierOptionsSkus[inst.id] ?? "").trim()}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Fetch one SKU&apos;s Product Supplier Options (targeted, raw dump)
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => handleSurveySaleFulfillmentFields(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey sale fulfillment fields (Order Fulfillment Dashboard)
              </button>
              <button
                onClick={() => handleSurveyBackorderEtaFields(inst.id)}
                disabled={isPending}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Survey backorder ETA fields (Order Fulfillment Dashboard)
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="Order Number to test-write against, e.g. SO-00583"
                value={shipByTestOrderNumbers[inst.id] ?? ""}
                onChange={(e) => setShipByTestOrderNumbers((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleTestSaleShipByWriteBack(inst.id)}
                disabled={isPending || !(shipByTestOrderNumbers[inst.id] ?? "").trim()}
                className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                title="Performs a real PUT against this order in Cin7 — a no-op (writes back its own current ShipBy unchanged) but a genuine write, not a read-only survey. Use a real test order, not a live customer's."
              >
                Test ShipBy write-back (WRITES to Cin7 — no-op test)
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder='"SKU,Supplier Name" e.g. Cardboard80,Box Shop Packaging'
                value={supplierLinkTests[inst.id] ?? ""}
                onChange={(e) => setSupplierLinkTests((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-96 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleTestProductSupplierLink(inst.id)}
                disabled={isPending || !(supplierLinkTests[inst.id] ?? "").trim()}
                className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                title="Performs a real PUT against this product in Cin7, adding a resolved SupplierID to its Suppliers array — a genuine write, not a no-op. Only safe to use on a product whose supplier link is currently missing/failing anyway."
              >
                Test product-supplier link with resolved SupplierID (WRITES to Cin7)
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder='"SKU,Supplier Name,Quantity,Location Name" e.g. Cardboard80,Box Shop Packaging,1,Main Warehouse'
                value={createPoTests[inst.id] ?? ""}
                onChange={(e) => setCreatePoTests((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-[30rem] rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={() => handleTestCreatePurchaseOrder(inst.id)}
                disabled={isPending || !(createPoTests[inst.id] ?? "").trim()}
                className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                title="Creates a real DRAFT Purchase Order in Cin7 by trying several candidate payload shapes — a genuine write, not a no-op. No confirmed POST /purchase shape exists anywhere in this codebase yet. Use a real test supplier/SKU/location, not a live customer's — the created order is a draft you can void/delete in Cin7's own UI afterward."
              >
                Test create Purchase Order (WRITES to Cin7 — creates a real DRAFT)
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
    </main>
  );
}
