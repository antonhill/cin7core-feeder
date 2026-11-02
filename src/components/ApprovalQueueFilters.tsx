"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { DOC_TYPE_LABEL, STATUS_LABEL, type ApprovalDocType, type ApprovalStatus } from "@/lib/approvals/types";
import type { QueueFilters, QueueSort } from "@/lib/approvals/queue";
import { DEFAULT_QUEUE_FILTERS, DEFAULT_QUEUE_SORT, isDefaultView, secondaryActive, SORT_LABEL, summaryItems } from "@/lib/approvals/filter-view";

// The Approvals queue filter bar: Show and Status are always visible; Type, Sort and the other filters sit behind "More filters (n)". The summary line is always
// visible and lists EVERY selection that differs from the default (including ones hidden in the disclosure). Same state, same predicates as before.
export function ApprovalQueueFilters({ f, setF, sort, setSort }: { f: QueueFilters; setF: (f: QueueFilters) => void; sort: QueueSort; setSort: (s: QueueSort) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const hidden = secondaryActive(f);
  const items = summaryItems(f, sort, (s) => STATUS_LABEL[s]);
  const clear = () => { setF({ ...DEFAULT_QUEUE_FILTERS }); setSort(DEFAULT_QUEUE_SORT); summaryRef.current?.focus(); }; // the Clear button disappears, so focus moves to the summary

  return (
    <div data-testid="queue-filters">
      <div className="grid grid-cols-2 gap-3 md:max-w-xl">
        <Select label="Show" value={f.mine ? "mine" : "all"} onChange={(e) => setF({ ...f, mine: e.target.value === "mine" })}><option value="all">All approvals</option><option value="mine">My approvals</option></Select>
        <Select label="Status" value={f.status ?? "ANY"} onChange={(e) => setF({ ...f, status: e.target.value as ApprovalStatus | "ANY" })}><option value="ANY">Any status</option>{(Object.keys(STATUS_LABEL) as ApprovalStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}</Select>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
          {open ? "Fewer filters" : "More filters"}{hidden.length ? ` (${hidden.length})` : ""}
        </Button>
        {!isDefaultView(f, sort) && <Button size="sm" variant="secondary" onClick={clear}>Clear filters</Button>}
      </div>
      <div id={panelId} hidden={!open} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <Select label="Type" value={f.docType ?? ""} onChange={(e) => setF({ ...f, docType: (e.target.value || undefined) as ApprovalDocType | undefined })}><option value="">All types</option>{(["QUOTE", "CLAIM", "VARIATION"] as const).map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</Select>
        <Select label="Sort" value={sort} onChange={(e) => setSort(e.target.value as QueueSort)}>{(Object.keys(SORT_LABEL) as QueueSort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}</Select>
        <Input label="Customer" value={f.customer ?? ""} onChange={(e) => setF({ ...f, customer: e.target.value })} />
        <Input label="Project / reference" value={f.project ?? ""} onChange={(e) => setF({ ...f, project: e.target.value })} />
        <Input label="Submitted by" value={f.preparer ?? ""} onChange={(e) => setF({ ...f, preparer: e.target.value })} />
        <Input label="Assigned manager" value={f.assignee ?? ""} onChange={(e) => setF({ ...f, assignee: e.target.value })} />
        <Input label="Submitted from" type="date" value={f.from?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, from: e.target.value ? `${e.target.value}T00:00:00+02:00` : undefined })} />
        <Input label="Submitted to" type="date" value={f.to?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, to: e.target.value ? `${e.target.value}T23:59:59+02:00` : undefined })} />
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-700"><input type="checkbox" checked={!!f.overdueOnly} onChange={(e) => setF({ ...f, overdueOnly: e.target.checked })} /> Overdue only</label>
      </div>
      <p ref={summaryRef} tabIndex={-1} aria-live="polite" data-testid="filter-summary" className="mt-3 text-xs text-slate-700 outline-offset-2">
        {items.length === 0 ? "Filters: none." : <><span className="font-medium">Active filters:</span> {items.map((t) => <span key={t} className="mr-1.5 inline-block rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-indigo-800">{t}</span>)}</>}
      </p>
    </div>
  );
}
