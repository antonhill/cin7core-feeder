"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { bpsToPercentText, moveRow, stagesFromInput, type TemplateStageInput } from "@/newquip/quote/project-template";
import {
  createProjectTemplateAction, duplicateProjectTemplateAction, listProjectTemplatesAction, listTemplateVersionsAction, saveProjectTemplateVersionAction,
  setDefaultProjectTemplateAction, setProjectTemplateStatusAction, updateProjectTemplateDetailsAction,
} from "../template-actions";

// NewQuip project (billing milestone) templates. A template only SEEDS the stages of a NEW project; existing projects are never changed by an edit.

type Loaded = NonNullable<Awaited<ReturnType<typeof listProjectTemplatesAction>>["data"]>;
type Template = Loaded["templates"][number];
type Versions = NonNullable<Awaited<ReturnType<typeof listTemplateVersionsAction>>["data"]>;
const blank = (): TemplateStageInput[] => [{ name: "Deposit", percent: "40" }, { name: "Delivery", percent: "55" }, { name: "Installation", percent: "5" }];
const toRows = (t: Template): TemplateStageInput[] => (t.latest?.stages ?? []).map((s) => ({ name: s.name, percent: bpsToPercentText(s.bps), description: s.description, trigger: s.trigger }));

export default function ProjectTemplatesPage() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<TemplateStageInput[]>(blank());
  const [reason, setReason] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [versions, setVersions] = useState<Versions>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { listProjectTemplatesAction().then((r) => (r.ok && r.data ? (setData(r.data), setError(null)) : setError(r.error ?? "Unable to load templates"))); }, []);
  useEffect(load, [load]);

  const check = useMemo(() => stagesFromInput(rows), [rows]);
  const totalText = useMemo(() => rows.reduce((n, r) => { const t = r.percent.trim(); return /^\d{1,3}(\.\d{1,2})?$/.test(t) ? n + Math.round(Number(t) * 100) : n; }, 0), [rows]);
  const current = data?.templates.find((t) => t.id === selected) ?? null;

  const open = (t: Template | "new") => {
    setNote(null); setError(null);
    if (t === "new") { setSelected("new"); setName(""); setDescription(""); setRows(blank()); setReason(""); setMakeDefault(false); setVersions([]); return; }
    setSelected(t.id); setName(t.name); setDescription(t.description); setRows(toRows(t)); setReason(""); setMakeDefault(t.isDefault);
    listTemplateVersionsAction(t.id).then((r) => setVersions(r.ok && r.data ? r.data : []));
  };
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) => {
    setBusy(true); setNote(null); setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setNote(done); load(); after?.();
  };
  const upd = (i: number, patch: Partial<TemplateStageInput>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const canManage = !!data?.canManage;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <ModuleHeader module={QUOTES_MODULE}>Project templates</ModuleHeader>
      <p className="mt-2 text-sm text-slate-600">Reusable billing milestones for new projects. Percentages must total exactly 100%. A project keeps its own copy of the stages it was created with: editing or retiring a template never changes an existing project or an approved quotation.</p>
      <div className="mt-2"><Link className="text-sm text-slate-700 underline" href="/newquip-grower">Back to Solution Builder</Link></div>
      {data?.unavailable && <div className="mt-4"><Alert tone="warning">Project templates activate once the templates database migration (0111) has been applied. Until then new projects use the built-in schedules.</Alert></div>}
      {!canManage && data && !data.unavailable && <div className="mt-4"><Alert tone="info">You can view templates. Only a manager can create or change them.</Alert></div>}
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      {note && <div className="mt-4"><Alert tone="success">{note}</Alert></div>}

      <div className="mt-4 grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Panel>
          <PanelTitle>Templates</PanelTitle>
          <ul className="mt-2 space-y-1">
            {(data?.templates ?? []).map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => open(t)} className={`w-full rounded-md border px-3 py-2 text-left text-sm ${selected === t.id ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                  <span className="font-medium">{t.name}</span> <span className="text-xs text-slate-500">v{t.latest?.version ?? "-"}</span>
                  <span className="ml-1 inline-flex gap-1">{t.isDefault && <Badge tone="info">Default</Badge>}{t.status === "RETIRED" && <Badge tone="neutral">Retired</Badge>}</span>
                </button>
              </li>
            ))}
            {data && data.templates.length === 0 && !data.unavailable && <li className="text-sm text-slate-500">No templates yet.</li>}
          </ul>
          {canManage && !data?.unavailable && <div className="mt-3"><Button size="sm" onClick={() => open("new")}>New template</Button></div>}
        </Panel>

        <Panel>
          {selected === null ? <p className="text-sm text-slate-500">Select a template, or create a new one.</p> : (
            <div className="space-y-3">
              <PanelTitle>{selected === "new" ? "New template" : `${current?.name ?? ""} - edit as a new version`}</PanelTitle>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} />
                <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage} />
              </div>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_6rem_1.4fr_auto] items-end gap-2">
                    <Input label="Stage" hideLabel={i !== 0} value={r.name} onChange={(e) => upd(i, { name: e.target.value })} disabled={!canManage} />
                    <Input label="Percent" hideLabel={i !== 0} value={r.percent} inputMode="decimal" onChange={(e) => upd(i, { percent: e.target.value })} disabled={!canManage} />
                    <Input label="Claim criteria" hideLabel={i !== 0} value={r.trigger ?? ""} onChange={(e) => upd(i, { trigger: e.target.value })} disabled={!canManage} />
                    {canManage && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="secondary" disabled={i === 0} onClick={() => setRows(moveRow(rows, i, -1))}>Up</Button>
                        <Button size="sm" variant="secondary" disabled={i === rows.length - 1} onClick={() => setRows(moveRow(rows, i, 1))}>Down</Button>
                        <Button size="sm" variant="secondary" disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
                      </div>
                    )}
                  </div>
                ))}
                {canManage && <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { name: "", percent: "" }])}>Add stage</Button>}
              </div>
              <div className={`text-sm tabular-nums ${totalText === 10000 ? "text-emerald-700" : "text-red-700"}`}>Total: {(totalText / 100).toFixed(2)}%</div>
              {!check.ok && <Alert tone="danger">{check.errors.join(" ")}</Alert>}
              {canManage && (
                <div className="space-y-2">
                  {selected !== "new" && <Input label="Reason for this change" value={reason} onChange={(e) => setReason(e.target.value)} />}
                  {selected === "new" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Make this the default template</label>}
                  <div className="flex flex-wrap gap-2">
                    {selected === "new" ? (
                      <Button disabled={busy || !check.ok || !name.trim()} onClick={() => run(async () => { const r = await createProjectTemplateAction({ name, description, stages: rows, makeDefault }); if (r.ok && r.data) setSelected(r.data.id); return r; }, "Template created.")}>Create template</Button>
                    ) : (
                      <>
                        <Button disabled={busy || !check.ok || !reason.trim()} onClick={() => run(() => saveProjectTemplateVersionAction(selected!, rows, reason), "Saved as a new version. Existing projects are unchanged.", () => open({ ...(current as Template) }))}>Save new version</Button>
                        <Button variant="secondary" disabled={busy || !name.trim()} onClick={() => run(() => updateProjectTemplateDetailsAction(selected!, name, description), "Details updated.")}>Save name and description</Button>
                        <Button variant="secondary" disabled={busy} onClick={() => { const n = window.prompt("Name for the copy", `${name} (copy)`); if (n) run(async () => { const r = await duplicateProjectTemplateAction(selected!, n); if (r.ok && r.data) setSelected(r.data.id); return r; }, "Template duplicated."); }}>Duplicate</Button>
                        {current?.status === "ACTIVE" ? (
                          <>
                            {!current.isDefault && <Button variant="secondary" disabled={busy} onClick={() => run(() => setDefaultProjectTemplateAction(selected!), "Default template set.")}>Make default</Button>}
                            {current.isDefault && <Button variant="secondary" disabled={busy} onClick={() => run(() => setDefaultProjectTemplateAction(null), "Default cleared.")}>Clear default</Button>}
                            <Button variant="secondary" disabled={busy} onClick={() => run(() => setProjectTemplateStatusAction(selected!, "RETIRED"), "Template retired. Existing projects are unchanged.")}>Retire</Button>
                          </>
                        ) : <Button variant="secondary" disabled={busy} onClick={() => run(() => setProjectTemplateStatusAction(selected!, "ACTIVE"), "Template activated.")}>Activate</Button>}
                      </>
                    )}
                  </div>
                </div>
              )}
              {versions.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Version history</div>
                  <ul className="mt-1 space-y-1 text-sm text-slate-700">
                    {versions.map((v) => <li key={v.id}>v{v.version} - {v.stages.map((s) => `${s.name} ${bpsToPercentText(s.bps)}%`).join(" / ")} <span className="text-xs text-slate-500">({v.createdByEmail}, {new Date(v.createdAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST: {v.reason})</span></li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
