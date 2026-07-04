"use client";

import { useEffect, useState, useTransition } from "react";
import { createOrgAndInvite, inviteMemberToOrg, listOrgsForAdmin, uploadOrgLogo, type OrgSummary } from "./actions";

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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Admin</h1>
      <p className="mt-2 text-lg text-slate-500">Every organization using Cin7 Core Feeder.</p>

      <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Create org &amp; invite first user</h2>
        <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Organization name</span>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
              placeholder="Casa das Natas"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">First user&apos;s email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
              placeholder="owner@casadasnatas.com"
            />
          </label>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {isSubmitting ? "Creating…" : "Create org & send invite"}
          </button>
          {formError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>
          )}
          {formSuccess && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {formSuccess}
            </p>
          )}
        </form>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-slate-900">Organizations</h2>
        {loadError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
        )}
        <div className="mt-4 flex flex-col gap-3">
          {orgs.map((org) => (
            <OrgCard key={org.id} org={org} onMemberAdded={refresh} />
          ))}
          {loaded && orgs.length === 0 && !loadError && (
            <p className="text-base text-slate-500">No organizations yet.</p>
          )}
          {isPending && !loaded && <p className="text-base text-slate-500">Loading…</p>}
        </div>
      </section>
    </main>
  );
}

function OrgCard({ org, onMemberAdded }: { org: OrgSummary; onMemberAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, startTransition] = useTransition();

  const [logoUrl, setLogoUrl] = useState(org.logoUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [isUploadingLogo, startLogoTransition] = useTransition();

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
      onMemberAdded();
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
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <label className="group relative flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external per-org logo URL
            <img src={logoUrl} alt={`${org.name} logo`} className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-slate-400">Logo</span>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/60 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
            {isUploadingLogo ? "Uploading…" : "Change"}
          </span>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={handleLogoChange} disabled={isUploadingLogo} className="hidden" />
        </label>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold text-slate-900">{org.name}</p>
          <p className="mt-1 text-sm text-slate-500">
            {org.instanceCount} Cin7 instance{org.instanceCount === 1 ? "" : "s"} · created{" "}
            {new Date(org.createdAt).toLocaleDateString()}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {org.memberEmails.length > 0 ? org.memberEmails.join(", ") : "No members yet"}
          </p>
        </div>
      </div>
      {logoError && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700">{logoError}</p>
      )}

      <form onSubmit={handleAddMember} className="mt-4 flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          placeholder="colleague@example.com"
        />
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {isSubmitting ? "Adding…" : "Add member"}
        </button>
      </form>
      {error && <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700">{error}</p>}
      {success && (
        <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">
          {success}
        </p>
      )}
    </div>
  );
}
