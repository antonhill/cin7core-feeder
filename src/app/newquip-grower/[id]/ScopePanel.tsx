"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { QuoteScopeView } from "@/lib/newquip-quotes/scope-preview";
import type { PackageMapping } from "@/lib/projects/package-mapping-store";
import { VariationProductPicker, type PickedProduct } from "@/app/projects/[id]/VariationProductPicker";
import { getMappingHistoryAction, getQuoteScopeAction, saveReusableMappingAction } from "../mapping-actions";

// INTERNAL physical scope of the quotation: which Cin7 products each package expands to, with the reusable mappings already applied. Missing
// mappings are shown as warnings (never silently dropped) and never block commercial approval; once approved the register is frozen with the mapping
// versions it used. Managers map a package ONCE here (searchable Cin7 selector); every later quotation picks it up automatically.
const TONE: Record<string, BadgeTone> = { MAPPED: "success", FROM_LIBRARY: "success", RESOLVED_ON_PROJECT: "success", UNRESOLVED: "warning", EXCLUDED: "neutral" };
const LABEL: Record<string, string> = { MAPPED: "Mapped", FROM_LIBRARY: "Reusable mapping", RESOLVED_ON_PROJECT: "Resolved", UNRESOLVED: "No mapping yet", EXCLUDED: "Excluded" };

export function ScopePanel({ quoteId, draft }: { quoteId: string; draft: QuoteDraft }) {
  const [view, setView] = useState<(QuoteScopeView & { canManageMappings: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedProduct[]>([]);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<PackageMapping[] | null>(null);
  const draftKey = JSON.stringify(draft);

  const load = useCallback(() => {
    getQuoteScopeAction(quoteId, JSON.parse(draftKey) as QuoteDraft).then((r) => { if (r.ok && r.data) { setView(r.data); setError(null); } else setError(r.error ?? "Could not load the scope."); });
  }, [quoteId, draftKey]);
  useEffect(() => { const t = setTimeout(load, 400); return () => clearTimeout(t); }, [load]);

  if (error) return <Panel><PanelTitle>Physical scope (internal)</PanelTitle><div className="mt-2"><Alert tone="warning">{error}</Alert></div></Panel>;
  if (!view) return <Panel><PanelTitle>Physical scope (internal)</PanelTitle><p className="mt-2 text-sm text-slate-500">Loading…</p></Panel>;

  const start = async (key: string) => {
    setOpen(key); setPicked([]); setReason(""); setHistory(null);
    const h = await getMappingHistoryAction(key);
    if (h.ok && h.data) setHistory(h.data.versions);
  };
  const save = async (key: string, unit: string) => {
    setBusy(true);
    const r = await saveReusableMappingAction(key, picked.map((p) => ({ sku: p.sku, factor: Number(p.quantity), unit, role: p.role })), reason);
    setBusy(false);
    if (r.ok && r.data) { setNote(`Saved ${key} v${r.data.version}. It applies to quotations from now on; approved quotations keep what they were sealed with.`); setOpen(null); load(); } else setError(r.error ?? "Could not save the mapping.");
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PanelTitle>Physical scope (internal)</PanelTitle>
        {view.frozen ? <Badge tone="neutral">Frozen at approval</Badge> : view.unresolvedCount > 0 ? <Badge tone="warning">{view.unresolvedCount} without a mapping</Badge> : <Badge tone="success">All mapped</Badge>}
      </div>
      <p className="mt-1 text-xs text-slate-500">The Cin7 products this quotation needs, from the reusable package mappings. Customer prices and margins are unaffected. A missing mapping does not stop approval, but the Cin7 Sale cannot be created until it is resolved.</p>
      {note && <div className="mt-2"><Alert tone="info">{note}</Alert></div>}
      {view.warnings.map((w) => <div key={w} className="mt-2"><Alert tone="warning">{w}</Alert></div>)}
      <ul className="mt-3 space-y-2 text-sm">
        {view.items.map((i) => (
          <li key={i.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">{i.description}{i.quantity != null && <span className="font-normal text-slate-500"> × {i.quantity} {i.unit}</span>}</span>
              <Badge tone={TONE[i.state]}>{LABEL[i.state]}{i.mappingRef ? ` v${i.mappingRef.version}` : ""}</Badge>
            </div>
            {i.lines.length > 0 && <ul className="mt-1 text-xs text-slate-600">{i.lines.map((l) => <li key={l.sku}><span className="font-mono">{l.sku}</span> × {l.quantity} {l.role === "BOM_COMPONENT" ? <span className="text-slate-400">(internal component, not on the Sales Order)</span> : null}</li>)}</ul>}
            {i.state === "UNRESOLVED" && <p className="mt-1 text-xs text-amber-700">{i.reason}</p>}
            {i.state === "EXCLUDED" && <p className="mt-1 text-xs text-slate-500">Excluded: {i.reason}</p>}
            {i.state === "UNRESOLVED" && !view.frozen && (view.canManageMappings ? (
              open === i.packageKey ? (
                <div className="mt-3 space-y-2 rounded border border-slate-200 p-3">
                  <p className="text-xs text-slate-500">Search and add each real Cin7 SKU. Enter how many units of that SKU make up ONE {i.unit} of this package; the converted quantity is shown. Mark internal manufacturing inputs as components so they are not sold twice.</p>
                  <VariationProductPicker picked={picked} onChange={setPicked} disabled={busy} quantityLabel={`SKU units per 1 ${i.unit}`} withRole
                    extra={(p) => (i.quantity ? `= ${Math.round(i.quantity * (Number(p.quantity) || 0) * 1e6) / 1e6} on this quotation` : "no quoted quantity")} />
                  <Input label="Reason (required, kept in the audit history)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  {history && history.length > 0 && <p className="text-xs text-slate-500">Earlier versions: {history.map((h) => `v${h.version} (${h.created_by_email})`).join(", ")}.</p>}
                  <div className="flex gap-2">
                    <Button size="sm" loading={busy} disabled={busy || picked.length === 0 || !reason.trim() || picked.some((p) => !(Number(p.quantity) > 0))} onClick={() => save(i.packageKey, i.unit)}>Save reusable mapping</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              ) : <div className="mt-2"><Button size="sm" variant="secondary" onClick={() => start(i.packageKey)}>Map this package to Cin7 SKUs</Button></div>
            ) : <p className="mt-1 text-xs text-slate-500">A manager can map this package.</p>)}
          </li>
        ))}
        {view.items.length === 0 && <li className="text-slate-500">No physical products yet.</li>}
      </ul>
      {view.saleLines.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="text-xs font-medium text-slate-700">Will go on the Cin7 Sales Order at R0</p>
          <ul className="mt-1 text-xs text-slate-600">{view.saleLines.map((l) => <li key={l.sku}><span className="font-mono">{l.sku}</span> × {l.quantity}</li>)}</ul>
        </div>
      )}
    </Panel>
  );
}
