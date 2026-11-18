"use client";

// PHASE 4 · CUSTOMER & HANDOVER at a glance: four short statuses over the existing steps (issue and send, acceptance, project handover). It states only what the page already knows from the stored records and
// invents or activates nothing: Cin7 is reported as not sent, because that is what the application does today.
export interface OverviewTile { id: string; title: string; status: string; detail: string; tone: "ok" | "open" | "wait" }

const TONE: Record<OverviewTile["tone"], string> = { ok: "border-emerald-700 text-emerald-900", open: "border-amber-600 text-amber-900", wait: "border-slate-400 text-slate-800" };

export function HandoverOverview({ tiles }: { tiles: OverviewTile[] }) {
  return (
    <section aria-label="Customer and handover status" className="mt-4" data-testid="handover-overview">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <li key={t.id} className={`rounded-xl border-l-4 bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200 ${TONE[t.tone]}`} data-testid={`overview-${t.id}`}>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{t.title}</p>
            <p className="mt-1 text-base font-bold">{t.status}</p>
            <p className="mt-0.5 text-sm text-slate-800">{t.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
