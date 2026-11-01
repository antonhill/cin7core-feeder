"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { POST_CONFIRMATION_TEXT, canReconcile, canSend, memoFor, type PostingDisplayState } from "@/lib/projects/cin7-posting";
import { clearSelection, populateEligible, selectAllEligible, selectionToQuantities, toggleLine, visibleLines } from "@/lib/projects/invoice-selection";
import type { PreparedInvoice } from "@/lib/projects/invoice-proposal-store";
import { getCin7PostingStatusAction, recoverLinkCin7SaleAction, getInvoiceProposalAction, postClaimToCin7Action, reconcileClaimPostingAction, type Cin7PostingStatus } from "../cin7-actions";

// Cin7 Core: link the Project to ONE Advanced Sale, then post each APPROVED claim as ONE invoice. Everything here is display + intent:
// the server re-checks the rollout flag, the org, the manager role, the claim state and the confirmation on every call.

const TONE: Record<PostingDisplayState, BadgeTone> = { NOT_SENT: "neutral", PENDING: "warning", CREATED: "success", RECONCILED: "success", FAILED_CONFIRMED_NO_WRITE: "warning", FAILED_UNCERTAIN: "danger" };
const LABEL: Record<PostingDisplayState, string> = {
  NOT_SENT: "NOT SENT", PENDING: "PENDING", CREATED: "CREATED IN CIN7", RECONCILED: "RECONCILED", FAILED_CONFIRMED_NO_WRITE: "FAILED — NO INVOICE CREATED", FAILED_UNCERTAIN: "OUTCOME UNCERTAIN",
};
type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;

