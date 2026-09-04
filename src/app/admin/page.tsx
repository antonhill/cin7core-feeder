"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createOrgAndInvite,
  deleteOrganization,
  inviteMemberToOrg,
  listOrgsForAdmin,
  removeMemberFromOrg,
  setOrgDisabledModules,
  uploadOrgLogo,
  type OrgSummary,
} from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { ADMIN_MODULE, MODULES } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";
import { isEligibleForTrialAutoDeletion, trialAutoDeletionDate } from "@/lib/trial-expiry";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

/** Small status badge: trial countdown (or "past grace, will auto-delete soon"), or the plain subscription status once an org has converted. */
function SubscriptionBadge({ status, trialEndsAt }: { status: string; trialEndsAt: string | null }) {
  if (status !== "trialing") {
    const tone: BadgeTone = status === "active" ? "success" : status === "past_due" ? "warning" : "neutral";
    return <Badge tone={tone}>{status}</Badge>;
  }

  if (!trialEndsAt) return <Badge tone="neutral">trialing</Badge>;

  const now = new Date();
  const eligible = isEligibleForTrialAutoDeletion(status, trialEndsAt, now);
  if (eligible) {
    return <Badge tone="danger">trial expired — eligible for auto-delete</Badge>;
  }

  const trialEnd = new Date(trialEndsAt);
  if (trialEnd.getTime() > now.getTime()) {
    const daysLeft = Math.ceil((trialEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return (
      <Badge tone="primary">
        trial · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
      </Badge>
    );
  }

  const deleteDate = trialAutoDeletionDate(trialEndsAt);
  const daysUntilDelete = Math.ceil((deleteDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return (
    <Badge tone="warning">
      trial ended · auto-deletes in {daysUntilDelete} day{daysUntilDelete === 1 ? "" : "s"}
    </Badge>
  );
}

export default function AdminPage() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [isSubmitting, startSubmitTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await listOrgsForAdmin();
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setOrgs(result.orgs ?? []);
      setLoaded(true);
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    startSubmitTransition(async () => {
      const result = await createOrgAndInvite(orgName, email);
      if (!result.ok) {
        setFormError(result.error ?? "Unknown error");
        return;
      }
      setFormSuccess(`Invited ${email} to "${orgName}".`);
      setOrgName("");
      setEmail("");
      refresh();
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={ADMIN_MODULE}>Every organization using Cin7 Core Toolbox.</ModuleHeader>

      <Panel className="mt-10">
        <h2 className="text-base font-semibold text-slate-900">Create org &amp; invite first user</h2>
        <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-4">
          <Input
            label="Organization name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            required
            placeholder="Casa das Natas"
          />
          <Input
            type="email"
            label="First user's email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="owner@casadasnatas.com"
          />
          <Button type="submit" loading={isSubmitting} className="self-start">
            {isSubmitting ? "Creating…" : "Create org & send invite"}
          </Button>
          {formError && <Alert tone="danger">{formError}</Alert>}
          {formSuccess && <Alert tone="success">{formSuccess}</Alert>}
        </form>
      </Panel>

      <section className="mt-10">
        <h2 className="text-base font-semibold text-slate-900">Organizations</h2>
        {loadError && (
          <div className="mt-3">
            <Alert tone="danger">{loadError}</Alert>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-3">
          {orgs.map((org) => (
            <OrgCard key={org.id} org={org} onMembersChanged={refresh} />
          ))}
          {loaded && orgs.length === 0 && !loadError && (
            <p className="text-sm text-slate-500">No organizations yet.</p>
          )}
          {isPending && !loaded && <p className="text-sm text-slate-500">Loading…</p>}
        </div>
      </section>
    </main>
  );
}

function OrgCard({ org, onMembersChanged }: { org: OrgSummary; onMembersChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, startTransition] = useTransition();

  const [logoUrl, setLogoUrl] = useState(org.logoUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [isUploadingLogo, startLogoTransition] = useTransition();

  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [isRemoving, startRemoveTransition] = useTransition();

  const [confirmDeleteName, setConfirmDeleteName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startDeleteTransition] = useTransition();

  const [disabledModules, setDisabledModules] = useState(org.disabledModules);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [isSavingModules, startModulesTransition] = useTransition();

  function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await inviteMemberToOrg(org.id, email);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setSuccess(`Added ${email}.`);
      setEmail("");
      onMembersChanged();
    });
  }

  function handleRemoveMember(userId: string, memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from "${org.name}"? They keep their account — just this org's access.`)) return;
    setRemoveError(null);
    setRemovingUserId(userId);
    startRemoveTransition(async () => {
      const result = await removeMemberFromOrg(org.id, userId);
      if (!result.ok) {
        setRemoveError(result.error ?? "Unknown error");
        setRemovingUserId(null);
        return;
      }
      onMembersChanged(); // re-fetches the org list, same refresh callback used after adding a member
    });
  }

  function handleToggleModule(href: string, enabled: boolean) {
    const next = enabled ? disabledModules.filter((h) => h !== href) : [...disabledModules, href];
    const previous = disabledModules;
    setModuleError(null);
    setDisabledModules(next); // optimistic — reverted below if the save fails
    startModulesTransition(async () => {
      const result = await setOrgDisabledModules(org.id, next);
      if (!result.ok) {
        setModuleError(result.error ?? "Unknown error");
        setDisabledModules(previous);
      }
    });
  }

  function handleDeleteOrg() {
    if (confirmDeleteName.trim() !== org.name) return;
    if (!confirm(`Permanently delete "${org.name}" and everything in it — instances, products, sales, everything? This cannot be undone.`)) return;
    setDeleteError(null);
    startDeleteTransition(async () => {
      const result = await deleteOrganization(org.id, confirmDeleteName);
      if (!result.ok) {
        setDeleteError(result.error ?? "Unknown error");
        return;
      }
      onMembersChanged(); // re-fetches the org list — the deleted org just won't be in it anymore
    });
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoError(null);
    const formData = new FormData();
    formData.set("logo", file);
    startLogoTransition(async () => {
      const result = await uploadOrgLogo(org.id, formData);
      if (!result.ok) {
        setLogoError(result.error ?? "Unknown error");
        return;
      }
      setLogoUrl(result.logoUrl ?? null);
    });
  }

  return (
    <Panel className="p-5">
      <div className="flex items-start gap-4">
        <label className="group relative flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external per-org logo URL
            <img src={logoUrl} alt={`${org.name} logo`} className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-slate-400">Logo</span>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/60 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
            {isUploadingLogo && <Spinner className="mr-1.5" />}
            {isUploadingLogo ? "Uploading…" : "Change"}
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoChange} disabled={isUploadingLogo} className="hidden" />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-slate-900">{org.name}</p>
            <SubscriptionBadge status={org.subscriptionStatus} trialEndsAt={org.trialEndsAt} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {org.instanceCount} Cin7 instance{org.instanceCount === 1 ? "" : "s"} · created{" "}
            {new Date(org.createdAt).toLocaleDateString()}
          </p>
          {org.members.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {org.members.map((member) => (
                <li key={member.userId} className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  <span className="truncate">{member.email}</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleRemoveMember(member.userId, member.email)}
                    disabled={isRemoving && removingUserId === member.userId}
                    loading={isRemoving && removingUserId === member.userId}
                    className="shrink-0"
                  >
                    {isRemoving && removingUserId === member.userId ? "Removing…" : "Remove"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No members yet</p>
          )}
        </div>
      </div>
      {logoError && (
        <div className="mt-2">
          <Alert tone="danger">{logoError}</Alert>
        </div>
      )}
      {removeError && (
        <div className="mt-2">
          <Alert tone="danger">{removeError}</Alert>
        </div>
      )}

      <form onSubmit={handleAddMember} className="mt-4 flex gap-2">
        <Input
          type="email"
          label="Add a member by email"
          hideLabel
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="colleague@example.com"
          className="flex-1"
        />
        <Button type="submit" variant="secondary" loading={isSubmitting}>
          {isSubmitting ? "Adding…" : "Add member"}
        </Button>
      </form>
      {error && (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {success && (
        <div className="mt-2">
          <Alert tone="success">{success}</Alert>
        </div>
      )}

      <details className="mt-4 rounded-md border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">
          Modules {disabledModules.length > 0 && <span className="text-slate-500">({disabledModules.length} hidden)</span>}
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MODULES.map((module) => (
            <Checkbox
              key={module.href}
              label={module.label}
              checked={!disabledModules.includes(module.href)}
              onChange={(e) => handleToggleModule(module.href, e.target.checked)}
              disabled={isSavingModules}
            />
          ))}
        </div>
        {moduleError && (
          <div className="mt-2">
            <Alert tone="danger">{moduleError}</Alert>
          </div>
        )}
      </details>

      <details className="mt-4 rounded-md border border-danger-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-danger">Danger zone</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm text-slate-600">
            Permanently deletes <strong>{org.name}</strong> and everything in it — Cin7 instances, products,
            customers, suppliers, sales, sync history, everything. This cannot be undone. Type the organization name
            to confirm.
          </p>
          <div className="flex gap-2">
            <Input
              label="Organization name to confirm"
              hideLabel
              value={confirmDeleteName}
              onChange={(e) => setConfirmDeleteName(e.target.value)}
              placeholder={org.name}
              className="flex-1"
            />
            <Button
              variant="destructive"
              onClick={handleDeleteOrg}
              disabled={confirmDeleteName.trim() !== org.name}
              loading={isDeleting}
              className="shrink-0"
            >
              {isDeleting ? "Deleting…" : "Delete organization"}
            </Button>
          </div>
          {deleteError && <Alert tone="danger">{deleteError}</Alert>}
        </div>
      </details>
    </Panel>
  );
}
