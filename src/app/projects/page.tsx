"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatBps, formatCents, type ProjectView } from "@/lib/projects/project-view";
import { getViewerPermissionsAction, listProjectsAction, seedGoldenProjectAction } from "./actions";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();
  const [isSeeding, startSeeding] = useTransition();

  function load() {
    startLoading(async () => {
      const res = await listProjectsAction();
      if (!res.ok) return setError(res.error ?? "Unknown error");
      setError(null);
      setProjects(res.data ?? []);
    });
  }
  useEffect(load, []);
  // Display only: the fixture action itself re-checks the owner/admin role on the server.
  // Unknown (nothing rendered) until resolved, so the admin button never flashes for a member; failure => no button.
  const [canAdmin, setCanAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    getViewerPermissionsAction().then((r) => setCanAdmin(Boolean(r.ok && r.data?.canApprove)));
  }, []);

  function seed() {
    startSeeding(async () => {
      const res = await seedGoldenProjectAction();
      if (!res.ok) return setError(res.error ?? "Unknown error");
      load();
    });
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <ModuleHeader module={PROJECTS_MODULE}>
        Proof of concept — billing against an agreed contract value by approved stage completion. Local only: nothing on this
        screen creates or changes anything in Cin7.
      </ModuleHeader>

      {error && (
        <div className="mt-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <p className="text-sm text-slate-500">{projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : isLoading ? "Loading…" : ""}</p>
        {canAdmin === true && (
          <Button variant="secondary" size="sm" onClick={seed} loading={isSeeding}>
            Create golden fixture project
          </Button>
        )}
      </div>

      <div className="mt-3">
        {projects && projects.length === 0 && (
          <Panel>
            <EmptyState title="No projects yet" description="Create the golden fixture project (R10m, six stages) to walk the whole flow. Admin role required." />
          </Panel>
        )}
        {projects && projects.length > 0 && (
          <Table>
            <THead>
              <tr>
                <TH>Reference</TH>
                <TH>Customer</TH>
                <TH>Project</TH>
                <TH align="right">Contract (ex VAT)</TH>
                <TH align="right">Approved completion</TH>
                <TH align="right">Invoiced / committed</TH>
                <TH align="right">Currently claimable</TH>
                <TH align="right">Remaining to bill / commit</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {projects.map((p) => (
                <TR key={p.project.id}>
                  <TD>
                    <Link className="font-medium text-indigo-700 hover:underline" href={`/projects/${p.project.id}`}>
                      {p.project.project_reference}
                    </Link>
                  </TD>
                  <TD>{p.project.customer_name}</TD>
                  <TD>{p.project.name}</TD>
                  <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(p.commercial.revisedContractCents)}</TD>
                  <TD align="right" className="tabular-nums">{formatBps(p.commercial.approvedCompletionBps)}</TD>
                  <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(p.commercial.committedCents)}</TD>
                  <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(p.commercial.claimableCents)}</TD>
                  <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(p.commercial.remainingCents)}</TD>
                  <TD>
                    <Badge tone={p.project.status === "ACTIVE" ? "success" : "neutral"}>{p.project.status}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </main>
  );
}
