"use client";

import { useState } from "react";
import { ActionFeedback, useKeyedActions } from "@/components/ui/action-feedback";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import type { PostingRow } from "@/lib/projects/cin7-posting-store";
import { statusLabel, type InvoiceVerification, type VerifyOutcome } from "@/lib/projects/invoice-verification";
import type { ProjectView } from "@/lib/projects/project-view";
import { verifyInvoiceStatusesAction } from "../cin7-actions";

// UAT-028. Every invoice Toolbox posted, with the status it RECORDED (when the invoice was created or last reconciled - not live) next to the status Cin7 reports NOW,
// which is only filled in when an owner/admin presses Verify. One Sale read covers all invoices. Nothing is saved: the posting record and its evidence are untouched, and
// opening a Project never reads Cin7.

const OUTCOME: Record<VerifyOutcome, { tone: BadgeTone; text: string }> = {
  SAME: { tone: "success", text: "Matches" },
  CHANGED: { tone: "warning", text: "Changed in Cin7" },
  NOT_IN_SALE: { tone: "danger", text: "Not found on the Sale" },
  IDENTITY_MISMATCH: { tone: "danger", text: "Different Cin7 invoice" },
  STATUS_UNREADABLE: { tone: "warning", text: "Status not given" },
};

export function InvoiceStatusSection({ view, postings, projectId, isManager }: { view: ProjectView; postings: ReadonlyArray<PostingRow>; projectId: string; isManager: boolean }) {
  const acts = useKeyedActions();
  const [verified, setVerified] = useState<InvoiceVerification | null>(null);
  const rows = postings.filter((p) => (p.posting_state === "CREATED" || p.posting_state === "RECONCILED") && !!p.cin7_invoice_number);
  if (rows.length === 0) return null;
  const claimNo = (claimId: string) => view.claims.find((c) => c.id === claimId)?.claim_number ?? "—";
  const byPosting = new Map((verified?.invoices ?? []).map((i) => [i.postingId, i]));

  const verify = () => void acts.run("verify", async () => {
    const r = await verifyInvoiceStatusesAction(projectId);
    if (r.ok && r.data) setVerified(r.data);
    return r;
  }, {
    pending: "Reading the Sales Order from Cin7…",
    success: (r) => {
      const d = (r as { data?: InvoiceVerification }).data;
      const changed = d?.invoices.filter((i) => i.outcome !== "SAME").length ?? 0;
      return changed === 0 ? "Verified against Cin7: every invoice matches what was recorded." : `Verified against Cin7: ${changed} invoice${changed === 1 ? "" : "s"} differ${changed === 1 ? "s" : ""} from what was recorded.`;
    },
  });

  return (
    <section className="mt-4 rounded-lg border border-slate-200 p-4 text-sm" aria-label="Invoices in Cin7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">Invoices in Cin7</p>
          <p className="text-xs text-slate-500">&ldquo;Recorded&rdquo; is what Toolbox saw when the invoice was created or last reconciled. It is not live. Verify reads Cin7 once and compares; nothing is changed or saved.</p>
        </div>
        {isManager
          ? <Button size="sm" variant="secondary" onClick={verify} loading={acts.isPending("verify")} disabled={acts.anyPending}>Verify invoice statuses</Button>
          : <span className="text-xs text-slate-500">An owner or admin can verify these against Cin7.</span>}
      </div>
      <ActionFeedback state={acts.stateOf("verify")} />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left">
          <thead><tr className="text-xs text-slate-500"><th className="py-1 pr-3 font-medium">Claim</th><th className="py-1 pr-3 font-medium">Invoice</th><th className="py-1 pr-3 font-medium">Recorded in Toolbox</th><th className="py-1 font-medium">Cin7 now</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const v = byPosting.get(p.id);
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-900">{claimNo(p.claim_id)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{p.cin7_invoice_number}</td>
                  <td className="py-2 pr-3">{statusLabel(p.cin7_status ? p.cin7_status.toUpperCase() : null)}{p.posting_state === "RECONCILED" && <span className="ml-1 text-xs text-slate-500">· reconciled</span>}</td>
                  <td className="py-2" data-testid={`now-${p.cin7_invoice_number}`}>
                    {v ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{statusLabel(v.currentStatus)}</span>
                        <Badge tone={OUTCOME[v.outcome].tone}>{OUTCOME[v.outcome].text}</Badge>
                      </span>
                    ) : <span className="text-slate-500">Not verified</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {verified && <p className="mt-2 text-xs text-slate-500" data-testid="verified-at">Verified against Cin7 {verified.saleNumber ? `Sales Order ${verified.saleNumber} ` : ""}at {formatSast(verified.verifiedAt)}.</p>}
      {verified && verified.unaccounted.length > 0 && (
        <div className="mt-2"><Alert tone="info">The Sales Order also has {verified.unaccounted.length} invoice{verified.unaccounted.length === 1 ? "" : "s"} that Toolbox did not create ({verified.unaccounted.map((u) => u.invoiceNumber ?? "unnumbered").join(", ")}). They are shown for information only.</Alert></div>
      )}
    </section>
  );
}
