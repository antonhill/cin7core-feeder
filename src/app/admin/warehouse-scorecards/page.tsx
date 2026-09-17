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
  listOrganizationInstancesAction,
  setOrgWarehousePerformanceModuleAction,
  assignScorecardToOrgAction,
  type OrganizationSummary,
  type ScorecardDefinitionSummary,
  type OrgScorecardAssignment,
  type InstanceSummary,
} from "./actions";

/**
 * Super-admin-only configuration screen (gated by /admin/layout.tsx's
 * requireSuperAdmin, same as every other /admin/* route): which
 * organisation has the Warehouse Performance module switched on, which
 * scorecard_definition it's assigned, and which of that org's Cin7
 * instances the scorecard's automated evidence is scoped to. Instance
 * scoping matters whenever one Toolbox organisation spans more than one
 * real business — confirmed live: "I-Light and LBL" is one organisation
 * with two instances, "Lights by Linea" and "I-Light" — leaving scoping
 * unset would silently mix both businesses' orders into one scorecard.
 * No organisation id is hardcoded anywhere in this feature's code (see
 * 0092's own migration comment); this page is that configuration step
 * made real.
 */
export default function WarehouseScorecardsAdminPage() {
  const [orgs, setOrgs] = useState<OrganizationSummary[] | null>(null);
  const [definitions, setDefinitions] = useState<ScorecardDefinitionSummary[] | null>(null);
  const [assignments, setAssignments] = useState<OrgScorecardAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [, startLoad] = useTransition();

  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);
  const [orgInstances, setOrgInstances] = useState<InstanceSummary[] | null>(null);
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);

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

  async function handleExpandInstances(org: OrganizationSummary, assignment: OrgScorecardAssignment | undefined) {
    if (expandedOrgId === org.id) {
      setExpandedOrgId(null);
      return;
    }
    setExpandedOrgId(org.id);
    setOrgInstances(null);
    setInstancesError(null);
    setSelectedInstanceIds(assignment?.instanceIds ?? []);
    const res = await listOrganizationInstancesAction(org.id);
    if (!res.ok) {
      setInstancesError(res.error ?? "Unknown error");
      return;
    }
    setOrgInstances(res.data ?? []);
  }

  function toggleInstance(id: string) {
    setSelectedInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSaveInstanceScope(org: OrganizationSummary, assignment: OrgScorecardAssignment | undefined) {
    if (!assignment) return;
    setBusyOrgId(org.id);
    const res = await assignScorecardToOrgAction(org.id, assignment.scorecardDefinitionId, true, selectedInstanceIds);
    setBusyOrgId(null);
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      return;
    }
    setExpandedOrgId(null);
    load();
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <h1 className="text-[22px] font-bold tracking-tight text-slate-900">Warehouse Scorecards</h1>
      <p className="mt-1 max-w-2xl text-sm leading-snug text-slate-500">
        Turn the Warehouse Performance module on for an organization, assign it a scorecard, and — for an
        organization with more than one connected Cin7 instance — scope the scorecard to the specific instance(s) it
        should measure. No organization is hardcoded anywhere in this feature; this is the one place these
        assignments are made.
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
                  <th className="py-1.5 pr-4">Instances</th>
                  <th className="py-1.5 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => {
                  const assignment = assignments?.find((a) => a.organizationId === org.id && a.enabled);
                  const isExpanded = expandedOrgId === org.id;
                  return (
                    <>
                      <tr key={org.id} className="border-t border-slate-100">
                        <td className="py-1.5 pr-4 font-medium text-slate-900">{org.name}</td>
                        <td className="py-1.5 pr-4">
                          <Badge tone={org.moduleEnabled ? "success" : "neutral"}>{org.moduleEnabled ? "Enabled" : "Disabled"}</Badge>
                        </td>
                        <td className="py-1.5 pr-4 text-slate-600">{assignment?.scorecardName ?? "—"}</td>
                        <td className="py-1.5 pr-4">
                          {assignment ? (
                            <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => handleExpandInstances(org, assignment)}>
                              {assignment.instanceIds ? `${assignment.instanceIds.length} instance${assignment.instanceIds.length === 1 ? "" : "s"}` : "All instances"}
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
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
                      {isExpanded && (
                        <tr className="border-t border-slate-100 bg-slate-50">
                          <td colSpan={5} className="px-3 py-3">
                            <p className="text-xs font-medium text-slate-600">
                              Scope &ldquo;{assignment?.scorecardName}&rdquo; to specific instances for {org.name} — leave everything unchecked for
                              &ldquo;all instances&rdquo; (the default, correct only when this organization has exactly one real business behind it).
                            </p>
                            {instancesError && (
                              <div className="mt-2">
                                <Alert tone="danger">{instancesError}</Alert>
                              </div>
                            )}
                            {!orgInstances && !instancesError && <p className="mt-2 text-xs text-slate-500">Loading instances…</p>}
                            {orgInstances && orgInstances.length === 0 && <p className="mt-2 text-xs text-slate-500">No connected instances.</p>}
                            {orgInstances && orgInstances.length > 0 && (
                              <div className="mt-2 flex flex-col gap-1.5">
                                {orgInstances.map((inst) => (
                                  <label key={inst.id} className="flex items-center gap-2 text-xs text-slate-700">
                                    <input type="checkbox" checked={selectedInstanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} />
                                    {inst.name}
                                  </label>
                                ))}
                                <div className="mt-2">
                                  <Button size="sm" loading={busyOrgId === org.id} onClick={() => handleSaveInstanceScope(org, assignment)}>
                                    Save scope
                                  </Button>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
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
