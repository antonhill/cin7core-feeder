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
  debugCheckProductSupplierOptionsForUnparsedFields,
  debugSurveySaleFulfillmentFields,
  debugSurveyBackorderEtaFields,
  debugTestSaleShipByWriteBack,
  debugTestProductSupplierLink,
  debugTestCreatePurchaseOrder,
  debugCheckProductAvailabilityForSkus,
  debugProbeWorkCentrePaths,
  debugPushOneCustomerAndSupplier,
  listDiagnosticInstancesAction,
  type DiagnosticInstance,
} from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { DIAGNOSTICS_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Panel } from "@/components/ui/Panel";

/**
 * Super-admin only (gated by ./layout.tsx) — live debugging/field-discovery
 * tools against a connected instance's real Cin7 data, split out of Settings
 * > Cin7 Instances so ordinary customers never see them (confirmed live
 * 2026-07-11 they were cluttering that page — some of these are genuine
 * writes against a customer's live Cin7 account, not just reads).
 */
export default function DiagnosticsPage() {
  const [instances, setInstances] = useState<DiagnosticInstance[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [refCheckNames, setRefCheckNames] = useState<Record<string, string>>({});
  const [accountCodes, setAccountCodes] = useState<Record<string, string>>({});
  const [productionBomSkus, setProductionBomSkus] = useState<Record<string, string>>({});
  const [availabilitySkus, setAvailabilitySkus] = useState<Record<string, string>>({});
  const [productionOrderNumbers, setProductionOrderNumbers] = useState<Record<string, string>>({});
  const [shipByTestOrderNumbers, setShipByTestOrderNumbers] = useState<Record<string, string>>({});
  const [supplierLinkTests, setSupplierLinkTests] = useState<Record<string, string>>({});
  const [supplierOptionsSkus, setSupplierOptionsSkus] = useState<Record<string, string>>({});
  const [createPoTests, setCreatePoTests] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const result = await listDiagnosticInstancesAction();
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

  function handleCheckProductAvailabilityForSkus(instanceId: string) {
    const skus = (availabilitySkus[instanceId] ?? "").trim();
    if (!skus) return;
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Checking…" } }));
    startTransition(async () => {
      const result = await debugCheckProductAvailabilityForSkus(instanceId, skus);
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

  function handleCheckProductSupplierOptionsForUnparsedFields(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Scanning live ProductSupplierOptions entries for unparsed fields (e.g. MOQ)…" } }));
    startTransition(async () => {
      const result = await debugCheckProductSupplierOptionsForUnparsedFields(instanceId);
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

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {instances.map((inst) => (
          <Panel key={inst.id} className="p-5">
            <p className="text-base font-semibold text-slate-900">
              {inst.name} <span className="text-sm font-normal text-slate-500">({inst.accountId})</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleFindBomExample(inst.id)} disabled={isPending}>
                Fetch BOM example
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleProbeWorkCentrePaths(inst.id)} disabled={isPending}>
                Probe Work Centre paths
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleFindCustomerSupplierExamples(inst.id)} disabled={isPending}>
                Fetch Customer/Supplier example
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleFindFinishedGoodsExample(inst.id)} disabled={isPending}>
                Fetch Assembly (FinishedGoods) example
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyFinishedGoodsFields(inst.id)} disabled={isPending}>
                Survey Assembly fields (resources/services?)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyCostBasisFields(inst.id)} disabled={isPending}>
                Survey cost basis fields (Average/Latest/Fixed)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyProductionBomFields(inst.id)} disabled={isPending}>
                Survey Production BOM fields
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handlePushOneCustomerAndSupplier(inst.id)} disabled={isPending}>
                Test push 1 customer + 1 supplier
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleCheckSaleStatuses(inst.id)} disabled={isPending}>
                Check sale statuses
              </Button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                label="Customer or supplier name"
                hideLabel
                placeholder="Customer or supplier name"
                value={refCheckNames[inst.id] ?? ""}
                onChange={(e) => setRefCheckNames((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-64"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCheckCustomerReferenceFields(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
              >
                Check customer&rsquo;s reference fields
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCheckSupplierReferenceFields(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
              >
                Check supplier&rsquo;s reference fields
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleFetchCustomerByName(inst.id)}
                disabled={isPending || !(refCheckNames[inst.id] ?? "").trim()}
              >
                Fetch this customer from Cin7
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="Account codes"
                hideLabel
                placeholder="Account codes, e.g. 800,801"
                value={accountCodes[inst.id] ?? ""}
                onChange={(e) => setAccountCodes((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-64"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCompareAccounts(inst.id)}
                disabled={isPending || !(accountCodes[inst.id] ?? "").trim()}
              >
                Compare account codes
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="SKUs to check"
                hideLabel
                placeholder="SKUs to check, e.g. F12-CPL-SBEP-DEMO,F12-CPL-SZPC-DEMO"
                value={productionBomSkus[inst.id] ?? ""}
                onChange={(e) => setProductionBomSkus((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCheckProductionBomForSkus(inst.id)}
                disabled={isPending || !(productionBomSkus[inst.id] ?? "").trim()}
              >
                Check Production BOM for SKUs
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="SKUs to check stock for"
                hideLabel
                placeholder="SKUs to check stock for, e.g. CC50X50-009,CC60X60-009"
                value={availabilitySkus[inst.id] ?? ""}
                onChange={(e) => setAvailabilitySkus((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCheckProductAvailabilityForSkus(inst.id)}
                disabled={isPending || !(availabilitySkus[inst.id] ?? "").trim()}
              >
                Check stock for SKUs
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="Manufacture Order number"
                hideLabel
                placeholder="Manufacture Order number, e.g. MO-00036"
                value={productionOrderNumbers[inst.id] ?? ""}
                onChange={(e) => setProductionOrderNumbers((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleFetchProductionOrderDetail(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
              >
                Fetch Production Order detail
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleSurveyProductionOrderRoutingTasks(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
              >
                Survey routing tasks (Type &quot;R&quot; rows, Adv. Mfg)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleSurveyProductionOrderOperationStatus(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
              >
                Probe operation status fields/paths (Adv. Mfg)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleSurveyProductionRun(inst.id)}
                disabled={isPending || !(productionOrderNumbers[inst.id] ?? "").trim()}
              >
                Fetch /production/order/run (Adv. Mfg — actuals)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyProductionOrderStatuses(inst.id)} disabled={isPending}>
                Survey Status/OrderStatus values (whole account, Adv. Mfg)
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleSurveyPurchaseDetailFields(inst.id)} disabled={isPending}>
                Survey purchase detail fields (Inventory Movement Phase 1)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyProductAvailabilityFields(inst.id)} disabled={isPending}>
                Survey product availability fields (Stock Health)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyProductSupplierOptionsFields(inst.id)} disabled={isPending}>
                Survey Product Supplier Options fields (Replenish rebuild)
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="SKU"
                hideLabel
                placeholder="SKU e.g. New Item for Smart"
                value={supplierOptionsSkus[inst.id] ?? ""}
                onChange={(e) => setSupplierOptionsSkus((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-96"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleFindProductSupplierOptionsExample(inst.id)}
                disabled={isPending || !(supplierOptionsSkus[inst.id] ?? "").trim()}
              >
                Fetch one SKU&apos;s Product Supplier Options (targeted, raw dump)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCheckProductSupplierOptionsForUnparsedFields(inst.id)}
                disabled={isPending}
              >
                Check for a real MOQ field (Purchase Planner)
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleSurveySaleFulfillmentFields(inst.id)} disabled={isPending}>
                Survey sale fulfillment fields (Order Fulfillment Dashboard)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleSurveyBackorderEtaFields(inst.id)} disabled={isPending}>
                Survey backorder ETA fields (Order Fulfillment Dashboard)
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="Order Number to test-write against"
                hideLabel
                placeholder="Order Number to test-write against, e.g. SO-00583"
                value={shipByTestOrderNumbers[inst.id] ?? ""}
                onChange={(e) => setShipByTestOrderNumbers((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-80"
              />
              {/* Genuine live Cin7 write, no confirmation step — a named, deliberately out-of-scope follow-up for this reskin (behaviour freeze), not something to add here. warning variant + unchanged title text are the only cues, exactly as before. */}
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleTestSaleShipByWriteBack(inst.id)}
                disabled={isPending || !(shipByTestOrderNumbers[inst.id] ?? "").trim()}
                title="Performs a real PUT against this order in Cin7 — a no-op (writes back its own current ShipBy unchanged) but a genuine write, not a read-only survey. Use a real test order, not a live customer's."
              >
                Test ShipBy write-back (WRITES to Cin7 — no-op test)
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="SKU and supplier name"
                hideLabel
                placeholder='"SKU,Supplier Name" e.g. Cardboard80,Box Shop Packaging'
                value={supplierLinkTests[inst.id] ?? ""}
                onChange={(e) => setSupplierLinkTests((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-96"
              />
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleTestProductSupplierLink(inst.id)}
                disabled={isPending || !(supplierLinkTests[inst.id] ?? "").trim()}
                title="Performs a real PUT against this product in Cin7, adding a resolved SupplierID to its Suppliers array — a genuine write, not a no-op. Only safe to use on a product whose supplier link is currently missing/failing anyway."
              >
                Test product-supplier link with resolved SupplierID (WRITES to Cin7)
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                label="SKU, supplier name, quantity, location name"
                hideLabel
                placeholder='"SKU,Supplier Name,Quantity,Location Name" e.g. Cardboard80,Box Shop Packaging,1,Main Warehouse'
                value={createPoTests[inst.id] ?? ""}
                onChange={(e) => setCreatePoTests((prev) => ({ ...prev, [inst.id]: e.target.value }))}
                className="w-[30rem]"
              />
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleTestCreatePurchaseOrder(inst.id)}
                disabled={isPending || !(createPoTests[inst.id] ?? "").trim()}
                title="Creates a real DRAFT Purchase Order in Cin7 by trying several candidate payload shapes — a genuine write, not a no-op. No confirmed POST /purchase shape exists anywhere in this codebase yet. Use a real test supplier/SKU/location, not a live customer's — the created order is a draft you can void/delete in Cin7's own UI afterward."
              >
                Test create Purchase Order (WRITES to Cin7 — creates a real DRAFT)
              </Button>
            </div>
            {testResults[inst.id] && (
              <pre
                className={`mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs ${testResults[inst.id].ok ? "text-success" : "text-danger"}`}
              >
                {testResults[inst.id].message}
              </pre>
            )}
          </Panel>
        ))}
        {loaded && instances.length === 0 && <p className="text-sm text-slate-500">No instances connected yet.</p>}
      </div>
    </main>
  );
}
