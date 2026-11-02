"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Status, statusText } from "@/components/ui/Status";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { NEGATIVE_VARIATION_UNSUPPORTED, isNegativeAmountInput } from "@/lib/projects/variations";
import { ConsolidatedReportPanel } from "./ConsolidatedReportPanel";
import { VariationBillingPanel } from "./VariationBillingPanel";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { approveVariationAction, raiseVariationAction, rejectVariationAction, repriceVariationAction, submitVariationForApprovalAction } from "../actions";

// Project VARIATIONS — the only way scope/value changes after acceptance. Generic: nothing here knows about NewQuip.
// original_contract is never edited; only APPROVED variations move the REVISED contract value. Cin7 is represented, never written.

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;

export function VariationsPanel({ view, isAdmin, run, working }: { view: ProjectView; isAdmin: boolean; run: Run; working: boolean }) {
  const c = view.commercial;
  const projectId = view.project.id;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [estCost, setEstCost] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});

  /** The decision controls (or who decided and why) shown INSIDE each variation's record. */
  const decisionOf = (v: ProjectView["variations"][number]) => (
    <div>
                      {v.status === "DRAFT" ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input label="Re-price (R)" value={price[v.id] ?? ""} onChange={(e) => setPrice({ ...price, [v.id]: e.target.value })} placeholder={(v.amount_cents / 100).toString()} />
          <Button size="sm" variant="secondary" disabled={working || !(price[v.id] ?? "").trim()} onClick={() => run(() => repriceVariationAction(projectId, v.id, price[v.id]), `Re-priced ${v.code}.`)}>Re-price</Button>
          <Button size="sm" variant="secondary" disabled={working} onClick={() => run(() => submitVariationForApprovalAction(projectId, v.id), `Submitted ${v.code} for manager approval. It cannot be edited while it is pending.`)}>Submit for approval</Button>
          {isAdmin ? (
            <>
              <Button size="sm" disabled={working} onClick={() => run(() => approveVariationAction(projectId, v.id), `Approved ${v.code}. The revised contract value now includes it; the original is unchanged.`)}>Approve</Button>
              <Input label="Reject reason" value={reason[v.id] ?? ""} onChange={(e) => setReason({ ...reason, [v.id]: e.target.value })} />
              <Button size="sm" variant="destructive" disabled={working || !(reason[v.id] ?? "").trim()} onClick={() => run(() => rejectVariationAction(projectId, v.id, reason[v.id]), `Rejected ${v.code}.`)}>Reject</Button>
            </>
          ) : <span className="text-xs text-slate-600">Manager approval required</span>}
        </div>
      ) : (
        <span className="text-xs text-slate-600">{v.decided_by_email} · {v.decision_reason ?? "approved"}</span>
      )}
      <div className="mt-1"><ApprovalHistory docType="VARIATION" docId={v.id} label="Approval history" /></div>
    </div>
  );
  const rejected = view.variations.filter((v) => v.status === "REJECTED");

  return (
    <div className="mt-6 space-y-5">
      <section aria-label="Variations and the contract value (ex VAT)">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-xl border border-slate-200 bg-white px-5 py-4 sm:grid-cols-3">
          {([["Original contract value", c.originalContractCents, "Never changes"], ["Approved variations", c.approvedVariationsCents, "Draft and rejected variations count for nothing"], ["Revised contract value", c.revisedContractCents, "Original + approved variations"]] as const).map(([k, n, hint]) => (
            <div key={k}>
              <dt className="text-xs font-semibold uppercase tracking-wider text-slate-600">{k}</dt>
              <dd className="mt-1 whitespace-nowrap text-lg font-bold tabular-nums text-slate-900">{formatCents(n)}</dd>
              <p className="text-xs text-slate-600">{hint}</p>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-xs text-slate-600">Post-acceptance material scope changes are always Variations. The estimator raises and prices; the manager approves or rejects. A decision is final.</p>
      </section>

      {view.variations.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">No variations yet.</p>}

      <VariationBillingPanel view={view} isAdmin={isAdmin} run={run} working={working} renderDecision={decisionOf} />

      {rejected.length > 0 && (
        <section aria-label="Rejected variations" className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <p className="font-medium text-slate-900">Rejected ({rejected.length})</p>
          <ul className="mt-1 space-y-1 text-slate-600">
            {rejected.map((v) => <li key={v.id}><span className="font-mono">{v.code}</span> {v.title} · {formatCents(v.amount_cents)} ex VAT · {v.decided_by_email ?? "—"}{v.decision_reason ? ` · ${v.decision_reason}` : ""}<div className="mt-0.5"><ApprovalHistory docType="VARIATION" docId={v.id} label="Approval history" /></div></li>)}
          </ul>
        </section>
      )}

      {view.project.status === "ACTIVE" && (
        <details className="rounded-xl border border-slate-200 bg-white px-5 py-3" open={view.variations.length === 0}>
          <summary className="cursor-pointer py-1.5 text-sm font-semibold text-slate-900">Raise a variation</summary>
          <div className="mt-4 grid gap-4 md:grid-cols-[1fr_2fr_1fr_1fr_auto] md:items-end">
            <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="V001 – Additional Ventilation" />
            <Input label="Scope / description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Input label="Price (R, ex VAT)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="480000" />
            {isAdmin ? <Input label="Est. cost (R, internal)" value={estCost} onChange={(e) => setEstCost(e.target.value)} placeholder="optional" /> : <span />}
            <Button disabled={working || !title.trim() || !amount.trim()} onClick={async () => { if (await run(() => raiseVariationAction(projectId, title, description, amount, estCost), "Variation raised as a DRAFT — the contract value is unchanged until a manager approves it.")) { setTitle(""); setDescription(""); setAmount(""); setEstCost(""); } }}>Raise draft</Button>
          </div>
          {isNegativeAmountInput(amount) && <div className="mt-3"><Alert tone="warning">{NEGATIVE_VARIATION_UNSUPPORTED}</Alert></div>}
        </details>
      )}

      <details className="rounded-xl border border-slate-200 bg-white px-5 py-3">
        <summary className="cursor-pointer py-1.5 text-sm font-semibold text-slate-900">Consolidated report: invoices by scope, and physical products from Cin7</summary>
        <div className="mt-3"><ConsolidatedReportPanel view={view} /></div>
      </details>

      <details className="rounded-xl border border-slate-200 bg-white px-5 py-3">
        <summary className="cursor-pointer py-1.5 text-sm font-semibold text-slate-900">Cin7 planning view (placeholder references, nothing is sent)</summary>
        <div className="mt-3">
        <Alert tone="info">POC only. The intended Cin7 documents are shown for understanding; nothing is created, updated or sent. Production may raise separate Cin7 invoices per commitment under the same Project.</Alert>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <THead><TR><TH>Commitment</TH><TH>Cin7 sale (placeholder)</TH><TH>State</TH><TH align="right">Value (ex VAT)</TH></TR></THead>
            <TBody>
              {view.cin7Representation.map((r) => (
                <TR key={r.saleRef}><TD>{r.label}</TD><TD className="font-mono">{r.saleRef}</TD><TD><Status tone="warning">{statusText(r.state)}</Status></TD><TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(r.valueCents)}</TD></TR>
              ))}
            </TBody>
          </Table>
        </div>
        </div>
      </details>
    </div>
  );
}
