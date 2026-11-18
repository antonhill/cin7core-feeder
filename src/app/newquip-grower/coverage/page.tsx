import { notFound } from "next/navigation";
import { getBudgetCoverageAction } from "../actions";
import { coverageCounts, FACTS_VALIDATED, type CoverageState, type PriceEvidence } from "@/newquip/grower/budget-coverage";

// INTERNAL (Estimator / Manager): Budget pricing coverage of every selectable equipment category. A viewer without cost visibility (a Rep) gets a 404. Read-only; never cached.
export const dynamic = "force-dynamic";

const LABEL: Record<CoverageState, string> = { READY: "Ready", PROVISIONAL: "Provisional", RATE_APPROVAL_REQUIRED: "Rate approval required", SPECIFICATION_REQUIRED: "Specification required", NO_PRICE_SOURCE: "No price source" };
const EVIDENCE: Record<PriceEvidence, string> = { current_cin7: "Current Cin7 cost", approved_rate: "Approved NewQuip rate", approved_record: "Approved record (quote or owner confirmation)", historical_only: "Historical ERP only (unverified)", none: "None" };
const TONE: Record<CoverageState, string> = { READY: "text-emerald-800", PROVISIONAL: "text-amber-800", RATE_APPROVAL_REQUIRED: "text-amber-900", SPECIFICATION_REQUIRED: "text-amber-900", NO_PRICE_SOURCE: "text-slate-700" };

export default async function BudgetCoveragePage() {
  const r = await getBudgetCoverageAction();
  if (!r.ok || !r.data) notFound();
  const rows = r.data;
  const c = coverageCounts(rows);
  return (
    <main className="mx-auto max-w-6xl p-4" data-testid="budget-coverage">
      <h1 className="text-xl font-semibold">Budget pricing coverage</h1>
      <p className="mt-1 text-sm text-slate-700">Every category a Rep can select, how it is priced for a Budget Quotation, and what is missing. Internal: it names suppliers and evidence. Price evidence, Engine can price and Approved and ready are three separate questions: only the last means a NewQuip-approved price is in place today. Facts last validated {FACTS_VALIDATED}.</p>
      <p className="mt-2 text-sm" data-testid="coverage-counts">Ready {c.READY} · Provisional {c.PROVISIONAL} · Rate approval required {c.RATE_APPROVAL_REQUIRED} · Specification required {c.SPECIFICATION_REQUIRED} · No price source {c.NO_PRICE_SOURCE}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[80rem] border-collapse text-left text-sm">
          <thead><tr className="border-b text-xs uppercase tracking-wide text-slate-600"><th className="p-2">Category</th><th className="p-2">Quantity rule</th><th className="p-2">Mapping / price source</th><th className="p-2">Price evidence</th><th className="p-2">Engine can price</th><th className="p-2">Approved and ready</th><th className="p-2">State</th><th className="p-2">Blocker</th><th className="p-2">Owner and next action</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.itemKey} className="border-b align-top" data-testid={`coverage-${x.itemKey}`}>
                <td className="p-2 font-medium">{x.label}<div className="text-xs font-normal text-slate-700">{x.itemKey}</div></td>
                <td className="p-2">{x.quantityRule}</td>
                <td className="p-2">{x.mapping}</td>
                <td className="p-2">{EVIDENCE[x.priceEvidence]}{x.evidenceNote && <div className="text-xs text-slate-600">{x.evidenceNote}</div>}</td>
                <td className="p-2">{x.mechanismSupported ? "Yes" : "No"}</td>
                <td className="p-2 font-medium">{x.approvedPriceReady ? "Yes" : "No"}</td>
                <td className={`p-2 font-medium ${TONE[x.state]}`}>{LABEL[x.state]}</td>
                <td className="p-2">{x.blocker ?? "—"}</td>
                <td className="p-2">{x.owner ? <><strong>{x.owner}</strong>: {x.nextAction}</> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
