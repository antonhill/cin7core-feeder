"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { listOrgsForSwitcherAction, setImpersonatedOrgAction, type SwitchableOrg } from "@/actions/org-switch";

/**
 * Super-admin only — lets Anton switch which org he's acting as, without
 * needing an org_members row there (see src/actions/org-switch.ts). Fetched
 * once per full page load, not per client-side navigation, since AppNav/the
 * root layout doesn't remount on route changes within the app.
 */
export function OrgSwitcher({ currentOrgId }: { currentOrgId: string | null }) {
  const router = useRouter();
  const [orgs, setOrgs] = useState<SwitchableOrg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const res = await listOrgsForSwitcherAction();
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setOrgs(res.orgs ?? []);
      setLoaded(true);
    });
  }, []);

  function handleChange(orgId: string) {
    if (!orgId || orgId === currentOrgId) return;
    setError(null);
    startTransition(async () => {
      const res = await setImpersonatedOrgAction(orgId);
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  return (
    <div className="border-b border-sidebar-border px-3 py-3">
      <label className="block px-2 pb-1.5 text-xs font-medium uppercase tracking-wide text-sidebar-text/70">
        Viewing as (master user)
      </label>
      <select
        value={currentOrgId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending || !loaded}
        className="w-full rounded-lg border border-sidebar-border bg-sidebar-bg-raised px-2 py-1.5 text-sm text-sidebar-text-active disabled:opacity-50"
      >
        {!loaded && <option value="">{isPending ? "Loading orgs…" : "—"}</option>}
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
