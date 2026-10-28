"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { isP0Disposable } from "@/lib/projects/p0-project";
import type { P0Report } from "@/lib/projects/p0-checklist";
import { CREATE_CONFIRMATION_TEXT } from "@/lib/projects/cin7-sale-creation";
import type { ProjectView } from "@/lib/projects/project-view";
import { VariationProductPicker, type PickedProduct } from "./VariationProductPicker";
import { createCin7SaleAction, getCin7SaleCreationStatusAction, reconcileCin7SaleCreationAction, resolveScopeItemAction, runP0ChecklistAction, type Cin7SaleCreationStatus } from "../cin7-actions";

// Create the project's Cin7 ADVANCED SALE. The physical products come from the project's APPROVED PRODUCT SCOPE (inherited from the quotation,
// or from the variation): nobody types or picks SKUs here. Anything the scope cannot identify as a real Cin7 SKU is listed as a blocker and
// can only be resolved by a manager with a recorded reason (map to a real SKU, or exclude). The server re-checks the rollout flag, the org, the
// manager role, the state and the confirmation, validates the customer and every SKU read-only before storing any intent, and links the Sale
// only after reading it back and verifying it matches the plan exactly.
const TONE: Record<string, BadgeTone> = { PENDING: "warning", CREATED: "warning", RECONCILED: "success", FAILED_CONFIRMED_NO_WRITE: "warning", FAILED_UNCERTAIN: "danger" };

