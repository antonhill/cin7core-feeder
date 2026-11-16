// NewQuip Claims page: pure row builder over the project views the existing project store loads. Read-only; billing figures only (a claim's own totals), never cost,
// margin or supplier values.
import type { ProjectView } from "@/lib/projects/project-view";
import { isCustomerFacingProject } from "@/lib/projects/project-view";
import { claimBucket } from "./dashboard";

export interface ClaimListRow {
  claimId: string;
  projectId: string;
  projectReference: string;
  projectName: string;
  customerName: string;
  claimNumber: string;
  claimSeq: number;
  claimDate: string;
  status: string;
  bucket: "draft" | "open" | "approved" | null;
  totalCents: number;
  /** The project workspace's claims tab. */
  href: string;
}

type Source = Pick<ProjectView, "project" | "claims">;

/** One row per claim across the given projects (customer-facing projects only), newest claim date first, then claim number. */
export function claimListRows(views: readonly Source[]): ClaimListRow[] {
  const rows: ClaimListRow[] = [];
  for (const v of views.filter(isCustomerFacingProject)) {
    for (const c of v.claims) {
      rows.push({
        claimId: c.id, projectId: v.project.id, projectReference: v.project.project_reference, projectName: v.project.name, customerName: v.project.customer_name,
        claimNumber: c.claim_number, claimSeq: c.claim_seq, claimDate: c.claim_date, status: c.status, bucket: claimBucket(c.status), totalCents: c.total_cents,
        href: `/projects/${v.project.id}?tab=claims`,
      });
    }
  }
  return rows.sort((a, b) => (a.claimDate < b.claimDate ? 1 : a.claimDate > b.claimDate ? -1 : b.claimSeq - a.claimSeq));
}

/** "READY_FOR_APPROVAL" -> "Ready for approval". */
export function claimStatusLabel(status: string): string {
  const t = status.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
