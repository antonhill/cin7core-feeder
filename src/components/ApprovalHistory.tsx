"use client";

import Link from "next/link";
import { useState } from "react";
import { ApprovalTimeline } from "@/components/ApprovalTimeline";
import { Badge } from "@/components/ui/Badge";
import { formatSast } from "@/lib/approvals/time";
import { STATUS_LABEL, type ApprovalDocType, type ApprovalEventRow, type ApprovalRequestRow } from "@/lib/approvals/types";
import { getDocumentApprovalAction } from "@/app/approvals/actions";

// "Approval history" for one document, loaded when opened: who holds it, when it was submitted, the decision, and the full append-only timeline.
export function ApprovalHistory({ docType, docId, label = "Approval history" }: { docType: ApprovalDocType; docId: string; label?: string }) {
  const [state, setState] = useState<{ available: boolean; latest: ApprovalRequestRow | null; history: ApprovalEventRow[] } | "loading" | string | null>(null);
  const load = () => {
    setState("loading");
    getDocumentApprovalAction(docType, docId).then((r) => setState(r.ok && r.data ? r.data : (r.error ?? "Could not load the approval history.")));
  };
  return (
    <details className="text-sm" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && state === null) load(); }}>
      <summary className="cursor-pointer text-slate-700">{label}</summary>
      <div className="mt-2">
        {state === "loading" && <p className="text-slate-500">Loading…</p>}
        {typeof state === "string" && state !== "loading" && <p className="text-amber-700">{state}</p>}
        {state && typeof state === "object" && !state.available && <p className="text-slate-500">Approval history is not available yet (database migration pending).</p>}
        {state && typeof state === "object" && state.available && (
          <>
            {state.latest ? (
              <p className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone={state.latest.status === "APPROVED" ? "success" : state.latest.status === "PENDING" || state.latest.status === "RETURNED" ? "warning" : state.latest.status === "REJECTED" ? "danger" : "neutral"}>{STATUS_LABEL[state.latest.status]}</Badge>
                <span>revision {state.latest.revision}, submitted {formatSast(state.latest.submitted_at)} by {state.latest.prepared_by_email}</span>
                {state.latest.status === "PENDING" && <span>· with {state.latest.assigned_to_email ?? "any manager"}</span>}
                <Link className="underline" href={`/approvals/${state.latest.id}`}>Open in Approvals</Link>
              </p>
            ) : <p className="mb-2 text-slate-500">Not submitted for approval yet.</p>}
            <ApprovalTimeline events={state.history} />
          </>
        )}
      </div>
    </details>
  );
}
