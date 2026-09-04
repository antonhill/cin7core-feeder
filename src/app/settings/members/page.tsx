"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listTeamMembersAction,
  inviteTeamMemberAction,
  removeTeamMemberAction,
  setTeamMemberModulesAction,
  type TeamMember,
} from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { TEAM_MEMBERS_MODULE, MODULES } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";
import { Panel, PanelTitle } from "@/components/ui/Panel";

function MemberRow({
  member,
  onRemove,
  onSaveModules,
  isBusy,
}: {
  member: TeamMember;
  onRemove: (userId: string) => void;
  onSaveModules: (userId: string, allowedModules: string[] | null) => void;
  isBusy: boolean;
}) {
  // "Full access" (allowedModules === null) shows no checkboxes at all — a
  // member restricted to a subset gets an explicit array instead. Draft
  // state is local until "Save access" is clicked, same "batch, don't
  // auto-save every click" convention as the Data Audit page's bulk editors.
  const [fullAccess, setFullAccess] = useState(member.allowedModules === null);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.allowedModules ?? MODULES.map((m) => m.href)));

  function toggle(href: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href);
      else next.add(href);
      return next;
    });
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">{member.email}</p>
          <p className="text-sm capitalize text-slate-500">{member.role}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => onRemove(member.userId)} disabled={isBusy}>
          Remove
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-2 text-sm">
        <Checkbox label="Full access (every module this org allows)" checked={fullAccess} onChange={() => setFullAccess((v) => !v)} />

        {!fullAccess && (
          <div className="ml-6 flex flex-col gap-1.5">
            {MODULES.map((m) => (
              <Checkbox key={m.href} label={m.label} checked={selected.has(m.href)} onChange={() => toggle(m.href)} />
            ))}
          </div>
        )}

        <Button
          size="sm"
          disabled={isBusy}
          onClick={() => onSaveModules(member.userId, fullAccess ? null : [...selected])}
          className="mt-1 w-fit"
        >
          Save access
        </Button>
      </div>
    </Panel>
  );
}

export default function TeamMembersPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [isInviting, startInviteTransition] = useTransition();

  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, startActingTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await listTeamMembersAction();
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setMembers(result.members ?? []);
      setLoaded(true);
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteSuccess(null);
    startInviteTransition(async () => {
      const result = await inviteTeamMemberAction(inviteEmail);
      if (!result.ok) {
        setInviteError(result.error ?? "Unknown error");
        return;
      }
      setInviteSuccess(`Invited ${inviteEmail}.`);
      setInviteEmail("");
      refresh();
    });
  }

  function handleRemove(userId: string) {
    if (!confirm("Remove this person from your organization? They keep their account — just this org's access.")) return;
    setActionError(null);
    startActingTransition(async () => {
      const result = await removeTeamMemberAction(userId);
      if (!result.ok) {
        setActionError(result.error ?? "Unknown error");
        return;
      }
      refresh();
    });
  }

  function handleSaveModules(userId: string, allowedModules: string[] | null) {
    setActionError(null);
    startActingTransition(async () => {
      const result = await setTeamMemberModulesAction(userId, allowedModules);
      if (!result.ok) {
        setActionError(result.error ?? "Unknown error");
        return;
      }
      refresh();
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={TEAM_MEMBERS_MODULE}>
        Invite teammates and choose which modules each one can access. An organization-wide disabled module (set by
        Anton on /admin) always stays disabled here too, regardless of what you grant.
      </ModuleHeader>

      <Panel className="mt-6">
        <PanelTitle>Invite a teammate</PanelTitle>
        <form onSubmit={handleInvite} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Input
              type="email"
              label="Email"
              hideLabel
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              placeholder="teammate@example.com"
            />
          </div>
          <Button type="submit" loading={isInviting}>
            {isInviting ? "Inviting…" : "Send invite"}
          </Button>
        </form>
        {inviteError && (
          <div className="mt-3">
            <Alert tone="danger">{inviteError}</Alert>
          </div>
        )}
        {inviteSuccess && (
          <div className="mt-3">
            <Alert tone="success">{inviteSuccess}</Alert>
          </div>
        )}
      </Panel>

      {loadError && (
        <div className="mt-4">
          <Alert tone="danger">{loadError}</Alert>
        </div>
      )}
      {actionError && (
        <div className="mt-4">
          <Alert tone="danger">{actionError}</Alert>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {members.map((m) => (
          <MemberRow key={m.userId} member={m} onRemove={handleRemove} onSaveModules={handleSaveModules} isBusy={isActing} />
        ))}
        {loaded && members.length === 0 && <p className="text-base text-slate-500">No team members yet.</p>}
        {isPending && !loaded && <p className="text-base text-slate-500">Loading…</p>}
      </div>
    </main>
  );
}
