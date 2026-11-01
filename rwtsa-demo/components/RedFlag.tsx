import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { OUTCOME_MESSAGES, type FormOutcome } from "@/rwtsa-demo/state/exclusion-form";
import type { ChartSeries, RedFlagModel } from "@/rwtsa-demo/state/red-flag-model";
import { settingsQuery } from "@/rwtsa-demo/state/red-flag-settings";
import { ProvenanceBadge, ReadinessBadge } from "./Badges";

const n0 = (v: number): string => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const n1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const dash = "-";

const BASIS_TEXT = {
  ANCHORED: { tone: "success", text: "FORECAST BASIS: ANCHORED TO THE STOCK DATE" },
  ASSUMED: { tone: "warning", text: "FORECAST BASIS: ASSUMED (history ends before the stock date)" },
  LIMITED: { tone: "danger", text: "FORECAST BASIS: LIMITED (months missing; some SKUs have no forecast)" },
  NONE: { tone: "neutral", text: "FORECAST BASIS: NONE" },
} as const;

export function RedFlagChart({ chart }: { chart: ChartSeries }) {
  const W = 720;
  const H = 260;
  const m = { l: 52, r: 16, t: 14, b: 34 };
  const pts: number[] = [...(chart.opening === null ? [] : [chart.opening]), ...chart.balances];
  if (pts.length === 0) {
    return <EmptyState title="No projection for this selection" description={chart.note ?? "The selection cannot be projected."} />;
  }
  const lo = Math.min(0, ...pts, chart.minLevel ?? 0);
  const hi = Math.max(1, ...pts, chart.minLevel ?? 0);
  const x = (w: number) => m.l + (w / chart.horizon) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const series = [...(chart.opening === null ? [] : [{ w: 0, v: chart.opening }]), ...chart.balances.map((v, i) => ({ w: i + 1, v }))];
  const line = series.map((p) => `${x(p.w).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const weekTicks = chart.horizon === 13 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] : [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26];
  const breach = chart.firstBreachWeek === null ? null : series.find((p) => p.w === chart.firstBreachWeek);
  return (
    <figure data-testid="chart" className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Projected closing stock by week for ${chart.title}`} className="h-auto w-full max-w-3xl">
        <title>{`Projected closing stock by week: ${chart.title}`}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke="#e2e8f0" />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#475569">
              {n0(t)}
            </text>
          </g>
        ))}
        {weekTicks.map((w) => (
          <text key={w} x={x(w)} y={H - 12} textAnchor="middle" fontSize="11" fill="#475569">
            {w}
          </text>
        ))}
        <text x={W / 2} y={H - 1} textAnchor="middle" fontSize="11" fill="#475569">
          Week from stock date (0 = opening Available)
        </text>
        <line x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} stroke="#64748b" />
        {chart.minLevel !== null && (
          <g data-testid="chart-min">
            <line x1={m.l} x2={W - m.r} y1={y(chart.minLevel)} y2={y(chart.minLevel)} stroke="#b45309" strokeDasharray="6 4" />
            <text x={W - m.r} y={y(chart.minLevel) - 4} textAnchor="end" fontSize="11" fill="#b45309">
              minimum {n0(chart.minLevel)}
            </text>
          </g>
        )}
        <polyline data-testid="chart-line" data-points={series.map((p) => `${p.w}:${Math.round(p.v * 100) / 100}`).join(" ")} points={line} fill="none" stroke="#1d4ed8" strokeWidth="2" />
        {series.map((p) => (
          <circle key={p.w} cx={x(p.w)} cy={y(p.v)} r="2.5" fill="#1d4ed8" />
        ))}
        {breach && (
          <g data-testid="chart-breach">
            <circle cx={x(breach.w)} cy={y(breach.v)} r="6" fill="none" stroke="#b91c1c" strokeWidth="2" />
            <text x={x(breach.w)} y={y(breach.v) - 10} textAnchor="middle" fontSize="11" fill="#b91c1c">
              first breach: week {breach.w}
            </text>
          </g>
        )}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-600">
        {chart.title}. Solid line: projected closing stock. Dashed line: minimum level. {chart.firstBreachWeek === null ? "No week falls below the minimum." : `First week below the minimum: week ${chart.firstBreachWeek}.`}
        {chart.note ? ` ${chart.note}` : ""}
      </figcaption>
    </figure>
  );
}

