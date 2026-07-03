"use client";

import { useState, useTransition } from "react";
import {
  debugFindBomExample,
  deleteInstance,
  listInstances,
  testInstanceConnection,
  upsertInstance,
  type InstanceRecord,
} from "./actions";

const DEFAULT_BASE_URL = "https://inventory.dearsystems.com/ExternalApi/v2";

export default function InstancesSettingsPage() {
  const [orgId, setOrgId] = useState("");
  const [secret, setSecret] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [isPending, startTransition] = useTransition();

  function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await listInstances(orgId, secret);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
      setUnlocked(true);
    });
  }

  function handleSave(form: FormData, instanceId?: string) {
    setError(null);
    startTransition(async () => {
      const result = await upsertInstance({
        orgId,
        secret,
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
      setEditingId(null);
    });
  }

  function handleTest(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Testing…" } }));
    startTransition(async () => {
      const result = await testInstanceConnection(orgId, secret, instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleFindBomExample(instanceId: string) {
    setTestResults((prev) => ({ ...prev, [instanceId]: { ok: true, message: "Searching…" } }));
    startTransition(async () => {
      const result = await debugFindBomExample(orgId, secret, instanceId);
      setTestResults((prev) => ({ ...prev, [instanceId]: result }));
    });
  }

  function handleDelete(instanceId: string) {
    if (!confirm("Delete this Cin7 Core instance connection?")) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteInstance(orgId, secret, instanceId);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
    });
  }

  if (!unlocked) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold">Cin7 Core Instances</h1>
        <p className="mt-1 text-sm text-gray-500">Connect and manage the Cin7 Core instances this org syncs to.</p>
        <form onSubmit={handleUnlock} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Organization ID
            <input
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              required
              className="rounded border px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Passphrase
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
              className="rounded border px-3 py-2"
            />
          </label>
          <button type="submit" disabled={isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
            {isPending ? "Loading…" : "Unlock"}
          </button>
        </form>
        {error && <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-xl font-semibold">Cin7 Core Instances</h1>
      <p className="mt-1 text-sm text-gray-500">Org {orgId}</p>

      {error && <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="mt-6 flex flex-col gap-3">
        {instances.map((inst) =>
          editingId === inst.id ? (
            <InstanceForm
              key={inst.id}
              instance={inst}
              isPending={isPending}
              onCancel={() => setEditingId(null)}
              onSubmit={(form) => handleSave(form, inst.id)}
            />
          ) : (
            <div key={inst.id} className="rounded border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">
                    {inst.name} {!inst.active && <span className="text-xs text-gray-400">(inactive)</span>}
                  </p>
                  <p className="text-xs text-gray-500">
                    Account {inst.accountId} · Key ····{inst.keyLast4} · {inst.baseUrl}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleTest(inst.id)} disabled={isPending} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
                    Test connection
                  </button>
                  <button onClick={() => handleFindBomExample(inst.id)} disabled={isPending} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
                    Fetch BOM example
                  </button>
                  <button onClick={() => setEditingId(inst.id)} className="rounded border px-3 py-1 text-sm">
                    Edit
                  </button>
                  <button onClick={() => handleDelete(inst.id)} className="rounded border px-3 py-1 text-sm text-red-700">
                    Delete
                  </button>
                </div>
              </div>
              {testResults[inst.id] && (
                <pre
                  className={`mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs ${testResults[inst.id].ok ? "text-green-700" : "text-red-700"}`}
                >
                  {testResults[inst.id].message}
                </pre>
              )}
            </div>
          )
        )}
        {instances.length === 0 && <p className="text-sm text-gray-500">No instances connected yet.</p>}
      </div>

      <h2 className="mt-8 text-sm font-medium">Add an instance</h2>
      <InstanceForm isPending={isPending} onSubmit={(form) => handleSave(form)} />
    </main>
  );
}

function InstanceForm({
  instance,
  isPending,
  onSubmit,
  onCancel,
}: {
  instance?: InstanceRecord;
  isPending: boolean;
  onSubmit: (form: FormData) => void;
  onCancel?: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
      className="mt-3 flex flex-col gap-3 rounded border p-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" defaultValue={instance?.name} required className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Account ID
        <input name="accountId" defaultValue={instance?.accountId} required className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Application key {instance && <span className="text-xs text-gray-400">(leave blank to keep current)</span>}
        <input name="applicationKey" type="password" className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Base URL
        <input
          name="baseUrl"
          defaultValue={instance?.baseUrl ?? DEFAULT_BASE_URL}
          required
          className="rounded border px-3 py-2 font-mono text-xs"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input name="active" type="checkbox" defaultChecked={instance?.active ?? true} />
        Active
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50">
          {isPending ? "Saving…" : instance ? "Save" : "Add"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
