"use client";

import { useEffect, useState, useTransition } from "react";
import { listActivityAction, type ActivityLogRow } from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { ACTIVITY_MODULE } from "@/app/module-nav";

export default function ActivityPage() {
  const [rows, setRows] = useState<ActivityLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const res = await listActivityAction();
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setRows(res.data ?? []);
      setLoaded(true);
    });
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <ModuleHeader module={ACTIVITY_MODULE}>
        Every live write this app has made to your connected Cin7 instances — Data Audit fixes/merges and sync
        pushes — with who triggered it and when. The most recent 100 entries.
      </ModuleHeader>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {isPending && !loaded && <p className="text-base text-slate-500">Loading…</p>}
        {loaded && rows.length === 0 && !error && <p className="text-base text-slate-500">Nothing recorded yet.</p>}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-700">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-4 font-medium">When</th>
                  <th className="py-1.5 pr-4 font-medium">Who</th>
                  <th className="py-1.5 pr-4 font-medium">Instance</th>
                  <th className="py-1.5 pr-4 font-medium">What</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-4 align-top whitespace-nowrap text-slate-500">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="py-1.5 pr-4 align-top">{row.actorEmail ?? "—"}</td>
                    <td className="py-1.5 pr-4 align-top">{row.instanceName ?? "—"}</td>
                    <td className="py-1.5 pr-4 align-top">{row.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
