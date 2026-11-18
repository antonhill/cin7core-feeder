import Link from "next/link";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatZarCents } from "@/lib/format-money";
import { claimStatusLabel, type ClaimListRow } from "@/newquip/claims-list";

const TONE: Record<string, BadgeTone> = { draft: "neutral", open: "warning", approved: "success" };

/** Read-only claims list. Each claim links to its project's workspace (Claims tab), where every claim action lives. */
export function ClaimsTable({ rows }: { rows: readonly ClaimListRow[] }) {
  if (rows.length === 0) {
    return <Panel><EmptyState title="No claims yet" description="Claims are prepared inside a project, from its Claims tab, once stages are approved." /></Panel>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead><TR><TH>Project</TH><TH>Customer</TH><TH>Claim</TH><TH>Date</TH><TH>Status</TH><TH align="right">Amount (incl. tax)</TH><TH>Workspace</TH></TR></THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.claimId}>
              <TD className="whitespace-nowrap"><Link className="inline-flex min-h-11 items-center font-medium text-indigo-700 hover:underline" href={`/projects/${r.projectId}`}>{r.projectReference}</Link></TD>
              <TD>{r.customerName || "—"}</TD>
              <TD className="whitespace-nowrap">{r.claimNumber}</TD>
              <TD className="whitespace-nowrap">{r.claimDate}</TD>
              <TD><Status tone={(r.bucket && TONE[r.bucket]) || "neutral"}>{claimStatusLabel(r.status)}</Status></TD>
              <TD align="right" className="whitespace-nowrap tabular-nums">{formatZarCents(r.totalCents)}</TD>
              <TD><Link className="inline-flex min-h-11 items-center text-indigo-700 hover:underline" href={r.href}>Open claims tab</Link></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
