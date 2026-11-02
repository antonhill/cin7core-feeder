"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
import { formatBps, type ProjectView } from "@/lib/projects/project-view";
import { Feedback, type RunFn } from "./feedback-context";
import { listProjectManagerOptionsAction, updateProjectDetailsAction } from "../actions";

// Project details (UAT-029). Reading is for everyone with access; the project manager, start date and target completion date can be edited by an owner/admin only. The
// server re-checks the role and validates the manager against the organisation's users and the dates as real dates; nothing else about the project can be changed here.

export function ProjectDetailsPanel({ view, isAdmin, run, working, editable }: { view: ProjectView; isAdmin: boolean; run: RunFn; working: boolean; editable: boolean }) {
  const project = view.project;
  const [editing, setEditing] = useState(false);
  const [manager, setManager] = useState("");
  const [start, setStart] = useState("");
  const [target, setTarget] = useState("");
  const [people, setPeople] = useState<string[] | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);

  const open = () => {
    setManager(project.project_manager ?? ""); setStart(project.start_date ?? ""); setTarget(project.target_completion_date ?? ""); setEditing(true);
    if (people === null) listProjectManagerOptionsAction().then((r) => { if (r.ok && r.data) { setPeople(r.data); setPeopleError(null); } else setPeopleError(r.error ?? "The list of users could not be loaded."); }).catch(() => setPeopleError("The list of users could not be loaded."));
  };
  const save = async () => {
    const ok = await run(() => updateProjectDetailsAction(project.id, { projectManager: manager || null, startDate: start || null, targetCompletionDate: target || null }), "Project details saved.", "details");
    if (ok) setEditing(false);
  };
  // A manager already on the record who is no longer in the list stays selectable so that saving other fields never silently drops them.
  const options = [...new Set([...(people ?? []), ...(project.project_manager ? [project.project_manager] : [])])].sort();
  const dateOrder = start && target && target < start;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Project details</PanelTitle>
        {isAdmin && editable && !editing && <Button size="sm" variant="secondary" onClick={open} disabled={working}>Edit details</Button>}
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Customer", project.customer_name], ["Project reference", project.project_reference],
          ["Originating quote", project.originating_quote_ref ?? "—"], ["Salesperson", project.salesperson ?? "—"],
          ["Project manager", project.project_manager ?? "Not set"], ["Start date", project.start_date ?? "Not set"],
          ["Target completion", project.target_completion_date ?? "Not set"], ["Status", project.status],
          ["Tax", `${project.tax_rule ?? "—"} (${formatBps(project.tax_rate_bps)})`],
        ].map(([k, v]) => (
          <div key={k}><dt className="text-xs text-slate-600">{k}</dt><dd className="mt-0.5 font-medium text-slate-900">{v}</dd></div>
        ))}
      </dl>
      {editing && (
        <form className="mt-5 space-y-4 border-t border-slate-200 pt-4" onSubmit={(e) => { e.preventDefault(); if (!dateOrder) void save(); }} aria-label="Edit project details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Select label="Project manager" value={manager} onChange={(e) => setManager(e.target.value)} helperText={peopleError ?? (people === null ? "Loading users…" : "Users of this organisation")}>
              <option value="">Not set</option>
              {options.map((e) => <option key={e} value={e}>{e}</option>)}
            </Select>
            <Input label="Start date" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input label="Target completion" type="date" value={target} onChange={(e) => setTarget(e.target.value)} error={dateOrder ? "Cannot be before the start date." : undefined} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={working || !!dateOrder}>Save details</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={working}>Cancel</Button>
          </div>
          <p className="text-xs text-slate-600">Only these three fields can be changed here. The approved quotation, contract value, tax and billing stages are fixed; use a Variation for any change to them.</p>
        </form>
      )}
      <Feedback k="details" />
    </Panel>
  );
}
