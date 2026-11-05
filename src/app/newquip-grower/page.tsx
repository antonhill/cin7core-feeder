"use client";

import { pageContainerClass } from "@/app/PageContainer";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SOLUTION_BUILDER_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { stageLabelOf, waitingOn, type QuoteState } from "@/newquip/quote/workflow";
import { createGrowerQuoteAction, listGrowerQuotesAction } from "./actions";
import { QuoteListSkeleton } from "./QuoteSkeleton";
import { announceNavigation } from "@/app/navigation-events";
import { OP } from "@/components/ui/operation-labels";
import { PendingNotice } from "@/components/ui/action-feedback";
import { LongRunningStatus } from "@/components/ui/LongRunningStatus";
import { fmtCents } from "./fields";

// NewQuip Grower POC — quotes list. READ-ONLY with respect to Cin7 and Xero: quotes live in the Toolbox database only.

const STATE_TONE: Record<QuoteState, BadgeTone> = { REP_DRAFT: "neutral", ESTIMATOR_REVIEW: "info", MANAGER_APPROVED_FINAL: "success" };
type Row = NonNullable<Awaited<ReturnType<typeof listGrowerQuotesAction>>["data"]>[number];

export default function NewquipGrowerPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, start] = useTransition();
  const creating = useRef(false); // a ref, not state: a same-tick double click must not create two quotations

  useEffect(() => {
    listGrowerQuotesAction().then((r) => (r.ok ? (setRows(r.data ?? []), setError(null)) : setError(r.error ?? "The quotations could not be loaded."))).catch(() => setError("The quotations could not be loaded. Reload the page to try again."));
  }, []);

  function create() {
    if (creating.current) return;
    creating.current = true;
    setError(null);
    start(async () => {
      let r: Awaited<ReturnType<typeof createGrowerQuoteAction>>;
      try { r = await createGrowerQuoteAction(); } catch { creating.current = false; return setError("The quotation was not created: the request did not complete. It is safe to try again, but check the list below first."); }
      if (!r.ok || !r.data) { creating.current = false; return setError(r.error ?? "The quotation was not created. Nothing was changed; you can try again."); }
      announceNavigation();
      router.push(`/newquip-grower/${r.data.id}`);
    });
  }

  return (
    <main className={pageContainerClass("data")}>
      <ModuleHeader variant="workspace" module={SOLUTION_BUILDER_MODULE}>NewQuip Agri Supplies — Grower House quotes</ModuleHeader>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-600">
          Grower House Template v1 → configuration → estimator review → quote → manager approval → accepted baseline → Project.
          Quotes are kept in the Toolbox only — <strong>nothing is sent to Cin7 or Xero</strong>.
        </p>
        <div className="flex gap-2">
          <Link href="/newquip-grower/project-templates" className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Project templates</Link>
          <Link href="/newquip-grower/company-profile" className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Company details</Link>
          <Link href="/newquip-grower/template" className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Template detail</Link>
          <Button className="min-h-11" onClick={create} loading={isWorking}>{isWorking ? OP.createQuotation : "New Grower quote"}</Button>
        </div>
      </div>
      {isWorking && <PendingNotice label={OP.createQuotation} className="mt-4" />}
      <LongRunningStatus label={isWorking ? OP.createQuotation : null} />
      {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      <Panel className="mt-6">
        <PanelTitle>Quotes</PanelTitle>
        {rows === null ? (
          <QuoteListSkeleton what="Loading quotations…" />
        ) : rows.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No quotes yet. Start a Grower quote to walk the whole flow.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <THead><TR><TH>Quote</TH><TH>Customer</TH><TH>Site</TH><TH>Stage</TH><TH>Waiting on / next</TH><TH align="right">Contract (ex VAT)</TH><TH>Project</TH></TR></THead>
              <TBody>
                {rows.map((q) => (
                  <TR key={q.id}>
                    <TD><Link className="inline-flex min-h-11 items-center font-medium text-indigo-700 hover:underline" href={`/newquip-grower/${q.id}`}>{q.quote_ref}</Link> <span className="text-xs text-slate-600">rev {q.revision}</span></TD>
                    <TD>{q.customer_name || "—"}</TD>
                    <TD>{q.site_name || "—"}</TD>
                    <TD><Status tone={STATE_TONE[q.state]}>{stageLabelOf(q)}</Status></TD>
                    <TD className="text-sm text-slate-800" data-testid="waiting-on">{waitingOn(q)}</TD>
                    <TD align="right" className="tabular-nums whitespace-nowrap">{fmtCents(q.contract_cents)}</TD>
                    <TD>{q.project_id ? <Link className="inline-flex min-h-11 items-center text-indigo-700 hover:underline" href={`/projects/${q.project_id}`}>Open project</Link> : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Panel>
    </main>
  );
}
