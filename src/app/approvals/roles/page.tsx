"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { APPROVALS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
import { FUNCTIONAL_ROLES, ROLE_DESCRIPTION, ROLE_LABEL, STAGE_LABEL, type FunctionalRole, type StagePolicy } from "@/lib/approvals/roles";
import { formatSast } from "@/lib/approvals/time";
import { DOC_TYPE_LABEL, type ApprovalDocType } from "@/lib/approvals/types";
import { assignRoleAction, getRolesAdminAction, removeRoleAction, saveApprovalPolicyAction, setStrictRolesAction, type RolesAdminView } from "../role-actions";

// NewQuip roles and approval routing. Roles say what a person does in the quotation / project / approval process; a policy says which role (and which named
// person, if any) decides each stage. Hiding a control here is never the protection: every action re-checks on the server.

const DOC_TYPES: ApprovalDocType[] = ["QUOTE", "CLAIM", "VARIATION"];

export default function RolesPage() {
  const [d, setD] = useState<RolesAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, StagePolicy[]>>({});

  const load = useCallback(() => { getRolesAdminAction().then((r) => { if (r.ok && r.data) { setD(r.data); setDraft(r.data.policies); setError(null); } else setError(r.error ?? "Unable to load"); }); }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true); setNote(null); setError(null);
    const r = await fn(); setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setNote(done); load();
  };
  if (!d) return <main className="mx-auto w-full max-w-[1200px] px-6 py-12"><ModuleHeader module={APPROVALS_MODULE}>Roles and approval routing</ModuleHeader>{error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <p className="mt-6 text-sm text-slate-500">Loading…</p>}</main>;
  const holders = (role: FunctionalRole) => d.users.filter((u) => u.roles.includes(role)).map((u) => u.email);
  const canEdit = d.canAdminister && d.available;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <ModuleHeader module={APPROVALS_MODULE}>Roles and approval routing</ModuleHeader>
      <div className="mt-2"><Link className="text-sm text-slate-700 underline" href="/approvals">Back to Approvals</Link></div>
      {!d.available && <div className="mt-4"><Alert tone="warning">Roles and staged approvals activate once the roles migration (0112) has been applied. Until then approvals use the organisation owner/admin tier, as before.</Alert></div>}
      {!d.canAdminister && d.available && <div className="mt-4"><Alert tone="info">You can view roles and routing. Only an administrator can change them.</Alert></div>}
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      {note && <div className="mt-4"><Alert tone="success">{note}</Alert></div>}

      <Panel className="mt-4">
        <PanelTitle>People and roles</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">One person can hold several roles. Until someone is given an explicit role they keep the organisation-tier behaviour (member = salesperson + estimator, owner/admin = also manager). Once roles are assigned, switch on strict roles so that only explicit roles count.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3">User</th><th className="pr-3">Tier</th>{FUNCTIONAL_ROLES.map((r) => <th key={r} className="px-2" title={ROLE_DESCRIPTION[r]}>{ROLE_LABEL[r]}</th>)}</tr></thead>
            <tbody>
              {d.users.map((u) => (
                <tr key={u.userId} className="border-t border-slate-100">
                  <td className="py-1 pr-3">{u.email}</td><td className="pr-3 text-xs text-slate-500">{u.tier}</td>
                  {FUNCTIONAL_ROLES.map((r) => (
                    <td key={r} className="px-2 text-center">
                      <input type="checkbox" aria-label={`${u.email} ${ROLE_LABEL[r]}`} disabled={!canEdit || busy} checked={u.roles.includes(r)}
                        onChange={(e) => run(() => (e.target.checked ? assignRoleAction(u.userId, r) : removeRoleAction(u.userId, r)), `${e.target.checked ? "Assigned" : "Removed"} ${ROLE_LABEL[r]} for ${u.email}.`)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <Badge tone={d.strict ? "success" : "neutral"}>{d.strict ? "Strict roles ON" : "Strict roles OFF"}</Badge>
          {canEdit && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => setStrictRolesAction(!d.strict), d.strict ? "Strict roles switched off." : "Strict roles switched on.")}>{d.strict ? "Switch off" : "Switch on"}</Button>}
          <span className="text-xs text-slate-500">Strict roles needs at least one Manager and one Estimator assigned.</span>
        </div>
      </Panel>

      {DOC_TYPES.map((t) => (
        <Panel key={t} className="mt-4">
          <PanelTitle>{DOC_TYPE_LABEL[t]} approval</PanelTitle>
          <div className="mt-2 space-y-2">
            {(draft[t] ?? []).map((s, i) => (
              <div key={s.stage} className="grid items-end gap-2 sm:grid-cols-[10rem_1fr_1fr]">
                <div className="text-sm font-medium">{i + 1}. {STAGE_LABEL[s.stage]}</div>
                <Select label="Role" disabled={!canEdit} value={s.role} onChange={(e) => setDraft({ ...draft, [t]: draft[t].map((x, j) => (j === i ? { ...x, role: e.target.value as FunctionalRole, approverEmail: null } : x)) })}>
                  {FUNCTIONAL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </Select>
                <Select label="Named approver (optional)" disabled={!canEdit} value={s.approverEmail ?? ""} onChange={(e) => setDraft({ ...draft, [t]: draft[t].map((x, j) => (j === i ? { ...x, approverEmail: e.target.value || null } : x)) })}>
                  <option value="">Any {ROLE_LABEL[s.role]}</option>
                  {holders(s.role).map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </div>
            ))}
          </div>
          {t === "QUOTE" && <p className="mt-2 text-xs text-slate-500">Rep submits → Estimator signs off → Manager approves. The manager can return a quotation to the estimator; an estimator returns it to the salesperson.</p>}
          {canEdit && <div className="mt-3"><Button size="sm" disabled={busy} onClick={() => run(() => saveApprovalPolicyAction(t, draft[t]), `${DOC_TYPE_LABEL[t]} policy saved.`)}>Save {DOC_TYPE_LABEL[t].toLowerCase()} policy</Button></div>}
        </Panel>
      ))}

      {d.canAdminister && d.history.length > 0 && (
        <Panel className="mt-4">
          <PanelTitle>Role history</PanelTitle>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {d.history.map((h) => <li key={h.id}>{formatSast(h.created_at)} - {h.actor_email} {h.action === "ASSIGNED" ? "assigned" : "removed"} {ROLE_LABEL[h.role as FunctionalRole] ?? h.role} {h.action === "ASSIGNED" ? "to" : "from"} {h.user_email}</li>)}
          </ul>
        </Panel>
      )}
    </main>
  );
}
