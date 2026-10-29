"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { formatSast } from "@/lib/approvals/time";
import type { ApprovalEventRow } from "@/lib/approvals/types";
import { isDemoActorName } from "@/lib/demo-mode/config";

// The append-only approval history as a readable timeline. Every time is the exact SAST timestamp; nothing here can edit history.
const LABEL: Record<string, string> = {
  SUBMITTED: "Submitted", RESUBMITTED: "Resubmitted", ASSIGNED: "Assigned", REASSIGNED: "Reassigned", VIEWED: "First viewed by the approver", APPROVED: "Approved", OVERRIDE_APPROVED: "Approved (administrator override)",
  RETURNED: "Returned for changes", REJECTED: "Rejected", WITHDRAWN: "Withdrawn", SUPERSEDED: "Superseded by a newer revision", REMINDER_SENT: "Reminder sent",
};
const TONE: Record<string, BadgeTone> = { APPROVED: "success", OVERRIDE_APPROVED: "warning", RETURNED: "warning", REJECTED: "danger", WITHDRAWN: "neutral", SUPERSEDED: "neutral" };

export function ApprovalTimeline({ events, empty = "No approval activity yet." }: { events: ApprovalEventRow[]; empty?: string }) {
  if (events.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ol className="space-y-2 border-l border-slate-200 pl-4">
      {events.map((e) => (
        <li key={e.id} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium tabular-nums text-slate-900">{formatSast(e.created_at)}</span>
            <Badge tone={TONE[e.action] ?? "neutral"}>{LABEL[e.action] ?? e.action}</Badge>
            {isDemoActorName(e.actor_name) && <Badge tone="danger">DEMO / IMPERSONATED</Badge>}
            <span className="text-xs text-slate-500">revision {e.revision}{e.stage ? ` · ${e.stage === "ESTIMATOR" ? "estimator stage" : "manager stage"}` : ""}{e.destination ? ` · returned to ${e.destination === "ESTIMATOR" ? "the estimator" : "the preparer"}` : ""} · {e.actor_name ?? e.actor_email}</span>
          </div>
          {e.reason && e.action !== "VIEWED" && <p className="mt-0.5 text-slate-700">{e.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
