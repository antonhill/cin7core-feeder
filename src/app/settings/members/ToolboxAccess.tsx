"use client";

import { useState } from "react";
import { MODULES } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { NEWQUIP_NATIVE_MODULE_HREFS, toolboxGrantsOf } from "@/newquip/toolbox-access";
import type { ModuleAuditEntry, TeamMember } from "./actions";

// NewQuip organisation only: one switch per main Toolbox module for one person. Presentational; the Server Action authorises, validates and audits. The NewQuip workspace
// (Grower role, quotations, projects, approvals) is deliberately NOT in this list: it is independent of these switches and a switch can never remove it.

const REGISTRY = MODULES.map((m) => m.href);
export const GRANTABLE_TOOLBOX_MODULES = MODULES.filter((m) => !NEWQUIP_NATIVE_MODULE_HREFS.includes(m.href));

const labelOf = (href: string) => MODULES.find((m) => m.href === href)?.label ?? href;
const listOf = (hrefs: string[] | null) => (hrefs && toolboxGrantsOf(hrefs, REGISTRY).length > 0 ? toolboxGrantsOf(hrefs, REGISTRY).map(labelOf).join(", ") : "none");

export function ToolboxAccessRow({ member, isSelf, isBusy, onSave }: { member: TeamMember; isSelf: boolean; isBusy: boolean; onSave: (userId: string, modules: string[]) => void }) {
  const granted = toolboxGrantsOf(member.allowedModules, REGISTRY);
  const [selected, setSelected] = useState<Set<string>>(new Set(granted));
  const dirty = selected.size !== granted.length || granted.some((h) => !selected.has(h));
  const toggle = (href: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(href)) next.delete(href); else next.add(href); return next; });
  const effective = granted.length > 0 ? `NewQuip workspace + Toolbox: ${granted.map(labelOf).join(", ")}` : "NewQuip workspace only";

  return (
    <div className="mt-4 flex flex-col gap-2 text-sm" data-testid={`toolbox-access-${member.email}`}>
      <p className="text-slate-700">
        <span className="font-medium">Effective access:</span> <span data-testid="toolbox-effective">{effective}</span>
      </p>
      <p className="text-xs text-slate-500">Quotations, projects, approvals and this person&apos;s Grower role are not affected by the switches below.</p>
      <fieldset className="ml-1 flex flex-col gap-1.5" disabled={isSelf}>
        <legend className="mb-1 text-sm font-medium text-slate-900">Main Toolbox modules</legend>
        {GRANTABLE_TOOLBOX_MODULES.map((m) => (
          <Checkbox key={m.href} label={m.label} checked={selected.has(m.href)} onChange={() => toggle(m.href)} />
        ))}
      </fieldset>
      {isSelf && <p className="text-xs text-slate-500" data-testid="toolbox-self-note">You can&apos;t change your own Toolbox access. Ask another administrator.</p>}
      <Button size="sm" disabled={isBusy || isSelf || !dirty} onClick={() => onSave(member.userId, [...selected])} className="mt-1 w-fit">
        Save Toolbox access
      </Button>
    </div>
  );
}

export function ModuleAuditList({ entries }: { entries: ModuleAuditEntry[] }) {
  if (entries.length === 0) return <p className="mt-2 text-sm text-slate-500">No module access changes recorded yet.</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1.5 text-sm" data-testid="module-audit">
      {entries.map((e) => (
        <li key={e.id} className="rounded border border-slate-200 bg-white px-3 py-2">
          <span className="font-medium">{e.targetEmail ?? "A member"}</span>: Toolbox modules {listOf(e.previousModules)} → {listOf(e.newModules)}
          <span className="block text-xs text-slate-500">by {e.actorEmail ?? "an administrator"} · {new Date(e.changedAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
