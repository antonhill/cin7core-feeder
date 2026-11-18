"use client";

import { pageContainerClass } from "@/app/PageContainer";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SOLUTION_BUILDER_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/approvals/roles";
import { INVITE_ROLES, inviteInstructions, type InviteRole } from "@/newquip/invite";
import { getTeamAction, inviteNewquipMemberAction, type InviteOutcome, type TeamView } from "../team-actions";

// MANAGER-ONLY: invite a person to NewQuip and choose their role. Every check is repeated on the server; hiding this page is not the protection.
export default function TeamPage() {
  const [view, setView] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("REP");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<InviteOutcome | null>(null);
  const load = useCallback(() => { getTeamAction().then((r) => { if (r.ok && r.data) { setView(r.data); setError(null); } else setError(r.error ?? "Unable to load"); }); }, []);
  useEffect(() => { load(); }, [load]);

  async function invite() {
    setBusy(true); setError(null); setDone(null);
    try { const r = await inviteNewquipMemberAction(email, role); if (r.ok && r.data) { setDone(r.data); setEmail(""); load(); } else setError(r.error ?? "The invitation failed."); }
    catch { setError("We could not confirm the invitation. Check the list below before trying again."); }
    finally { setBusy(false); }
  }
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className={pageContainerClass("form", "compact")}>
      <ModuleHeader variant="workspace" module={SOLUTION_BUILDER_MODULE}>Team and invitations</ModuleHeader>
      <p className="mt-1 text-sm text-slate-700"><Link className="underline" href="/newquip-grower/settings">← Settings</Link></p>
      {error && <Alert tone="danger">{error}</Alert>}
      {view && (
        <div className="mt-4 space-y-6">
          <Panel>
            <PanelTitle>Invite a person</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">They get NewQuip access only, with the one role you choose. No password is set: they sign in at the NewQuip login with a code emailed to them. Two-factor sign-in is required on your account to invite.</p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm text-slate-800">Email<input data-testid="invite-email" type="email" className="mt-1 block h-10 w-72 rounded-md border border-slate-300 px-2" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></label>
              <label className="text-sm text-slate-800">Role<select data-testid="invite-role" className="mt-1 block h-10 rounded-md border border-slate-300 px-2" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>{INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
              <Button type="button" disabled={busy || email.trim() === ""} loading={busy} onClick={() => void invite()}>Invite</Button>
            </div>
            <p className="mt-2 text-xs text-slate-600" data-testid="role-help">{ROLE_DESCRIPTION[role]}</p>
            {done && (
              <Alert tone="success">
                <p data-testid="invite-result">{done.email}: {done.created ? "account created" : "existing account"}, {done.alreadyMember ? "already a NewQuip member" : "added to NewQuip"}, {done.roleAdded ? `${ROLE_LABEL[done.role]} role assigned` : `already held the ${ROLE_LABEL[done.role]} role`}.</p>
                <p className="mt-2 text-xs font-semibold">Send them these instructions:</p>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-white p-2 text-xs" data-testid="invite-instructions">{inviteInstructions(origin, done.email, done.role)}</pre>
              </Alert>
            )}
          </Panel>
          <Panel>
            <PanelTitle>People with NewQuip access</PanelTitle>
            <ul className="mt-2 divide-y rounded-md border border-slate-200 text-sm" data-testid="team-list">
              {view.people.map((p) => <li key={p.email} className="flex flex-wrap justify-between gap-2 p-2"><span>{p.email}</span><span className="text-slate-700">{p.roles.length ? p.roles.join(", ") : "No role assigned"}{p.tier !== "member" ? ` · organisation ${p.tier}` : ""}</span></li>)}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}
