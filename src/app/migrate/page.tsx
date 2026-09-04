"use client";

import { useEffect, useState, useTransition } from "react";
import type { PushScopeSelection } from "@/app/import/actions";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { usePushJob } from "@/hooks/usePushJob";
import { usePullJob } from "@/hooks/usePullJob";
import { InstancePicker } from "@/app/InstancePicker";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { getBillingStatusAction } from "@/actions/billing";
import type { ImportKind } from "@/import/run-import";
import { ModuleHeader } from "@/app/ModuleHeader";
import { MIGRATE_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

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
          done ? "bg-primary text-white" : "bg-slate-200 text-slate-600"
        }`}
      >
        {step}
      </span>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
    </div>
  );
}

function StatPill({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "bad" }) {
  if (!value) return null;
  return (
    <Badge tone={tone === "bad" ? "danger" : "neutral"}>
      <span className="tabular-nums">{value}</span> {label}
    </Badge>
  );
}

export default function MigratePage() {
  const picker = useInstancePicker();
  const sourceId = picker.instanceId;
  const setSourceId = picker.setInstanceId;

  const pull = usePullJob();

  const [targetIds, setTargetIds] = useState<string[]>([]);
  const push = usePushJob();

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
    push.reset();
    setTargetIds((prev) => prev.filter((id) => id !== sourceId));
    pull.start(sourceId);
  }

  function toggleTarget(id: string) {
    setTargetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handlePush() {
    push.start(targetIds, PUSH_PULLED_SCOPE);
  }

  const targetChoices = picker.selectableInstances.filter((i) => i.id !== sourceId);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={MIGRATE_MODULE}>
        Pull every Product, Assembly BOM, Customer, and Supplier live from one connected instance,
        then push the pulled data into another.
      </ModuleHeader>

      <div className="mt-6">
        <Alert tone="warning">
          Pulling overwrites the org&apos;s canonical data for any product SKU or customer/supplier
          Name that also exists in the source instance — canonical data isn&apos;t scoped to a
          single instance. Only use this when you want the source instance to become the org&apos;s
          source of truth.
        </Alert>
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <Panel>
          <StepHeader step={1} title="Pull from a source instance" done={pull.status === "done"} />

          <div className="mt-5 pl-11">
            <InstancePicker {...picker} onChange={setSourceId} />

            <div className="mt-4">
              <Button onClick={handlePull} disabled={!sourceId} loading={pull.isPulling || pull.status === "running"}>
                {pull.status === "running" ? "Pulling… (may take a while for a large catalog)" : "Pull all data"}
              </Button>
            </div>

            {pull.error && (
              <div className="mt-4">
                <Alert tone="danger">{pull.error}</Alert>
              </div>
            )}

            {pull.results && (
              <div className="mt-4 flex flex-col gap-3">
                {KIND_ORDER.map((kind) => {
                  const result = pull.results?.[kind];
                  if (!result) return null;
                  const committedCount = result.rowCount - result.errorCount;
                  return (
                    <Alert key={kind} tone="success">
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
                    </Alert>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <StepHeader step={2} title="Push into another instance" done={push.status === "done"} />
          <p className="mt-1 pl-11 text-sm text-slate-500">
            Pushes only what was just pulled (scoped to the most recent import of each kind), not
            the org&apos;s whole catalog. The source instance is excluded here to avoid pushing
            data straight back to where it came from.
          </p>

          <div className="mt-5 pl-11">
            <InstanceMultiPicker
              instances={targetChoices}
              selectedIds={targetIds}
              onToggle={toggleTarget}
              emptyMessage="Load instances above and pick a source first."
            />

            <div className="mt-4">
              <Button
                onClick={handlePush}
                disabled={targetIds.length === 0 || pull.status !== "done" || !canWrite}
                loading={push.isPushing || push.status === "running"}
              >
                {push.status === "running"
                  ? "Pushing… (may take a while for a large catalog)"
                  : `Push to ${targetIds.length || ""} instance${targetIds.length === 1 ? "" : "s"}`}
              </Button>
            </div>
            {!canWrite && (
              <div className="mt-2">
                <Alert tone="warning">Available on a paid plan — this trial is read-only.</Alert>
              </div>
            )}

            {push.error && (
              <div className="mt-4">
                <Alert tone="danger">{push.error}</Alert>
              </div>
            )}

            {push.outcomes && (
              <div className="mt-4 flex flex-col gap-3">
                {push.outcomes.map((outcome) => (
                  <Alert key={outcome.instanceId} tone={outcome.ok ? "success" : "danger"}>
                    <p className={`font-medium ${outcome.ok ? "text-emerald-900" : "text-red-900"}`}>
                      {outcome.instanceName ?? outcome.instanceId}
                    </p>
                    {!outcome.ok && <p className="mt-1 text-sm text-danger">{outcome.error}</p>}
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
                  </Alert>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </main>
  );
}
