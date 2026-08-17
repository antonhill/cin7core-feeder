"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { listMyOrgsAction, setActiveOrgAction, type MyOrg } from "@/actions/active-org";

/**
 * Security re-audit P1-8: lets a member of more than one org explicitly
 * choose which one they're acting as, replacing the old implicit "whichever
 * row Postgres returns first" behaviour. Only rendered when the caller
 * actually has more than one org_members row (AppNav's hasMultipleOrgs) —
 * invisible to the common single-org case. Distinct from OrgSwitcher (that
 * one is super-admin impersonation of ANY org); this only ever offers the
 * caller's own real memberships.
 */
export function ActiveOrgSwitcher({ currentOrgId }: { currentOrgId: string | null }) {
  const router = useRouter();
  const [orgs, setOrgs] = useState<MyOrg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const res = await listMyOrgsAction();
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
      const res = await setActiveOrgAction(orgId);
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
      <label className="block px-2 pb-1.5 text-xs font-medium uppercase tracking-wide text-sidebar-text/70">Organization</label>
      <select
        value={currentOrgId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending || !loaded}
        className="w-full rounded-lg border border-sidebar-border bg-sidebar-bg-raised px-2 py-1.5 text-sm text-sidebar-text-active disabled:opacity-50"
      >
        {!loaded && <option value="">{isPending ? "Loading…" : "—"}</option>}
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
