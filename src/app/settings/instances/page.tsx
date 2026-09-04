"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { deleteInstance, listInstances, testInstanceConnection, upsertInstance, type InstanceRecord } from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { INSTANCES_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";

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
        active: form.get("active") === "on",
        fulfilmentViewStartDate: String(form.get("fulfilmentViewStartDate") ?? ""),
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

  function handleDelete(instanceId: string) {
    // Native confirm() left as-is deliberately — replacing it with the new
    // ConfirmDialog primitive is a confirmation-semantics change, out of
    // scope for this presentation-only reskin (see the Diagnostics
    // follow-up note in the same review package).
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
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <ModuleHeader module={INSTANCES_MODULE}>Connect and manage the Cin7 Core instances your org syncs to.</ModuleHeader>
        <Button onClick={() => setModalTarget("new")} className="shrink-0">
          + Add instance
        </Button>
      </div>

      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {instances.map((inst) => (
          <div key={inst.id} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-slate-900">
                  {inst.name} {!inst.active && <span className="text-sm font-normal text-slate-400">(inactive)</span>}
                </p>
                <p className="text-sm text-slate-500">
                  Account {inst.accountId} · Key ····{inst.keyLast4}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => handleTest(inst.id)} disabled={isPending}>
                  Test connection
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setModalTarget(inst.id)}>
                  Edit
                </Button>
                <Button variant="destructive" size="sm" onClick={() => handleDelete(inst.id)}>
                  Delete
                </Button>
              </div>
            </div>
            {testResults[inst.id] && (
              <pre
                className={`mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs ${testResults[inst.id].ok ? "text-success" : "text-danger"}`}
              >
                {testResults[inst.id].message}
              </pre>
            )}
          </div>
        ))}
        {loaded && instances.length === 0 && (
          <EmptyState
            title="No instances connected yet"
            description="Connect a Cin7 Core instance to start syncing products, customers, and reports."
            action={<Button onClick={() => setModalTarget("new")}>+ Add instance</Button>}
          />
        )}
      </div>

      <Dialog open={modalTarget !== null} onClose={() => setModalTarget(null)} title={editingInstance ? "Edit instance" : "Add an instance"}>
        {modalTarget && (
          <form
            id="instance-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave(new FormData(e.currentTarget), editingInstance?.id);
            }}
            className="flex flex-col gap-4"
          >
            <Input name="name" label="Name" defaultValue={editingInstance?.name} required autoFocus />
            <Input name="accountId" label="Account ID" defaultValue={editingInstance?.accountId} required />
            <Input
              name="applicationKey"
              type="password"
              label="Application key"
              helperText={editingInstance ? "Leave blank to keep current" : undefined}
            />
            <Checkbox name="active" label="Active" defaultChecked={editingInstance?.active ?? true} />
            <Input
              name="fulfilmentViewStartDate"
              type="date"
              label="Fulfilment view start date"
              helperText="Orders dated before this hide from Pick Today, Ship Today, and the Shipping Calendar — useful while cleaning up old history. Leave blank to show everything."
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setModalTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={isPending}>
                {editingInstance ? "Save" : "Add"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </main>
  );
}
