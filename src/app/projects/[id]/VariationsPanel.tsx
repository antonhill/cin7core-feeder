"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { NEGATIVE_VARIATION_UNSUPPORTED, isNegativeAmountInput } from "@/lib/projects/variations";
import { ConsolidatedReportPanel } from "./ConsolidatedReportPanel";
import { VariationBillingPanel } from "./VariationBillingPanel";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { approveVariationAction, raiseVariationAction, rejectVariationAction, repriceVariationAction, submitVariationForApprovalAction } from "../actions";

// Project VARIATIONS — the only way scope/value changes after acceptance. Generic: nothing here knows about NewQuip.
// original_contract is never edited; only APPROVED variations move the REVISED contract value. Cin7 is represented, never written.

const TONE: Record<string, BadgeTone> = { DRAFT: "neutral", APPROVED: "success", REJECTED: "danger" };
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

  return (
    <div className="mt-6 space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[["Original contract value", c.originalContractCents, "Never changes"], ["Approved variations", c.approvedVariationsCents, "Draft and rejected variations count for nothing"], ["Revised contract value", c.revisedContractCents, "Original + approved variations"]].map(([k, v, hint]) => (
          <div key={k as string} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{k as string}</p>
            <p className="mt-2 whitespace-nowrap text-2xl font-bold tabular-nums text-slate-900">{formatCents(v as number)}</p>
            <p className="mt-1 text-xs text-slate-500">{hint as string}</p>
          </div>
        ))}
      </div>

      <ConsolidatedReportPanel view={view} />

      <Panel>
        <PanelTitle>Variations</PanelTitle>
        <p className="mt-2 text-xs text-slate-500">Post-acceptance material scope changes are always Variations. The estimator raises and prices; the manager approves or rejects. A decision is final.</p>
        {view.variations.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No variations yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <THead><TR><TH>Code</TH><TH>Title</TH><TH>Status</TH><TH align="right">Amount (ex VAT)</TH><TH>Raised / priced by</TH><TH>Decision</TH></TR></THead>
              <TBody>
                {view.variations.map((v) => (
                  <TR key={v.id}>
                    <TD className="font-mono">{v.code}</TD>
                    <TD><div className="font-medium text-slate-900">{v.title}</div>{v.description && <div className="text-xs text-slate-500">{v.description}</div>}</TD>
                    <TD><Badge tone={TONE[v.status] ?? "neutral"}>{v.status}</Badge></TD>
                    <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(v.amount_cents)}</TD>
                    <TD className="text-xs text-slate-600">{v.raised_by_email}{v.priced_by_email && v.priced_by_email !== v.raised_by_email ? ` / ${v.priced_by_email}` : ""}</TD>
                    <TD>
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
                          ) : <span className="text-xs text-slate-500">Manager approval required</span>}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600">{v.decided_by_email} · {v.decision_reason ?? "approved"}</span>
                      )}
                      <div className="mt-1"><ApprovalHistory docType="VARIATION" docId={v.id} label="Approval history" /></div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Panel>

      {view.project.status === "ACTIVE" && (
        <Panel>
          <PanelTitle>Raise a variation</PanelTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-[1fr_2fr_1fr_1fr_auto] md:items-end">
            <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="V001 – Additional Ventilation" />
            <Input label="Scope / description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Input label="Price (R, ex VAT)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="480000" />
            {isAdmin ? <Input label="Est. cost (R, internal)" value={estCost} onChange={(e) => setEstCost(e.target.value)} placeholder="optional" /> : <span />}
            <Button disabled={working || !title.trim() || !amount.trim()} onClick={async () => { if (await run(() => raiseVariationAction(projectId, title, description, amount, estCost), "Variation raised as a DRAFT — the contract value is unchanged until a manager approves it.")) { setTitle(""); setDescription(""); setAmount(""); setEstCost(""); } }}>Raise draft</Button>
          </div>
          {isNegativeAmountInput(amount) && <div className="mt-3"><Alert tone="warning">{NEGATIVE_VARIATION_UNSUPPORTED}</Alert></div>}
        </Panel>
      )}

      <VariationBillingPanel view={view} isAdmin={isAdmin} run={run} working={working} />

      <Panel>
        <PanelTitle>Cin7 representation — NOT SENT TO CIN7</PanelTitle>
        <Alert tone="info">POC only. The intended Cin7 documents are shown for understanding; nothing is created, updated or sent. Production may raise separate Cin7 invoices per commitment under the same Project.</Alert>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <THead><TR><TH>Commitment</TH><TH>Cin7 sale (placeholder)</TH><TH>State</TH><TH align="right">Value (ex VAT)</TH></TR></THead>
            <TBody>
              {view.cin7Representation.map((r) => (
                <TR key={r.saleRef}><TD>{r.label}</TD><TD className="font-mono">{r.saleRef}</TD><TD><Badge tone="warning">{r.state}</Badge></TD><TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(r.valueCents)}</TD></TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