export function Cin7SaleCreationPanel({ view, run, working }: { view: ProjectView; run: (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>; working: boolean }) {
  const projectId = view.project.id;
  const [st, setSt] = useState<Cin7SaleCreationStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A disposable P0 project already knows its customer and location (entered when it was prepared); everything else stays explicit.
  const isP0Project = isP0Disposable(view.project.originating_quote_ref);
  const [customer, setCustomer] = useState(isP0Project ? view.project.customer_name : "");
  const [location, setLocation] = useState(isP0Project ? "MSTR" : "");
  const [account, setAccount] = useState("");
  const [taxRule, setTaxRule] = useState("Standard Rate Sales");
  const [typed, setTyped] = useState("");
  const [p0, setP0] = useState<P0Report | null>(null);
  const [p0Error, setP0Error] = useState<string | null>(null);
  const [p0Busy, setP0Busy] = useState(false);
  const [multi, setMulti] = useState<Record<string, PickedProduct[]>>({});
  const [res, setRes] = useState<Record<string, { sku: string; quantity: string; reason: string }>>({});

  const load = useCallback(() => { getCin7SaleCreationStatusAction(projectId).then((r) => { if (r.ok && r.data) setSt(r.data); }); }, [projectId]);
  useEffect(load, [load]);

  if (!st || !st.gates.orgEnabled) return null;
  const { gates, creation } = st;
  if (st.linked && !creation) return null; // a manually linked Sale: nothing to create
  const after = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    run(async () => { const r = await fn(); if (r.ok) setNote((r.data as { message?: string } | undefined)?.message ?? null); load(); return r; });
  const canCreate = gates.isManager && gates.writesEnabled && !working && !creation && st.blockers.length === 0 && customer.trim() && location.trim() && account.trim() && taxRule.trim() && typed === CREATE_CONFIRMATION_TEXT;
  const unresolved = st.scopeItems.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution);

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Create the Cin7 Advanced Sale</PanelTitle>
        <Badge tone={gates.writesEnabled ? "warning" : "neutral"} dot>{gates.writesEnabled ? "Cin7 writes ENABLED" : "Cin7 writes OFF"}</Badge>
      </div>
      <p className="mt-1 text-sm text-slate-500">Creates ONE Advanced Sale from this project&apos;s approved product scope: the products below at R0, and the approved contract value as Additional Charges (one per billing stage). It is read back and verified before it is linked. No customer, invoice, fulfilment or stock movement is created.</p>
      {note && <div className="mt-3"><Alert tone="info">{note}</Alert></div>}

      <div className="mt-4">
        <p className="text-sm font-medium text-slate-800">Products on the Sales Order (inherited from the approved scope - not typed)</p>
        {st.saleLines.length === 0 ? <p className="mt-1 text-sm text-slate-600">No physical products: a commercial-only Sale.</p> : (
          <ul className="mt-1 space-y-0.5 text-sm">{st.saleLines.map((l) => <li key={l.sku}><span className="font-mono">{l.sku}</span> x {l.quantity} <span className="text-slate-500">- {l.description} (R0)</span></li>)}</ul>
        )}
        {st.excluded.length > 0 && <p className="mt-1 text-xs text-slate-500">Excluded from the Sale by a manager: {st.excluded.map((e) => `${e.description} (${e.reason})`).join("; ")}.</p>}
      </div>

      {unresolved.length > 0 && !creation && (
        <div className="mt-4 space-y-3">
          <Alert tone="warning">The Sale cannot be created yet: {unresolved.length} scope item(s) have no authoritative Cin7 SKU. Nothing is guessed or substituted. A manager resolves each one below, with a reason.</Alert>
          {unresolved.map((i) => {
            const r = res[i.id] ?? { sku: "", quantity: String(i.quantity ?? ""), reason: "" };
            const set = (patch: Partial<typeof r>) => setRes({ ...res, [i.id]: { ...r, ...patch } });
            return (
              <div key={i.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-medium">{i.description} <span className="text-xs font-normal text-slate-500">({i.origin.section ?? "scope"})</span></p>
                <p className="text-xs text-slate-600">{i.mapping.status === "UNMAPPED" ? i.mapping.reason : ""}</p>
                {gates.isManager ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input label="Cin7 SKU" value={r.sku} onChange={(e) => set({ sku: e.target.value })} />
                    <Input label="Quantity" value={r.quantity} onChange={(e) => set({ quantity: e.target.value })} />
                    <Input label="Reason (required)" value={r.reason} onChange={(e) => set({ reason: e.target.value })} />
                    <Button size="sm" disabled={working || !r.sku.trim() || !r.reason.trim()} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "MAP", sku: r.sku, quantity: Number(r.quantity), reason: r.reason }))}>Map to this SKU</Button>
                    <Button size="sm" variant="secondary" disabled={working || !r.reason.trim()} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "EXCLUDE", reason: r.reason }))}>Exclude from the Sale</Button>
                  </div>
                ) : <p className="mt-1 text-xs text-slate-500">A manager resolves this.</p>}
                {gates.isManager ? (
                  <details className="mt-3 rounded border border-slate-200 p-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-800">Map this package to several Cin7 SKUs (with quantity conversion)</summary>
                    <p className="mt-1 text-xs text-slate-500">Search and add each real Cin7 SKU. Enter how many units of that SKU make up ONE quoted unit ({i.unit}); the converted quantity is shown. Mark internal manufacturing inputs as BOM components so they are not put on the Sales Order.</p>
                    <div className="mt-2"><VariationProductPicker picked={multi[i.id] ?? []} onChange={(next) => setMulti({ ...multi, [i.id]: next })} disabled={working} quantityLabel={`SKU units per 1 ${i.unit}`} withRole
                      extra={(p) => (i.quantity ? `= ${Math.round(i.quantity * (Number(p.quantity) || 0) * 1e6) / 1e6} on the order` : "no quoted quantity")} /></div>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Input label="Reason (required)" value={r.reason} onChange={(e) => set({ reason: e.target.value })} />
                      <Button size="sm" disabled={working || !r.reason.trim() || (multi[i.id] ?? []).length === 0} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "MAP_LINES", reason: r.reason, lines: (multi[i.id] ?? []).map((p) => ({ sku: p.sku, factor: Number(p.quantity), unit: i.unit, role: p.role })) }))}>Save multi-SKU mapping</Button>
                    </div>
                  </details>
                ) : <p className="mt-1 text-xs text-slate-500">A manager resolves this.</p>}
              </div>
            );
          })}
        </div>
      )}

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
          <div className="grid gap-3 md:grid-cols-4">
            <Input label="Cin7 customer name (must already exist)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <Input label="Cin7 location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <Input label="Revenue account code" value={account} onChange={(e) => setAccount(e.target.value)} />
            <Input label="Cin7 tax rule name" value={taxRule} onChange={(e) => setTaxRule(e.target.value)} />
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" disabled={p0Busy || working || !gates.isManager} onClick={async () => {
                setP0Busy(true); setP0Error(null);
                const r = await runP0ChecklistAction(projectId, { customerName: customer, location, taxRule, revenueAccount: account, skus: st.saleLines.map((l) => ({ sku: l.sku, quantity: l.quantity })) });
                setP0(r.ok && r.data ? r.data : null); setP0Error(r.ok ? null : r.error ?? "P0 failed to run"); setP0Busy(false);
              }}>{p0Busy ? "Reading Cin7…" : "Run P0 checklist (read-only)"}</Button>
              <span className="text-xs text-slate-500">Reads only. Fails explicitly; never picks a customer, instance or database for you. The VAT rate comes from the project ({(view.project.tax_rate_bps / 100).toFixed(2)}%); the tax rule name is the Cin7 one entered above.</span>
            </div>
            {p0Error && <div className="mt-3"><Alert tone="danger">{p0Error}</Alert></div>}
            {p0 && (
              <div className="mt-3">
                <Alert tone={p0.verdict === "READY_PENDING_MANUAL" ? "info" : "danger"}>{p0.verdict === "READY_PENDING_MANUAL" ? `Automated checks passed (${p0.counts.PASS}); confirm the ${p0.counts.MANUAL} manual items below before P1.` : `NOT READY: ${p0.counts.FAIL} failed, ${p0.counts.NOT_RUN} not run.`}</Alert>
                <ul className="mt-2 space-y-1 text-sm">
                  {p0.checks.map((k) => (
                    <li key={k.id} className="flex gap-2"><Badge tone={k.status === "PASS" ? "success" : k.status === "FAIL" ? "danger" : k.status === "MANUAL" ? "warning" : "neutral"}>{k.status.replace("_", " ")}</Badge><span><span className="font-medium">{k.label}.</span> <span className="text-slate-600">{k.detail}</span></span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <Input label={`Type exactly: ${CREATE_CONFIRMATION_TEXT}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {!gates.writesEnabled && <p className="text-xs text-slate-500">Cin7 writes are switched off on this deployment; the button stays disabled.</p>}
          <Button disabled={!canCreate} onClick={() => after(() => createCin7SaleAction(projectId, { confirmation: typed, customerName: customer, location, revenueAccount: account, cin7TaxRule: taxRule }))}>Create Advanced Sale in Cin7</Button>
        </div>
      )}
    </Panel>
  );
}
