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
import { Spinner } from "@/app/Spinner";

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
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">{member.email}</p>
          <p className="text-sm capitalize text-slate-500">{member.role}</p>
        </div>
        <button
          type="button"
          onClick={() => onRemove(member.userId)}
          disabled={isBusy}
          className="shrink-0 rounded-full border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2 font-medium text-slate-700">
          <input type="checkbox" checked={fullAccess} onChange={() => setFullAccess((v) => !v)} className="h-4 w-4" />
          Full access (every module this org allows)
        </label>

        {!fullAccess && (
          <div className="ml-6 flex flex-col gap-1.5">
            {MODULES.map((m) => (
              <label key={m.href} className="flex items-center gap-2 text-slate-600">
                <input type="checkbox" checked={selected.has(m.href)} onChange={() => toggle(m.href)} className="h-4 w-4" />
                {m.label}
              </label>
            ))}
          </div>
        )}

        <button
          type="button"
          disabled={isBusy}
          onClick={() => onSaveModules(member.userId, fullAccess ? null : [...selected])}
          className="mt-1 w-fit rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Save access
        </button>
      </div>
    </div>
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

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Invite a teammate</h2>
        <form onSubmit={handleInvite} className="mt-3 flex flex-wrap gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
            placeholder="teammate@example.com"
            className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={isInviting}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {isInviting && <Spinner className="mr-1.5" />}
            {isInviting ? "Inviting…" : "Send invite"}
          </button>
        </form>
        {inviteError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{inviteError}</p>
        )}
        {inviteSuccess && (
          <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{inviteSuccess}</p>
        )}
      </section>

      {loadError && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
      )}
      {actionError && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>
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
