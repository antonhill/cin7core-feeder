"use client";

import { useEffect, useState, useTransition } from "react";
import { listActivityAction, type ActivityLogRow } from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { ACTIVITY_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";

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
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={ACTIVITY_MODULE}>
        Every live write this app has made to your connected Cin7 instances — Data Audit fixes/merges and sync
        pushes — with who triggered it and when. The most recent 100 entries.
      </ModuleHeader>

      <Panel className="mt-6">
        {error && <Alert tone="danger">{error}</Alert>}
        {isPending && !loaded && <p className="text-sm text-slate-500">Loading…</p>}
        {loaded && rows.length === 0 && !error && <EmptyState title="Nothing recorded yet" />}

        {rows.length > 0 && (
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>Instance</TH>
                <TH>What</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD className="whitespace-nowrap align-top text-slate-500">{new Date(row.createdAt).toLocaleString()}</TD>
                  <TD className="align-top">{row.actorEmail ?? "—"}</TD>
                  <TD className="align-top">{row.instanceName ?? "—"}</TD>
                  <TD className="align-top">{row.summary}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
    </main>
  );
}
