"use client";

import { useId, useState } from "react";
import { ActionFeedback, useKeyedActions } from "@/components/ui/action-feedback";
import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DisabledReason } from "./DisabledReason";
import { formatSast } from "@/lib/approvals/time";
import type { PostingRow } from "@/lib/projects/cin7-posting-store";
import { statusLabel, type InvoiceVerification, type VerifyOutcome } from "@/lib/projects/invoice-verification";
import type { ProjectView } from "@/lib/projects/project-view";
import { OUTCOME_TEXT, postingsSignature } from "@/lib/projects/invoice-authorisation";
import { verifyInvoiceStatusesAction } from "../cin7-actions";
import { useHasInvoiceVerificationProvider, useInvoiceVerification } from "./invoice-verification-context";

// UAT-028. Every invoice Toolbox posted, with the status it RECORDED (when the invoice was created or last reconciled - not live) next to the status Cin7 reports NOW,
// which is only filled in when an owner/admin presses Verify. One Sale read covers all invoices. Nothing is saved: the posting record and its evidence are untouched, and
// opening a Project never reads Cin7.

const OUTCOME: Record<VerifyOutcome, { tone: BadgeTone; text: string }> = OUTCOME_TEXT;

export function InvoiceStatusSection({ view, postings, projectId, isManager }: { view: ProjectView; postings: ReadonlyArray<PostingRow>; projectId: string; isManager: boolean }) {
  const uid = useId(); // ids are unique per mounted workspace: several can be on one page (embedded per variation, hidden-but-mounted)
  const acts = useKeyedActions();
  // The result is shared through the workspace's InvoiceVerificationProvider (UX-006g1) so the Claims card, posting panel and Overview can say what was verified and when.
  // Without a provider (a stand-alone section) it keeps it locally. Either way it lives in memory only.
  const shared = useInvoiceVerification();
  const hasShared = useHasInvoiceVerificationProvider();
  const [verified, setVerified] = useState<{ result: InvoiceVerification; signature: string } | null>(null);
  const rows = postings.filter((p) => (p.posting_state === "CREATED" || p.posting_state === "RECONCILED") && !!p.cin7_invoice_number);
  const unresolved = postings.filter((p) => p.posting_state === "PENDING" || p.posting_state === "FAILED_UNCERTAIN").length;
  if (rows.length === 0 && unresolved === 0) return null;
  // A verification describes the postings as they were when Cin7 was read. If any posting has changed since (a reconcile, a new invoice), it is no longer shown as current.
  const signature = postingsSignature(postings);
  const current = hasShared ? shared.verification : verified && verified.signature === signature ? verified.result : null;
  const stale = hasShared ? shared.stale : !!verified && !current;
  const claimNo = (claimId: string) => view.claims.find((c) => c.id === claimId)?.claim_number ?? "—";
  const byPosting = new Map((current?.invoices ?? []).map((i) => [i.postingId, i]));

  const verify = () => void acts.run("verify", async () => {
    const readFor = signature; // what the postings looked like when this read was asked for
    let r;
    try { r = await verifyInvoiceStatusesAction(projectId); } catch (e) { shared.fail(e instanceof Error ? e.message : "Cin7 could not be read", readFor); throw e; }
    if (r.ok && r.data) { setVerified({ result: r.data, signature: readFor }); shared.set(r.data, readFor); } else shared.fail(r.error ?? "Cin7 could not be read", readFor);
    return r;
  }, {
    pending: "Reading the Sales Order from Cin7…",
    success: (r) => {
      const d = (r as { data?: InvoiceVerification }).data;
      const changed = d?.invoices.filter((i) => i.outcome !== "SAME").length ?? 0;
      const notices = (d?.unresolvedPostings ?? 0) > 0 || (d?.unaccounted.length ?? 0) > 0 ? " See the notices below." : "";
      return (changed === 0 ? "Verified against Cin7: the invoices listed match what was recorded." : `Verified against Cin7: ${changed} invoice${changed === 1 ? "" : "s"} differ${changed === 1 ? "s" : ""} from what was recorded.`) + notices;
    },
  });

  return (
    <section className="mt-4 rounded-lg border border-slate-200 p-4 text-sm" aria-label="Invoices in Cin7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">Invoices in Cin7</p>
          <p className="text-xs text-slate-600">&ldquo;Recorded&rdquo; is what Toolbox saw when the invoice was created or last reconciled. It is not live. Verify reads Cin7 once and compares; nothing is changed or saved.</p>
        </div>
        {isManager
          ? <Button size="sm" variant="secondary" className="min-h-11" onClick={verify} loading={acts.isPending("verify")} disabled={acts.anyPending} aria-describedby={acts.anyPending ? `${uid}-verify-reason` : undefined}>Verify invoice statuses</Button>
          : <span className="text-xs text-slate-600">An owner or admin can verify these against Cin7.</span>}
      </div>
      {isManager && acts.anyPending && <DisabledReason id={`${uid}-verify-reason`} className="mt-1">Verify is disabled while the Cin7 read is in progress.</DisabledReason>}
      <ActionFeedback state={acts.stateOf("verify")} />
      {rows.length > 0 && <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left">
          <thead><tr className="text-xs text-slate-600"><th scope="col" className="py-1 pr-3 font-medium">Claim</th><th scope="col" className="py-1 pr-3 font-medium">Invoice</th><th scope="col" className="py-1 pr-3 font-medium">Recorded in Toolbox</th><th scope="col" className="py-1 font-medium">Cin7 now</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const v = byPosting.get(p.id);
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-900">{claimNo(p.claim_id)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{p.cin7_invoice_number}</td>
                  <td className="py-2 pr-3">{statusLabel(p.cin7_status ? p.cin7_status.toUpperCase() : null)}{p.posting_state === "RECONCILED" && <span className="ml-1 text-xs text-slate-600">· reconciled</span>}</td>
                  <td className="py-2" data-testid={`now-${p.cin7_invoice_number}`}>
                    {v ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{statusLabel(v.currentStatus)}</span>
                        <Status tone={OUTCOME[v.outcome].tone}>{OUTCOME[v.outcome].text}</Status>
                      </span>
                    ) : <span className="text-slate-600">Not verified</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
      {current && <p className="mt-2 text-xs text-slate-600" data-testid="verified-at">Verified against Cin7 {current.saleNumber ? `Sales Order ${current.saleNumber} ` : ""}at {formatSast(current.verifiedAt)}.</p>}
      {stale && <p className="mt-2 text-xs text-amber-700" data-testid="verified-stale">The invoices changed since the last verification, so it is no longer shown. Verify again.</p>}
      {unresolved > 0 && (
        <div className="mt-2"><Alert tone="warning">{unresolved} invoice posting{unresolved === 1 ? " is" : "s are"} still unresolved (pending or outcome uncertain). An invoice may already exist in Cin7 for {unresolved === 1 ? "it" : "them"}: reconcile the claim before posting again.</Alert></div>
      )}
      {current && current.unaccounted.length > 0 && (
        <div className="mt-2"><Alert tone={current.unresolvedPostings > 0 ? "warning" : "info"}>The Sales Order also has {current.unaccounted.length} invoice{current.unaccounted.length === 1 ? "" : "s"} not matched to a recorded posting ({current.unaccounted.map((u) => u.invoiceNumber ?? "unnumbered").join(", ")}).{current.unresolvedPostings > 0 ? " Because a posting is unresolved, one of these may be its invoice: reconcile that claim, do not post it again." : " For example an invoice raised by hand in Cin7. Information only."}</Alert></div>
      )}
    </section>
  );
}
