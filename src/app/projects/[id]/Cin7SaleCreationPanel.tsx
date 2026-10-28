"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { CREATE_CONFIRMATION_TEXT } from "@/lib/projects/cin7-sale-creation";
import type { ProjectView } from "@/lib/projects/project-view";
import { createCin7SaleAction, getCin7SaleCreationStatusAction, reconcileCin7SaleCreationAction, type Cin7SaleCreationStatus } from "../cin7-actions";

// Create the project's Cin7 ADVANCED SALE (physical products at R0 + the approved contract value as Additional Charges). Display + intent only:
// the server re-checks the rollout flag, the org, the manager role, the state and the confirmation, validates the customer and SKUs read-only
// before storing any intent, and links the Sale only after reading it back and verifying it matches the plan exactly.
const TONE: Record<string, BadgeTone> = { PENDING: "warning", CREATED: "warning", RECONCILED: "success", FAILED_CONFIRMED_NO_WRITE: "warning", FAILED_UNCERTAIN: "danger" };
type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;
type Line = { sku: string; name: string; quantity: string };

export function Cin7SaleCreationPanel({ view, run, working }: { view: ProjectView; run: Run; working: boolean }) {
  const projectId = view.project.id;
  const [st, setSt] = useState<Cin7SaleCreationStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [customer, setCustomer] = useState("");
  const [location, setLocation] = useState("");
  const [account, setAccount] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [typed, setTyped] = useState("");

  const load = useCallback(() => { getCin7SaleCreationStatusAction(projectId).then((r) => { if (r.ok && r.data) { setSt(r.data); setLines((cur) => cur ?? r.data!.proposedLines.map((l) => ({ sku: l.sku, name: l.name, quantity: String(l.quantity) }))); } }); }, [projectId]);
  useEffect(load, [load]);

  if (!st || !st.gates.orgEnabled) return null;
  const { gates, creation } = st;
  if (st.linked && !creation) return null; // a manually linked Sale: nothing to create
  const after = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    run(async () => { const r = await fn(); if (r.ok) setNote((r.data as { message?: string } | undefined)?.message ?? null); load(); return r; });
  const rows = lines ?? [];
  const parsed = rows.map((l) => ({ sku: l.sku.trim(), name: l.name.trim(), quantity: Number(l.quantity) }));
  const canCreate = gates.isManager && gates.writesEnabled && !working && !creation && customer.trim() && location.trim() && account.trim() && typed === CREATE_CONFIRMATION_TEXT
    && parsed.every((l) => l.sku && Number.isFinite(l.quantity) && l.quantity > 0);

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Create the Cin7 Advanced Sale</PanelTitle>
        <Badge tone={gates.writesEnabled ? "warning" : "neutral"} dot>{gates.writesEnabled ? "Cin7 writes ENABLED" : "Cin7 writes OFF"}</Badge>
      </div>
      <p className="mt-1 text-sm text-slate-500">Creates ONE Advanced Sale: the physical products below at R0, and the approved contract value as Additional Charges (one per billing stage). It is read back and verified before it is linked. No customer, invoice, fulfilment or stock movement is created.</p>
      {note && <div className="mt-3"><Alert tone="info">{note}</Alert></div>}
      {st.unmappedLines.length > 0 && !creation && <div className="mt-3"><Alert tone="warning">Not on the Sale until mapped to a Cin7 SKU (UNMAPPED_SKU): {st.unmappedLines.join("; ")}. Add them below with a SKU to include them.</Alert></div>}

      {creation ? (
        <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[creation.creation_state] ?? "neutral"}>{creation.creation_state.replace(/_/g, " ")}</Badge>
            <span className="font-mono text-xs text-slate-500">{creation.external_id}</span>{creation.cin7_sale_number && <span>Cin7 {creation.cin7_sale_number}</span>}</div>
          {creation.last_error_message && <Alert tone={creation.creation_state === "FAILED_UNCERTAIN" ? "danger" : "warning"}>{creation.last_error_message}</Alert>}
          {creation.creation_state !== "RECONCILED" && creation.creation_state !== "FAILED_CONFIRMED_NO_WRITE" && (
            <Button size="sm" variant="secondary" disabled={working || !gates.isManager} onClick={() => after(() => reconcileCin7SaleCreationAction(projectId))}>Reconcile with Cin7 (read-only)</Button>
          )}
          {creation.creation_state === "FAILED_UNCERTAIN" && <p className="text-xs text-slate-500">Do not retry. Reconcile first; if a Sale exists but is incomplete, complete or void it in Cin7, or link it with &quot;Link existing Sale&quot;.</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Input label="Cin7 customer name (must already exist)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <Input label="Cin7 location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <Input label="Revenue account code" value={account} onChange={(e) => setAccount(e.target.value)} />
          </div>
          <p className="text-sm font-medium text-slate-800">Physical products (quantity only; always created at R0)</p>
          {rows.map((l, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[10rem_1fr_8rem_auto] md:items-end">
              <Input label="SKU" value={l.sku} onChange={(e) => setLines(rows.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} />
              <Input label="Name" value={l.name} onChange={(e) => setLines(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input label="Quantity" value={l.quantity} onChange={(e) => setLines(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
              <Button size="sm" variant="secondary" disabled={working} onClick={() => setLines(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" disabled={working} onClick={() => setLines([...rows, { sku: "", name: "", quantity: "1" }])}>Add product</Button>
          <Input label={`Type exactly: ${CREATE_CONFIRMATION_TEXT}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {!gates.writesEnabled && <p className="text-xs text-slate-500">Cin7 writes are switched off on this deployment; the button stays disabled.</p>}
          <Button disabled={!canCreate} onClick={() => after(() => createCin7SaleAction(projectId, { confirmation: typed, customerName: customer, location, revenueAccount: account, physicalLines: parsed }))}>Create Advanced Sale in Cin7</Button>
        </div>
      )}
    </Panel>
  );
}
