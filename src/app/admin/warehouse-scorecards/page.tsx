"use client";

import { useEffect, useState, useTransition } from "react";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import {
  listOrganizationsForScorecardAssignmentAction,
  listScorecardDefinitionsAction,
  listOrgScorecardAssignmentsAction,
  setOrgWarehousePerformanceModuleAction,
  assignScorecardToOrgAction,
  type OrganizationSummary,
  type ScorecardDefinitionSummary,
  type OrgScorecardAssignment,
} from "./actions";

/**
 * Super-admin-only configuration screen (gated by /admin/layout.tsx's
 * requireSuperAdmin, same as every other /admin/* route): which
 * organisation has the Warehouse Performance module switched on, and which
 * scorecard_definition it's assigned. Deliberately the ONLY place these two
 * decisions are made — no organisation id is hardcoded anywhere in this
 * feature's code (see 0092's own migration comment); this page is that
 * configuration step made real.
 */
export default function WarehouseScorecardsAdminPage() {
  const [orgs, setOrgs] = useState<OrganizationSummary[] | null>(null);
  const [definitions, setDefinitions] = useState<ScorecardDefinitionSummary[] | null>(null);
  const [assignments, setAssignments] = useState<OrgScorecardAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [, startLoad] = useTransition();

  function load() {
    startLoad(async () => {
      const [orgsRes, defsRes, assignmentsRes] = await Promise.all([
        listOrganizationsForScorecardAssignmentAction(),
        listScorecardDefinitionsAction(),
        listOrgScorecardAssignmentsAction(),
      ]);
      if (!orgsRes.ok) {
        setError(orgsRes.error ?? "Unknown error");
        return;
      }
      if (!defsRes.ok) {
        setError(defsRes.error ?? "Unknown error");
        return;
      }
      if (!assignmentsRes.ok) {
        setError(assignmentsRes.error ?? "Unknown error");
        return;
      }
      setError(null);
      setOrgs(orgsRes.data ?? []);
      setDefinitions(defsRes.data ?? []);
      setAssignments(assignmentsRes.data ?? []);
    });
  }

  useEffect(load, []);

  async function handleToggleModule(orgId: string, enabled: boolean) {
    setBusyOrgId(orgId);
    const res = await setOrgWarehousePerformanceModuleAction(orgId, enabled);
    setBusyOrgId(null);
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      return;
    }
    load();
  }

  async function handleAssign(orgId: string, scorecardDefinitionId: string) {
    setBusyOrgId(orgId);
    const res = await assignScorecardToOrgAction(orgId, scorecardDefinitionId, true);
    setBusyOrgId(null);
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      return;
    }
    load();
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <h1 className="text-[22px] font-bold tracking-tight text-slate-900">Warehouse Scorecards</h1>
      <p className="mt-1 max-w-2xl text-sm leading-snug text-slate-500">
        Turn the Warehouse Performance module on for an organization and assign it a scorecard. No organization is
        hardcoded anywhere in this feature — this is the one place that assignment is made.
      </p>

      {error && (
        <div className="mt-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <Panel className="mt-6">
        <PanelTitle>Organizations</PanelTitle>
        {!orgs && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
        {orgs && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 pr-4">Organization</th>
                  <th className="py-1.5 pr-4">Module</th>
                  <th className="py-1.5 pr-4">Assigned scorecard</th>
                  <th className="py-1.5 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => {
                  const assignment = assignments?.find((a) => a.organizationId === org.id && a.enabled);
                  return (
                    <tr key={org.id} className="border-t border-slate-100">
                      <td className="py-1.5 pr-4 font-medium text-slate-900">{org.name}</td>
                      <td className="py-1.5 pr-4">
                        <Badge tone={org.moduleEnabled ? "success" : "neutral"}>{org.moduleEnabled ? "Enabled" : "Disabled"}</Badge>
                      </td>
                      <td className="py-1.5 pr-4 text-slate-600">{assignment?.scorecardName ?? "—"}</td>
                      <td className="py-1.5 pr-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="secondary" loading={busyOrgId === org.id} onClick={() => handleToggleModule(org.id, !org.moduleEnabled)}>
                            {org.moduleEnabled ? "Disable module" : "Enable module"}
                          </Button>
                          {definitions && definitions.length > 0 && (
                            <select
                              className="rounded border border-slate-300 px-2 py-1 text-xs"
                              value={assignment?.scorecardDefinitionId ?? ""}
                              onChange={(e) => e.target.value && handleAssign(org.id, e.target.value)}
                            >
                              <option value="">Assign scorecard…</option>
                              {definitions.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </main>
  );
}