export function Cin7PostingPanel({ view, run, working }: { view: ProjectView; run: Run; working: boolean }) {
  const projectId = view.project.id;
  const [st, setSt] = useState<Cin7PostingStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Administrative recovery only (collapsed, admin-only): never part of the normal flow.
  const [rec, setRec] = useState({ saleId: "", customerName: view.project.customer_name ?? "", location: "", revenueAccount: "", cin7TaxRule: "Standard Rate Sales", reason: "" });
  const [confirming, setConfirming] = useState<string | null>(null);
  // Proposed invoice per claim (prepared automatically when the manager opens the claim for posting; "Populate Products from Project" refreshes it).
  const [prep, setPrep] = useState<Record<string, { busy: boolean; error?: string; data?: PreparedInvoice }>>({});
  const [qty, setQty] = useState<Record<string, Record<string, string>>>({});
  const [early, setEarly] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [onlySelected, setOnlySelected] = useState<Record<string, boolean>>({});
  const selOf = (claimId: string) => ({ selected: new Set(picked[claimId] ?? []), qty: qty[claimId] ?? {} });
  const applySel = (claimId: string, s: { selected: ReadonlySet<string>; qty: Readonly<Record<string, string>> }) => { setPicked((m) => ({ ...m, [claimId]: [...s.selected] })); setQty((q) => ({ ...q, [claimId]: { ...s.qty } })); };
  const populate = async (claimId: string) => {
    setPrep((p) => ({ ...p, [claimId]: { busy: true } }));
    const r = await getInvoiceProposalAction(projectId, claimId);
    setPrep((p) => ({ ...p, [claimId]: r.ok && r.data ? { busy: false, data: r.data } : { busy: false, error: r.error ?? "Could not prepare the invoice" } }));
    if (r.ok && r.data) applySel(claimId, selectAllEligible(r.data.proposal.lines));
  };

  const load = useCallback(() => { getCin7PostingStatusAction(projectId).then((r) => r.ok && r.data && setSt(r.data)); }, [projectId]);
  useEffect(load, [load, view.claims.length, view.claims.map((c) => c.status).join()]);

  if (!st || !st.gates.orgEnabled) return null; // the Cin7 posting capability is rolled out per organization
  const { gates, link, postings } = st;
  const approved = view.claims.filter((c) => c.status === "APPROVED");
  const stateOf = (claimId: string): PostingDisplayState => (postings.find((p) => p.claim_id === claimId)?.posting_state ?? "NOT_SENT") as PostingDisplayState;
  const after = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    run(async () => { const r = await fn(); if (r.ok) setNote((r.data as { message?: string } | undefined)?.message ?? null); load(); return r; });

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Cin7 Core</PanelTitle>
        <Badge tone={gates.writesEnabled ? "warning" : "neutral"} dot>{gates.writesEnabled ? "Cin7 writes ENABLED" : "Cin7 writes OFF"}</Badge>
      </div>
      <p className="mt-1 text-sm text-slate-500">One Project → one Cin7 Advanced Sale (created automatically) → one invoice per approved claim. Posting creates a DRAFT commercial invoice with no stock lines (no fulfilment, stock or COGS).</p>
      {note && <div className="mt-3"><Alert tone="info">{note}</Alert></div>}

      <div className="mt-4 rounded-lg border border-slate-200 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-slate-900">Cin7 Advanced Sale</p>
          {link && <Badge tone="success" dot>{st.linkOrigin === "ADMIN_RECOVERY" ? "Linked by administrator recovery" : "Created and verified by the Toolbox"}</Badge>}
        </div>
        {link ? (
          <dl className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-4">
            {[["Sale", link.cin7_sale_number ?? "—"], ["Status", link.link_status === "LINKED" ? "Linked" : link.link_status], ["Linked", new Date(link.created_at).toLocaleDateString("en-ZA")], ["Last reconciled", link.last_reconciled_at ? new Date(link.last_reconciled_at).toLocaleString("en-ZA") : "—"]].map(([k, v]) => (
              <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900">{v}</dd></div>
            ))}
          </dl>
        ) : <p className="mt-1 text-slate-600">No Cin7 Sale yet. Use <strong>Create the Cin7 Advanced Sale</strong> above: the products and charges come from the approved quotation, and the Sale is read back, verified and linked automatically.</p>}
        {!link && gates.isManager && (
          <details className="mt-3 rounded border border-amber-200 bg-amber-50/40 p-3">
            <summary className="cursor-pointer text-xs font-medium text-amber-800">Administrative recovery: attach a Sale that already exists in Cin7</summary>
            <p className="mt-2 text-xs text-slate-600">Only for a Sale the automatic creation could not finish linking. It reads the Sale live and links it ONLY if it is this project&apos;s own Sale (ExternalID, customer, products and totals all match the project). Another project&apos;s Sale, or any mismatch, is refused. A reason is required and the attempt is audited. Nothing is written to Cin7.</p>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {([["saleId", "Cin7 SaleID"], ["customerName", "Cin7 customer name"], ["location", "Cin7 location"], ["revenueAccount", "Revenue account code"], ["cin7TaxRule", "Cin7 tax rule name"]] as const).map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1"><span className="text-xs text-slate-600">{label}</span><input value={rec[k]} onChange={(e) => setRec({ ...rec, [k]: e.target.value })} className="h-9 rounded-md border border-slate-300 px-3 text-sm" /></label>
              ))}
              <label className="flex flex-col gap-1 md:col-span-3"><span className="text-xs text-slate-600">Reason for recovery (required, audited)</span><input value={rec.reason} onChange={(e) => setRec({ ...rec, reason: e.target.value })} className="h-9 rounded-md border border-slate-300 px-3 text-sm" /></label>
            </div>
            <div className="mt-2"><Button size="sm" variant="secondary" loading={working} disabled={Object.values(rec).some((v) => !v.trim())} onClick={() => after(() => recoverLinkCin7SaleAction(projectId, rec))}>Verify and link this Sale</Button></div>
          </details>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {approved.length === 0 && <p className="text-sm text-slate-600">No approved claims to post yet.</p>}
        {approved.map((c) => {
          const state = stateOf(c.id);
          const p = postings.find((x) => x.claim_id === c.id);
          const memo = memoFor(view.project.project_reference, c.claim_number);
          return (
            <div key={c.id} className="rounded-lg border border-slate-200 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-900">{c.claim_number}</div>
                <Badge tone={TONE[state]}>{LABEL[state]}</Badge>
              </div>
              <dl className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-4">
                {[["Sale", link?.cin7_sale_number ?? "not linked"], ["Ex VAT", formatCents(c.subtotal_cents)], ["VAT", formatCents(c.tax_cents)], ["Total", formatCents(c.total_cents)]].map(([k, v]) => (
                  <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="whitespace-nowrap font-medium tabular-nums text-slate-900">{v}</dd></div>
                ))}
              </dl>
              {(state === "CREATED" || state === "RECONCILED") && p && (
                <p className="mt-2 text-slate-700">Created in Cin7: invoice <strong>{p.cin7_invoice_number}</strong> ({p.cin7_status}) · {p.completed_at ? new Date(p.completed_at).toLocaleString("en-ZA") : ""} · {state === "RECONCILED" ? "reconciled" : "not yet reconciled"}</p>
              )}
              {p?.last_error_message && <div className="mt-2"><Alert tone={state === "FAILED_UNCERTAIN" || p.last_error_code === "AMOUNT_MISMATCH" ? "danger" : "warning"}>{p.last_error_message}</Alert></div>}
              {state === "FAILED_UNCERTAIN" && <div className="mt-2"><Alert tone="danger">The request outcome is uncertain. Do not retry until Cin7 has been reconciled.</Alert></div>}

              <div className="mt-3 flex flex-wrap gap-2">
                {canSend(state) && gates.isManager && link && (
                  <Button size="sm" variant="secondary" disabled={working || !gates.writesEnabled} onClick={() => { const open = confirming === c.id; setConfirming(open ? null : c.id); if (!open) void populate(c.id); }}>{state === "NOT_SENT" ? "Prepare and post claim to Cin7" : "Retry (confirmed no invoice)"}</Button>
                )}
                {canReconcile(state) && gates.isManager && <Button size="sm" variant="secondary" loading={working} onClick={() => after(() => reconcileClaimPostingAction(projectId, c.id))}>Reconcile with Cin7 (read-only)</Button>}
                {canSend(state) && !gates.writesEnabled && <span className="self-center text-xs text-slate-500">Cin7 writes are switched off.</span>}
                {!gates.isManager && <span className="self-center text-xs text-slate-500">Only a manager can post to Cin7.</span>}
              </div>

              {confirming === c.id && link && (
                <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
                  <p className="font-semibold text-amber-900">Proposed invoice — review, then confirm. This creates a real invoice in Cin7.</p>
                  {(() => {
                    const pr = prep[c.id];
                    if (!pr || pr.busy) return <p className="mt-2 text-sm text-slate-600">Populating products from the project and Cin7…</p>;
                    if (pr.error || !pr.data) return <div className="mt-2"><Alert tone="danger">{pr.error}</Alert></div>;
                    const pp = pr.data.proposal;
                    const over = pp.lines.some((l) => (Number(qty[c.id]?.[l.sku]) || 0) > (l.eligible ?? 0));
                    return (
                      <div className="mt-2 space-y-3 text-sm">
                        <div className="flex flex-wrap items-center gap-3">
                          <Button size="sm" variant="secondary" disabled={working} onClick={() => populate(c.id)}>Populate Products from Project</Button>
                          <span className="text-xs text-slate-600">Prepared {new Date(pr.data.preparedAt).toLocaleTimeString()} from Cin7 (shipments, invoices) and the approved scope. A proposal only: nothing is posted until you confirm.</span>
                        </div>
                        <div>
                          <p className="font-medium text-slate-900">Commercial charges (carry the whole invoice value)</p>
                          <ul className="mt-1">{pp.charges.map((ch) => <li key={ch.stageName} className="flex justify-between gap-6"><span>{ch.stageName}</span><span className="tabular-nums">{formatCents(ch.amountCents)} + VAT {formatCents(ch.taxCents)}</span></li>)}
                            <li className="flex justify-between gap-6 border-t border-amber-200 pt-1 font-semibold"><span>Invoice total</span><span className="tabular-nums">{formatCents(pp.totalCents)}</span></li></ul>
                        </div>
                        <div>
                          <p className="font-medium text-slate-900">Physical product lines (always R0; quantity only)</p>
                          {pp.lines.length > 1 && (
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                              <Button size="sm" variant="secondary" disabled={working} onClick={() => applySel(c.id, selectAllEligible(pp.lines))}>Select all eligible</Button>
                              <Button size="sm" variant="secondary" disabled={working} onClick={() => applySel(c.id, populateEligible(pp.lines, selOf(c.id)))}>Populate eligible quantities</Button>
                              <Button size="sm" variant="ghost" disabled={working} onClick={() => applySel(c.id, clearSelection(pp.lines))}>Clear selection</Button>
                              <label className="flex items-center gap-1"><input type="checkbox" checked={!!onlySelected[c.id]} onChange={(e) => setOnlySelected((m) => ({ ...m, [c.id]: e.target.checked }))} /> Show selected only</label>
                              <span className="text-slate-600">{selOf(c.id).selected.size} of {pp.lines.length} selected</span>
                            </div>
                          )}
                          {pp.lines.length === 0 ? <p className="text-slate-600">The Cin7 Sale has no product lines.</p> : (
                            <table className="mt-1 min-w-full text-xs">
                              <thead><tr className="text-left text-slate-500"><th className="pr-3">SKU</th><th className="pr-3 text-right">Ordered</th><th className="pr-3 text-right">Invoiced</th><th className="pr-3 text-right">Shipped</th><th className="pr-3 text-right">Remaining</th><th className="pr-3 text-right">Eligible</th><th className="pr-3">Invoice qty</th><th>Why</th></tr></thead>
                              <tbody>{visibleLines(pp.lines, selOf(c.id), !!onlySelected[c.id]).map((l) => (
                                <tr key={l.sku} className="align-top"><td className="pr-3 font-mono"><label className="flex items-center gap-1"><input type="checkbox" aria-label={`Select ${l.sku}`} disabled={l.status === "UNKNOWN" || l.status === "EXCLUDED"} checked={(picked[c.id] ?? []).includes(l.sku)} onChange={(e) => applySel(c.id, toggleLine(pp.lines, selOf(c.id), l.sku, e.target.checked))} />{l.sku}</label></td>
                                  {[l.ordered, l.invoiced, l.shipped, l.remainingToInvoice, l.eligible].map((v, i) => <td key={i} className="pr-3 text-right tabular-nums">{v === null ? "?" : v}</td>)}
                                  <td className="pr-3"><input aria-label={`Invoice quantity for ${l.sku}`} className="h-7 w-20 rounded border border-slate-300 px-2 tabular-nums" value={qty[c.id]?.[l.sku] ?? "0"} disabled={l.status === "UNKNOWN"} onChange={(e) => { const cur = selOf(c.id); const sel = new Set(cur.selected); if (Number(e.target.value) > 0) sel.add(l.sku); else sel.delete(l.sku); applySel(c.id, { selected: sel, qty: { ...cur.qty, [l.sku]: e.target.value } }); }} /></td>
                                  <td className="text-slate-600">{l.reasons.join(" ") || (l.status === "PROPOSED" ? "Dispatched and not yet invoiced." : "")}</td></tr>
                              ))}</tbody>
                            </table>
                          )}
                          {pp.notes.map((n) => <p key={n} className="mt-1 text-xs text-slate-600">{n}</p>)}
                          {pr.data.scopeBlockers.length > 0 && <p className="mt-1 text-xs text-amber-800">Scope items still unresolved: {pr.data.scopeBlockers.join(" | ")}</p>}
                          {over && (
                            <label className="mt-2 flex flex-col gap-1"><span className="text-xs font-medium text-amber-900">A quantity above what has been dispatched needs a reason (contractual early invoicing)</span>
                              <input className="h-8 rounded border border-slate-300 px-2" value={early[c.id] ?? ""} onChange={(e) => setEarly((m) => ({ ...m, [c.id]: e.target.value }))} /></label>
                          )}

                        </div>
                      </div>
                    );
                  })()}
                  <dl className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-2">
                    {[["Project", `${view.project.project_reference} — ${view.project.name}`], ["Claim", c.claim_number], ["Cin7 Sale", link.cin7_sale_number ?? link.cin7_sale_id], ["Memo / reference", memo], ["Ex VAT", formatCents(c.subtotal_cents)], ["VAT", formatCents(c.tax_cents)], ["Total", formatCents(c.total_cents)]].map(([k, v]) => (
                      <div key={k}><dt className="text-xs text-amber-800">{k}</dt><dd className="break-all font-medium text-slate-900">{v}</dd></div>
                    ))}
                  </dl>
                  <div className="mt-3 flex gap-2">
                    <Button loading={working} onClick={() => after(() => postClaimToCin7Action(projectId, c.id, POST_CONFIRMATION_TEXT, { lines: selectionToQuantities(prep[c.id]?.data?.proposal.lines ?? [], selOf(c.id)), earlyReason: early[c.id] })).then(() => setConfirming(null))}>{POST_CONFIRMATION_TEXT}</Button>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