function Indicator({ label, value, testid, hint }: { label: string; value: string; testid: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p data-testid={testid} className="mt-1 text-2xl font-semibold text-slate-900">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";

export function RedFlagPageView({ model, outcome }: { model: RedFlagModel; outcome: FormOutcome | null }) {
  const s = model.settings;
  const r = model.result;
  const basis = BASIS_TEXT[model.basis];
  const q = settingsQuery(s);
  const returnTo = `/scenario-a?${q}`;
  const flagged = r ? r.anomalies.filter((a) => a.inWindow) : [];
  const pendingByMonth = new Map<string, string[]>();
  for (const a of flagged) if (!a.excluded) pendingByMonth.set(a.month, [...(pendingByMonth.get(a.month) ?? []), a.sku]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scenario A</p>
        <h1 className="text-xl font-semibold text-slate-900">Demand planning and Red Flag</h1>
        <p className="mt-1 text-sm text-slate-600">Projected stock shortages, demand anomalies and proposed replenishment, calculated on this machine from the loaded data.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={model.provenance} />
          <span data-testid="structure">
            <Badge tone={model.structure === "PASS" ? "success" : "danger"}>{`STRUCTURE ${model.structure}`}</Badge>
          </span>
          <ReadinessBadge readiness={model.readiness} />
          <span data-testid="engine">
            <Badge tone={model.engine === "AVAILABLE" ? "success" : "danger"}>{`ENGINE ${model.engine}`}</Badge>
          </span>
          <span data-testid="basis">
            <Badge tone={basis.tone}>{basis.text}</Badge>
          </span>
        </div>
      </div>

      <Alert tone={model.banner.tone === "neutral" ? "info" : model.banner.tone}>{model.banner.text}</Alert>
      {outcome && <Alert tone={OUTCOME_MESSAGES[outcome].tone}>{OUTCOME_MESSAGES[outcome].text}</Alert>}
      {model.stateError && <Alert tone="danger">{model.stateError}</Alert>}
      {s.errors.length > 0 && (
        <Alert tone="warning">
          <ul data-testid="settings-errors" className="list-disc pl-5">
            {s.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Panel>
        <PanelTitle>Data readiness is separate from the engine</PanelTitle>
        {model.readiness === "READY" ? (
          <p className="mt-2 text-sm text-slate-700">The validator reports the inputs for this scenario as present and populated. Results below are calculated from them; the assumptions listed still apply.</p>
        ) : (
          <div className="mt-2">
            <Alert tone="warning">The engine being available does not make the data ready. These inputs are NOT READY, so treat any figure below as indicative only.</Alert>
            <ul data-testid="reasons" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {model.readinessReasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {model.engineNote && <p className="mt-2 text-sm text-red-700">{model.engineNote}</p>}
      </Panel>

      {!r ? (
        <Panel>
          <EmptyState title="No results" description="No validated dataset is loaded, so there is nothing to calculate. Nothing has been substituted." />
        </Panel>
      ) : (
        <>
          <Panel>
            <PanelTitle>Assumptions and limitations (all visible, none hidden)</PanelTitle>
            <ul data-testid="assumptions" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {r.assumptions.map((a) => (
                <li key={a.id} data-assumption={a.id}>
                  {a.text}
                </li>
              ))}
            </ul>
            {r.limitations.length > 0 && (
              <>
                <p className="mt-3 text-sm font-medium text-slate-800">Limitations on these results</p>
                <ul data-testid="limitations" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {r.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Stock date {r.config.stockDate}. Demand window {r.window.months[0]} to {r.window.months[r.window.months.length - 1]}. Last history month {r.window.lastHistoryMonth ?? "none"}.
            </p>
          </Panel>

          <Panel>
            <PanelTitle>Controls</PanelTitle>
            <form method="get" action="/scenario-a" data-testid="controls" className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-sm">
              <label className="flex flex-col gap-1">
                View
                <select name="view" defaultValue={s.values.view} className={field}>
                  <option value="sku">SKU / size</option>
                  <option value="style">Style</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Forecast window (months)
                <input name="window" type="number" min={1} max={36} step={1} defaultValue={s.values.window} className={`${field} w-20`} />
              </label>
              <label className="flex flex-col gap-1">
                Horizon
                <select name="horizon" defaultValue={s.values.horizon} className={field}>
                  <option value="13">13 weeks</option>
                  <option value="26">26 weeks</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Sales history vs stock date
                <select name="anchor" defaultValue={s.values.anchor} className={field}>
                  <option value="last">Assume: use the last months on file</option>
                  <option value="strict">Strict: require months to the stock date</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Overdue shipment on the water
                <select name="overdue" defaultValue={s.values.overdue} className={field}>
                  <option value="week1">Assume it arrives in week 1</option>
                  <option value="exclude">Do not count it</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Size curve for style-level POs
                <select name="curve" defaultValue={s.values.curve} className={field}>
                  <option value="none">None (leave unallocated)</option>
                  <option value="demand">In proportion to demand (assumption)</option>
                  {model.provenance === "SYNTHETIC" && <option value="supplied">Supplied (synthetic)</option>}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Anomaly: multiple of median
                <input name="mult" type="number" min={0.01} step="any" defaultValue={s.values.mult} className={`${field} w-24`} />
              </label>
              <label className="flex flex-col gap-1">
                Anomaly: floor (units)
                <input name="floor" type="number" min={0} step="any" defaultValue={s.values.floor} className={`${field} w-24`} />
              </label>
              <label className="flex flex-col gap-1">
                Style
                <select name="style" defaultValue={s.style ?? ""} className={field}>
                  <option value="">All styles</option>
                  {model.styles.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input name="only" type="checkbox" value="shortage" defaultChecked={s.shortageOnly} />
                Shortages only
              </label>
              {s.sel && <input type="hidden" name="sel" value={s.sel} />}
              <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white">
                Recalculate
              </button>
              <Link href="/scenario-a" prefetch={false} className="py-1.5 text-primary hover:underline">
                Reset to defaults
              </Link>
            </form>
          </Panel>

          <div data-testid="indicators" className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Indicator label="Projected shortage SKUs" testid="ind-shortage" value={String(r.summary.shortageSkus)} hint={`of ${r.summary.skuCount} SKUs`} />
            <Indicator label="First projected breach" testid="ind-first" value={r.summary.firstBreachWeek === null ? "None" : `Week ${r.summary.firstBreachWeek}`} hint={`of ${r.config.horizonWeeks}`} />
            <Indicator label="Total projected shortfall" testid="ind-shortfall" value={`${n0(r.summary.totalShortfall)} units`} hint={`proposed ${n0(r.summary.totalProposedOrder)} units`} />
            <Indicator label="Anomalies to review" testid="ind-anomalies" value={String(r.summary.anomaliesToReview)} hint={`${r.summary.anomaliesExcluded} excluded`} />
            <Indicator label="Tender-exempt SKUs" testid="ind-tender" value={String(r.summary.tenderExemptSkus)} hint="not auto-ordered" />
          </div>

          <Panel>
            <PanelTitle>{s.view === "sku" ? "Results by SKU / size" : "Results by style"}</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">{r.labels.proposedOrder}</p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>{s.view === "sku" ? "SKU" : "Style"}</TH>
                    <TH>Style</TH>
                    <TH>Size</TH>
                    <TH align="right">Available</TH>
                    <TH align="right">Inbound</TH>
                    <TH align="right">Weekly forecast</TH>
                    <TH align="right">First breach</TH>
                    <TH align="right">Shortfall</TH>
                    <TH align="right">Months of cover</TH>
                    <TH>Anomaly</TH>
                    <TH align="right">Proposed order</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.rows.length === 0 && (
                    <TR>
                      <TD>
                        <span data-testid="no-rows">No rows match these filters.</span>
                      </TD>
                    </TR>
                  )}
                  {model.rows.map((row) => (
                    <TR key={row.key}>
                      <TD>
                        <span data-testid="row-key" data-key={row.key} />
                        <Link href={`/scenario-a?${settingsQuery(s, { sel: row.key })}#projection`} prefetch={false} className="text-primary hover:underline">
                          {row.key}
                        </Link>
                        {row.tenderExempt && (
                          <div>
                            <Badge tone="neutral">TENDER: NOT AUTO-ORDERED</Badge>
                          </div>
                        )}
                        {row.limitation && <div className="mt-0.5 text-xs text-amber-700">{row.limitation}</div>}
                      </TD>
                      <TD>{row.style}</TD>
                      <TD>{row.size ?? dash}</TD>
                      <TD align="right" numeric>
                        {row.available === null ? dash : n0(row.available)}
                      </TD>
                      <TD align="right" numeric>
                        {n0(row.inbound)}
                      </TD>
                      <TD align="right" numeric>
                        {row.weeklyForecast === null ? "no forecast" : n1(row.weeklyForecast)}
                      </TD>
                      <TD align="right" numeric>
                        {row.firstBreachWeek === null ? dash : `Week ${row.firstBreachWeek}`}
                      </TD>
                      <TD align="right" numeric>
                        {row.shortfall > 0 ? n1(row.shortfall) : dash}
                      </TD>
                      <TD align="right" numeric>
                        {row.monthsOfCover === null ? "n/a" : n1(row.monthsOfCover)}
                      </TD>
                      <TD>
                        <span data-anomaly={row.anomalyKind}>{row.anomaly}</span>
                      </TD>
                      <TD align="right" numeric>
                        {row.tenderExempt ? "0 (tender)" : row.proposedOrder > 0 ? n0(row.proposedOrder) : dash}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <span id="projection" />
            <PanelTitle>Weekly projection</PanelTitle>
            <div className="mt-3">{model.chart ? <RedFlagChart chart={model.chart} /> : <EmptyState title="Nothing selected" description="No rows match these filters." />}</div>
          </Panel>

          <Panel>
            <PanelTitle>Demand anomalies in the forecast window</PanelTitle>
            <p className="mt-1 text-sm text-slate-600">
              A month is flagged when it exceeds {s.values.mult} x the SKU median and {s.values.floor} units. Excluding a month needs a reason; the month then leaves both the demand total and the observation count, and everything is recalculated. Exclusions are saved on this machine only, outside the repository.
            </p>
            {flagged.length === 0 ? (
              <p className="mt-3 text-sm text-slate-700" data-testid="no-anomalies">
                No anomalies in the window at these thresholds.
              </p>
            ) : (
              <>
                {[...pendingByMonth.entries()].map(([month, skus]) => (
                  <form key={month} method="post" action="/api/exclusions" data-testid="bulk-exclude" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
                    <input type="hidden" name="action" value="exclude" />
                    <input type="hidden" name="month" value={month} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    {skus.map((k) => (
                      <input key={k} type="hidden" name="sku" value={k} />
                    ))}
                    <label className="flex flex-col gap-1">
                      Reason to exclude {month} for all {skus.length} flagged SKUs
                      <input name="reason" required maxLength={500} placeholder="e.g. one-off tender order" className={`${field} w-72`} />
                    </label>
                    <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold">
                      Exclude all {skus.length}
                    </button>
                  </form>
                ))}
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>SKU</TH>
                        <TH>Month</TH>
                        <TH align="right">Units</TH>
                        <TH align="right">SKU median</TH>
                        <TH>Status</TH>
                        <TH>Action</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {flagged.slice(0, 200).map((a) => (
                        <TR key={`${a.sku}|${a.month}`}>
                          <TD>
                            <span data-testid="anomaly" data-sku={a.sku} data-month={a.month} data-excluded={String(a.excluded)} />
                            {a.sku}
                          </TD>
                          <TD>{a.month}</TD>
                          <TD align="right" numeric>
                            {n0(a.qty)}
                          </TD>
                          <TD align="right" numeric>
                            {n1(a.median)}
                          </TD>
                          <TD>{a.excluded ? <Badge tone="neutral">{`EXCLUDED: ${a.reason}`}</Badge> : <Badge tone="warning">REVIEW</Badge>}</TD>
                          <TD>
                            <form method="post" action="/api/exclusions" className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="month" value={a.month} />
                              <input type="hidden" name="sku" value={a.sku} />
                              <input type="hidden" name="returnTo" value={returnTo} />
                              {a.excluded ? (
                                <>
                                  <input type="hidden" name="action" value="reverse" />
                                  <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold">
                                    Reverse exclusion
                                  </button>
                                </>
                              ) : (
                                <>
                                  <input type="hidden" name="action" value="exclude" />
                                  <input name="reason" required maxLength={500} placeholder="Reason (required)" aria-label={`Reason to exclude ${a.sku} ${a.month}`} className={`${field} w-48`} />
                                  <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold">
                                    Exclude
                                  </button>
                                </>
                              )}
                            </form>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                {flagged.length > 200 && <p className="mt-2 text-xs text-slate-600">{flagged.length - 200} more not shown.</p>}
              </>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Incoming stock reconciliation</PanelTitle>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Bucket</TH>
                    <TH align="right">Units</TH>
                    <TH>Treatment</TH>
                  </TR>
                </THead>
                <TBody>
                  {(
                    [
                      ["On water, due in the horizon", r.inbound.onWaterUnits, "Counted by ETA to stores"],
                      ["On order, due in the horizon", r.inbound.onOrderUnits, "Counted by ETA to stores"],
                      ["Overdue on water, assumed week 1", r.inbound.overdueAssumedWeek1Units, "Included in on water (assumption)"],
                      ["Overdue on water, not counted", r.inbound.overdueExcludedUnits, "Excluded by the setting"],
                      ["Overdue on order", r.inbound.overdueOnOrderUnits, "Excluded: no arrival date assumed"],
                      ["Due after the horizon", r.inbound.beyondHorizonUnits, "Not counted"],
                      ["Style-level, unallocated to sizes", r.inbound.unallocatedStyleUnits, "Held: no usable size curve"],
                      ["No matching SKU or style", r.inbound.unmatchedUnits, "Excluded"],
                      ["Unrecognised status", r.inbound.unclassifiedUnits, "Excluded"],
                      ["Received / closed / cancelled", r.inbound.receivedExcludedUnits, "Excluded: already in stock"],
                      ["Stock 'In transit' (all SKUs)", r.inbound.reconciliation.inTransitStockUnits, "Not added: purchase orders only"],
                      ["On-water purchase orders (all SKUs)", r.inbound.reconciliation.onWaterPoUnits, `${r.inbound.reconciliation.skusConsistent} SKU(s) agree, ${r.inbound.reconciliation.skusMismatched} differ`],
                    ] as const
                  ).map(([label, units, note]) => (
                    <TR key={label}>
                      <TD>{label}</TD>
                      <TD align="right" numeric>
                        {n0(units)}
                      </TD>
                      <TD>{note}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
