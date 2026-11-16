import type { PenningScope } from "@/newquip/grower/penning";

// The penning COMPONENT scope for the Estimator (and, for handover, the Manager): the post, cap, hinge, lock and gate components Sean listed, the custom polypropylene panel specification, and
// what the Estimator still has to decide. It shows NO quantity and NO price: the commercial line stays running metres x the approved rate, and no component count is invented.
const m = (n: number | null) => (n === null ? "not entered" : `${n.toLocaleString("en-ZA").replace(/\s/g, ",")} m`);

export function PenningScopePanel({ scope }: { scope: PenningScope }) {
  const groups = new Map<string, typeof scope.components[number][]>();
  for (const c of scope.components) { const g = groups.get(c.role) ?? []; g.push(c); groups.set(c.role, g); }
  return (
    <section className="mt-6 rounded-xl border border-slate-300 bg-white p-4" data-testid="penning-scope" aria-labelledby="penning-scope-title">
      <h3 id="penning-scope-title" className="text-sm font-semibold text-slate-900">Penning components (scope for estimating and handover)</h3>
      <p className="mt-1 text-xs text-slate-700">The penning price is unchanged: running metres × the approved rate for the pig size. The components below are what a build uses. No quantity is calculated here because post spacing, openings, cutting and wastage rules have not been supplied.</p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-slate-700">Room (length × width)</dt><dd className="tabular-nums" data-testid="penning-room">{scope.roomLengthM} m × {scope.roomWidthM} m, {scope.rooms} room{scope.rooms === 1 ? "" : "s"}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-slate-700">Pig size</dt><dd>{scope.pigSize ? scope.pigSize.toLowerCase() : "not selected"}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-slate-700">Running metres per room</dt><dd className="tabular-nums" data-testid="penning-rm-room">{m(scope.runningMetresPerRoom)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-slate-700">Running metres, all rooms</dt><dd className="tabular-nums" data-testid="penning-rm-project">{m(scope.projectRunningMetres)}</dd></div>
        <div className="flex justify-between gap-3 sm:col-span-2"><dt className="text-slate-700">Room perimeter (context only, not a quantity)</dt><dd className="tabular-nums">{scope.roomPerimeterReferenceM} m</dd></div>
      </dl>
      <div className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-700">Polypropylene panel (custom size)</h4>
        <p className="mt-1 text-sm text-slate-900" data-testid="penning-panel">{scope.panel.material}, {scope.panel.thicknessMm} mm. {scope.panel.skuStatus} The Estimator specifies: {scope.panel.requiredFromEstimator.join(", ")}.</p>
      </div>
      <div className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-700">Components (Sean, 50 mm panel)</h4>
        <ul className="mt-1 divide-y divide-slate-100 text-sm" data-testid="penning-components">
          {[...groups.values()].flat().map((c) => (
            <li key={c.sku} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5"><span><span className="font-mono font-medium">{c.sku}</span> <span className="text-slate-800">{c.name}</span></span><span className="text-xs text-amber-900">quantity: Estimator decision</span></li>
          ))}
        </ul>
      </div>
      <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950" data-testid="penning-decisions">
        <p className="font-medium">Estimator decisions needed</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">{scope.decisions.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
    </section>
  );
}
