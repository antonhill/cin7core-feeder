"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { ProjectView } from "@/lib/projects/project-view";
import { allocKey } from "@/lib/projects/delivery-allocation";
import {
  confirmMilestoneAction, createDeliveryAction, getDeliveryRegisterAction, setAllocationAction, setDeliveryStatusAction,
  type DeliveryActionResult,
} from "../delivery-actions";

// DELIVERY ALLOCATION: a plan for which products belong to which delivery, so each delivery's progress invoice proposes them even while goods are
// still being loaded. It is NOT a Cin7 stock reservation and NOT a shipment - picking, packing and shipping stay in Cin7. Managers only.
type Loaded = NonNullable<Awaited<ReturnType<typeof getDeliveryRegisterAction>>["data"]>;
const q = (n: number | null) => (n === null ? "?" : String(n));

/** `section` chooses which part of this logistics/commercial pair is shown: the delivery plan (Deliveries tab) or the milestone evidence (Commercial / Claims tab). */
export type AllocationSection = "deliveries" | "milestones" | "both";
export function DeliveryAllocationPanel({ view, section = "both" }: { view: ProjectView; section?: AllocationSection }) {
  const projectId = view.project.id;
  const [data, setData] = useState<Loaded | null>(null);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(""); const [date, setDate] = useState("");
  const [delivery, setDelivery] = useState(""); const [sku, setSku] = useState(""); const [qty, setQty] = useState(""); const [reason, setReason] = useState("");
  const [stageId, setStageId] = useState(""); const [note, setNote] = useState(""); const [evidence, setEvidence] = useState("");

  const load = useCallback(async () => {
    const r = await getDeliveryRegisterAction(projectId);
    if (r.ok && r.data) setData(r.data); else setMsg({ tone: "danger", text: r.error ?? "Could not load deliveries." });
  }, [projectId]);
  // The milestone list on the Commercial / Claims tab must not look empty until someone presses Load: it loads itself.
  useEffect(() => { if (section === "milestones") void load(); }, [section, load]);

  const run = async (fn: () => Promise<DeliveryActionResult<unknown>>, ok: string) => {
    setBusy(true); setMsg(null);
    const r = await fn();
    setMsg(r.ok ? { tone: "success", text: ok } : { tone: "danger", text: r.error ?? "Failed." });
    if (r.ok) await load();
    setBusy(false);
  };

  const reg = data?.register;
  const live = reg?.deliveries.filter((d) => d.status !== "CANCELLED") ?? [];
  return (
    <div className="mt-6 space-y-6">
      {section !== "milestones" && <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3"><PanelTitle>Delivery allocation</PanelTitle><Button size="sm" variant="secondary" disabled={busy} onClick={() => { setBusy(true); void load().finally(() => setBusy(false)); }}>{data ? "Refresh" : "Load deliveries"}</Button></div>
        <p className="mt-1 text-xs text-slate-500">Deliveries are a logistics plan: which products go on which delivery. An allocation is a plan for invoicing only - it does not reserve stock in Cin7 and does not ship anything. It can never exceed the approved (or ordered) quantity. &quot;?&quot; means unknown, never zero.</p>
        {msg && <div className="mt-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
        {reg && reg.positions.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <THead><TR><TH>SKU</TH><TH align="right">Quoted</TH><TH align="right">Allocated</TH><TH align="right">Unallocated</TH><TH align="right">Allocated, not invoiced</TH></TR></THead>
              <TBody>{reg.positions.map((p) => (
                <TR key={p.sku}>
                  <TD><div className="font-mono">{p.sku}</div><div className="text-xs text-slate-500">{p.description}</div>{p.warnings.map((w, i) => <div key={i} className="text-xs text-amber-700">{w}</div>)}</TD>
                  <TD align="right" className="tabular-nums">{p.quoted}</TD><TD align="right" className="tabular-nums">{p.allocated}</TD>
                  <TD align="right" className="tabular-nums">{q(p.unallocated)}</TD><TD align="right" className="tabular-nums">{p.allocatedNotInvoiced}</TD>
                </TR>))}</TBody>
            </Table>
          </div>
        )}
        {reg?.deliveries.map((d) => {
          const rows = reg.allocations.filter((a) => a.deliveryId === d.id);
          return (
            <div key={d.id} className="mt-4 rounded border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-slate-900">{d.label}</p><Badge tone={d.status === "CANCELLED" ? "neutral" : "warning"}>{d.status}</Badge>
                {d.planned_date && <span className="text-sm text-slate-600">planned {d.planned_date}</span>}
                {d.status !== "CANCELLED" && d.status !== "DISPATCHED" && (
                  <span className="ml-auto flex gap-2">
                    {d.status === "PLANNED" && <Button size="sm" variant="secondary" disabled={busy || !reason.trim()} onClick={() => run(() => setDeliveryStatusAction(projectId, d.id, "LOADING", reason), "Marked loading.")}>Loading</Button>}
                    <Button size="sm" variant="secondary" disabled={busy || !reason.trim()} onClick={() => run(() => setDeliveryStatusAction(projectId, d.id, "DISPATCHED", reason), "Marked dispatched.")}>Dispatched</Button>
                    <Button size="sm" variant="secondary" disabled={busy || !reason.trim()} onClick={() => run(() => setDeliveryStatusAction(projectId, d.id, "CANCELLED", reason), "Delivery cancelled; its allocations were released.")}>Cancel</Button>
                  </span>
                )}
              </div>
              {rows.length === 0 ? <p className="mt-1 text-sm text-slate-600">Nothing allocated.</p> : (
                <ul className="mt-1 text-sm">{rows.map((a) => <li key={a.sku} className="tabular-nums"><span className="font-mono">{a.sku}</span> × {a.quantity}{(reg.invoicedAgainstDelivery[allocKey(d.id, a.sku)] ?? 0) > 0 ? ` (invoiced ${reg.invoicedAgainstDelivery[allocKey(d.id, a.sku)]})` : ""}</li>)}</ul>
              )}
            </div>
          );
        })}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Input label="New delivery" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Delivery 1 - first trucks" />
          <Input label="Planned date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div className="flex items-end"><Button disabled={busy || !label.trim()} onClick={() => run(() => createDeliveryAction(projectId, label, date || undefined), "Delivery planned.").then(() => setLabel(""))}>Plan delivery</Button></div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Select label="Delivery" value={delivery} onChange={(e) => setDelivery(e.target.value)}><option value="">Select…</option>{live.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</Select>
          <Select label="Product" value={sku} onChange={(e) => setSku(e.target.value)}><option value="">Select…</option>{reg?.positions.map((p) => <option key={p.sku} value={p.sku}>{p.sku} (unallocated {p.unallocated})</option>)}</Select>
          <Input label="Quantity on this delivery (0 removes)" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
          <Input label="Reason (required for every change)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="mt-3"><Button disabled={busy || !delivery || !sku || qty.trim() === "" || !reason.trim()} onClick={() => run(() => setAllocationAction(projectId, delivery, sku, Number(qty), reason), "Allocation saved and audited.")}>Save allocation</Button></div>
      </Panel>}

      {section !== "deliveries" && <Panel>
        <PanelTitle>Commercial milestone confirmation</PanelTitle>
        {section === "milestones" && msg && <div className="mt-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
        <p className="mt-1 text-xs text-slate-500">A manager records that a commercial milestone has been met (for example &quot;about 90% delivered&quot; or &quot;installation accepted&quot;) with its supporting evidence. This is independent of reported physical progress.</p>
        {data?.confirmations.length ? <ul className="mt-2 text-sm">{data.confirmations.map((c) => <li key={c.id}>{view.stages.find((s) => s.id === c.stage_id)?.name ?? "Stage"}: {c.note}{c.evidence_ref ? ` [${c.evidence_ref}]` : ""} - {c.confirmed_by_email}, {new Date(c.confirmed_at).toLocaleDateString()}</li>)}</ul> : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Select label="Milestone" value={stageId} onChange={(e) => setStageId(e.target.value)}><option value="">Select…</option>{view.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Input label="What was confirmed" value={note} onChange={(e) => setNote(e.target.value)} />
          <Input label="Evidence reference (POD, certificate…)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </div>
        <div className="mt-3"><Button disabled={busy || !stageId || !note.trim()} onClick={() => run(() => confirmMilestoneAction(projectId, stageId, note, evidence || undefined), "Milestone confirmation recorded.").then(() => { setNote(""); setEvidence(""); })}>Record confirmation</Button></div>
      </Panel>}
    </div>
  );
}
