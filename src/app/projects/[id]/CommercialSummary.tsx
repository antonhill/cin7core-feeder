import { formatCents, type ProjectView } from "@/lib/projects/project-view";

// The top of the Commercial / Claims workspace: where the project stands financially, in one compact row (ex VAT). Everything here is already in the project view; no extra read.

export function CommercialSummary({ view }: { view: ProjectView }) {
  const c = view.commercial;
  const awaiting = view.claims.filter((x) => x.status === "READY_FOR_APPROVAL").length;
  const cells: Array<{ label: string; value: string; hint?: string; emphasis?: boolean }> = [
    { label: "Revised contract", value: formatCents(c.revisedContractCents), hint: c.approvedVariationsCents !== 0 ? `incl. ${formatCents(c.approvedVariationsCents)} variations` : "no variations" },
    { label: "Earned", value: formatCents(c.earnedCents), hint: "approved progress" },
    { label: "Billed / committed", value: formatCents(c.committedCents), hint: "claims approved or later" },
    { label: "Claimable now", value: formatCents(c.claimableCents), hint: "ready to claim", emphasis: c.claimableCents > 0 },
    { label: "Remaining", value: formatCents(c.remainingCents), hint: "still to bill" },
    { label: "Claims", value: String(view.claims.length), hint: awaiting > 0 ? `${awaiting} awaiting approval` : "none awaiting approval" },
  ];
  return (
    <section aria-label="Commercial summary (ex VAT)" data-testid="commercial-summary">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-slate-200 bg-white px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((k) => (
          <div key={k.label} className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wider text-slate-600">{k.label}</dt>
            <dd className={`mt-1 whitespace-nowrap text-lg font-bold tabular-nums ${k.emphasis ? "text-indigo-800" : "text-slate-900"}`}>{k.value}</dd>
            {k.hint && <p className="text-xs text-slate-600">{k.hint}</p>}
          </div>
        ))}
      </dl>
      <p className="mt-1 text-xs text-slate-600">Amounts are ex VAT. Claim totals below include VAT.</p>
    </section>
  );
}
