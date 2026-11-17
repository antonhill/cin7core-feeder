"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { searchGuide, type SearchEntry } from "@/newquip/guide/search";

export type NavLesson = { slug: string; title: string; section: string; sectionKey: string };

/** Persistent sidebar: search box with live results, then the lessons grouped by section. On narrow screens it collapses behind a toggle. Read-only; navigation only. */
export function GuideNav({ lessons, index, current, sections }: { lessons: NavLesson[]; index: SearchEntry[]; current?: string; sections: Array<{ key: string; label: string }> }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchGuide(index, q), [index, q]);
  const searching = q.trim().length > 1;
  return (
    <nav aria-label="User Guide" className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      <button type="button" className="mb-2 inline-flex min-h-11 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 lg:hidden" aria-expanded={open} aria-controls="guide-nav-body" onClick={() => setOpen((v) => !v)}>
        Guide contents <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      <div id="guide-nav-body" className={`${open ? "block" : "hidden"} space-y-4 lg:block`}>
        <div role="search">
          <label htmlFor="guide-search" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-700">Search the guide</label>
          <input id="guide-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. exchange rate, markup, claim" className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" autoComplete="off" />
        </div>
        <p aria-live="polite" role="status" className={searching ? "text-xs text-slate-600" : "sr-only"}>{searching ? (results.length === 0 ? "No lessons match. Try a different word." : `${results.length} result${results.length === 1 ? "" : "s"}`) : ""}</p>
        {searching ? (
          <div>
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={r.slug}>
                  <Link href={`/newquip-grower/guide/${r.slug}`} className="block rounded-md px-2 py-2 text-sm hover:bg-slate-100">
                    <span className="font-medium text-slate-900">{r.title}</span>
                    <span className="block text-xs text-slate-600">{r.section}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          sections.map((s) => {
            const items = lessons.filter((l) => l.sectionKey === s.key);
            if (items.length === 0) return null;
            return (
              <div key={s.key}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-700">{s.label}</p>
                <ul className="space-y-0.5">
                  {items.map((l) => (
                    <li key={l.slug}>
                      <Link href={`/newquip-grower/guide/${l.slug}`} aria-current={l.slug === current ? "page" : undefined} className={`block rounded-md px-2 py-1.5 text-sm ${l.slug === current ? "bg-primary-subtle font-semibold text-indigo-900" : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"}`}>
                        {l.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
}
