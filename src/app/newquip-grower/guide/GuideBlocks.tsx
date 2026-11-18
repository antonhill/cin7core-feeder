import Link from "next/link";
import type { GuideBlock } from "@/newquip/guide/types";
import { shotById } from "@/newquip/guide/shots";
import { JOURNEY } from "@/newquip/guide/content/journey";
import { GuideImage } from "./GuideImage";

const CALLOUT: Record<string, { cls: string; label: string }> = {
  tip: { cls: "border-success-border bg-success-subtle text-emerald-900", label: "Tip" },
  warning: { cls: "border-warning-border bg-warning-subtle text-amber-900", label: "Important" },
  note: { cls: "border-info-border bg-info-subtle text-sky-900", label: "Note" },
};

export function JourneyDiagram() {
  return (
    <ol className="my-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="End-to-end quotation journey">
      {JOURNEY.map((s, i) => (
        <li key={s.slug + i}>
          <Link href={`/newquip-grower/guide/${s.slug}`} className="flex h-full min-h-11 gap-3 rounded-lg border border-slate-200 bg-white p-3 hover:border-indigo-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-700 text-xs font-semibold text-white" aria-hidden>{i + 1}</span>
            <span>
              <span className="block text-sm font-semibold text-slate-900">{s.label}</span>
              <span className="block text-xs text-slate-600">{s.actor}</span>
              <span className="mt-1 block text-sm text-slate-700">{s.detail}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function GuideBlocks({ blocks }: { blocks: GuideBlock[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i} className="text-[15px] leading-relaxed text-slate-800">{b.text}</p>;
          case "h":
            return <h2 key={i} id={`h-${i}`} className="pt-2 text-lg font-semibold text-slate-900">{b.text}</h2>;
          case "steps":
            return <ol key={i} className="list-decimal space-y-1.5 pl-6 text-[15px] leading-relaxed text-slate-800 marker:font-semibold">{b.items.map((x, j) => <li key={j}>{x}</li>)}</ol>;
          case "list":
            return <ul key={i} className="list-disc space-y-1.5 pl-6 text-[15px] leading-relaxed text-slate-800">{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>;
          case "callout": {
            const c = CALLOUT[b.tone];
            return (
              <div key={i} role={b.tone === "warning" ? "note" : undefined} className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${c.cls}`}>
                <p className="font-semibold">{b.title ?? c.label}</p>
                <p>{b.text}</p>
              </div>
            );
          }
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                  {b.caption && <caption className="px-3 py-2 text-left text-xs text-slate-600">{b.caption}</caption>}
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-700"><tr>{b.head.map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j} className="border-t border-slate-200 align-top">{r.map((c2, k) => <td key={k} className={`px-3 py-2 text-slate-800 ${k === 0 ? "font-medium" : ""}`}>{c2}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          case "formula":
            return (
              <div key={i} className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">Formula: {b.label}</p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-900">{b.lines.join("\n")}</pre>
              </div>
            );
          case "example":
            return (
              <div key={i} className="rounded-lg border border-indigo-200 bg-white">
                <p className="border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-900">Worked example: {b.title}</p>
                {b.note && <p className="px-4 pt-2 text-xs text-slate-600">{b.note}</p>}
                <dl className="divide-y divide-slate-100 px-4 py-1 text-sm">
                  {b.rows.map(([k, v], j) => <div key={j} className="flex flex-wrap justify-between gap-x-4 py-1.5"><dt className="text-slate-700">{k}</dt><dd className="font-mono text-slate-900">{v}</dd></div>)}
                </dl>
                <p className="border-t border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-900">{b.result}</p>
              </div>
            );
          case "facts":
            return (
              <dl key={i} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-3">
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-700">Who can do this</dt><dd className="mt-1 text-slate-800">{b.who}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-700">Where to find it</dt><dd className="mt-1 text-slate-800">{b.where}</dd></div>
                <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-700">What happens next</dt><dd className="mt-1 text-slate-800">{b.next}</dd></div>
              </dl>
            );
          case "shot": {
            const s = shotById(b.id);
            if (!s) return null;
            return <GuideImage key={i} src={`/newquip-grower/guide-assets/${s.file}`} alt={s.alt} caption={s.caption} width={s.width} height={s.height} />;
          }
          case "diagram":
            return b.id === "journey" ? <JourneyDiagram key={i} /> : null;
          case "links":
            return (
              <p key={i} className="text-sm text-slate-700">
                <span className="font-semibold">Related: </span>
                {b.items.map((l, j) => <span key={l.slug}>{j > 0 && " · "}<Link href={`/newquip-grower/guide/${l.slug}`} className="font-medium text-indigo-800 underline underline-offset-2 hover:text-indigo-950">{l.label}</Link></span>)}
              </p>
            );
        }
      })}
    </div>
  );
}
