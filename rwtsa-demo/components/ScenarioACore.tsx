import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { RedFlagModel } from "@/rwtsa-demo/state/red-flag-model";

const n0 = (v: number): string => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const n1 = (v: number | null): string => (v === null ? "n/a" : (Math.round(v * 10) / 10).toFixed(1));
const dash = "-";
const TONE = { available: "success", assumption: "warning", withheld: "danger" } as const;
const STATE_TEXT = { available: "AVAILABLE", assumption: "UNDER LABELLED ASSUMPTION", withheld: "WITHHELD" } as const;

/** The forecast basis, per-output eligibility, 6 v 12 month comparison, both horizons and the size allocation. Server-rendered; no script. */
export function ScenarioACorePanels({ model }: { model: RedFlagModel }) {
  const r = model.result;
  if (!r) return null;
  const w = r.window;
  const c = r.comparison;
  const a = r.inbound.sizeAllocation;
  const ds = r.config.horizonWeeks;
  const sample = c.rows.filter((x) => x.match6 === false || x.match12 === false).slice(0, 5);
  return (
    <>
      <Panel>
        <PanelTitle>Forecast basis</PanelTitle>
        <dl data-testid="forecast-basis" className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-slate-500">Last observed sales month</dt>
            <dd data-testid="basis-last-month" className="font-medium text-slate-900">{w.lastHistoryMonth ?? "none"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Stock as-at date</dt>
            <dd data-testid="basis-stock-date" className="font-medium text-slate-900">{r.config.stockDate}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Missing intervening months (none invented)</dt>
            <dd data-testid="basis-gap" className="font-medium text-slate-900">{w.gapMonths.length === 0 ? "none" : w.gapMonths.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Forecast averaging window</dt>
            <dd data-testid="basis-window" className="font-medium text-slate-900">{w.months.length} month(s): {w.months[0]} to {w.months[w.months.length - 1]}</dd>
          </div>
        </dl>
        {w.staleWarning && (
          <p data-testid="stale-warning" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {w.staleWarning} The forecast uses the latest observed months, which is also how the workbook&apos;s own six- and twelve-month averages are built.
          </p>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Which outputs are available</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Each output is judged on its own. An open rule withholds only what truly depends on it.</p>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Output</TH>
                <TH>State</TH>
                <TH>Note</TH>
              </TR>
            </THead>
            <TBody>
              {model.eligibility.map((e) => (
                <TR key={e.id}>
                  <TD>
                    <span data-testid="eligibility-row" data-id={e.id} data-state={e.state} />
                    {e.label}
                  </TD>
                  <TD>
                    <Badge tone={TONE[e.state]}>{STATE_TEXT[e.state]}</Badge>
                  </TD>
                  <TD>{e.note}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Six- and twelve-month averages, reconciled to the workbook&apos;s own references</PanelTitle>
        <p data-testid="comparison-summary" className="mt-1 text-sm text-slate-700">
          Both averages end at {c.windowEnd}. Six-month: {c.matched6} of {c.compared6} SKUs agree with the workbook&apos;s own 6-month average. Twelve-month: {c.matched12} of {c.compared12} agree with its 12-month average. Planner exclusions are not applied here: this reconciles the raw history.
        </p>
        {sample.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>SKU (first differences)</TH>
                  <TH align="right">6-month</TH>
                  <TH align="right">Reference 6</TH>
                  <TH align="right">12-month</TH>
                  <TH align="right">Reference 12</TH>
                </TR>
              </THead>
              <TBody>
                {sample.map((x) => (
                  <TR key={x.sku}>
                    <TD>{x.sku}</TD>
                    <TD align="right" numeric>{n1(x.avg6)}</TD>
                    <TD align="right" numeric>{n1(x.ref6)}</TD>
                    <TD align="right" numeric>{n1(x.avg12)}</TD>
                    <TD align="right" numeric>{n1(x.ref12)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Replenishment by horizon: two different formulas, both shown</PanelTitle>
        <p data-testid="formula-note" className="mt-1 text-sm text-slate-700">
          <span className="font-semibold">Approved rule (unchanged):</span> proposed order = the largest projected shortfall against the minimum level over the horizon. <span className="font-semibold">RFP DP-13 net requirement:</span> forecast demand over the horizon, less available stock, less usable inbound supply (committed stock is already netted in Available). They answer different questions and are not interchangeable. OWNER DECISION REQUIRED: which formula drives purchasing. The table above uses the {ds}-week horizon.
        </p>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{model.settings.view === "sku" ? "SKU" : "Style"}</TH>
                <TH align="right">13 wk: approved</TH>
                <TH align="right">13 wk: RFP net</TH>
                <TH align="right">26 wk: approved</TH>
                <TH align="right">26 wk: RFP net</TH>
              </TR>
            </THead>
            <TBody>
              {model.horizons.map((h) => (
                <TR key={h.key}>
                  <TD>
                    <span data-testid="horizon-row" data-key={h.key} data-a13={model.withheld.proposedOrders ? "" : h.h13.proposed} data-n13={model.withheld.proposedOrders ? "" : (h.h13.net ?? "")} data-a26={model.withheld.proposedOrders ? "" : h.h26.proposed} data-n26={model.withheld.proposedOrders ? "" : (h.h26.net ?? "")} />
                    {h.label}
                    {h.tender && <span className="ml-1 text-xs text-slate-500">(tender)</span>}
                  </TD>
                  <TD align="right" numeric>{model.withheld.proposedOrders ? "Withheld" : h.h13.proposed > 0 ? n0(h.h13.proposed) : dash}</TD>
                  <TD align="right" numeric>{model.withheld.proposedOrders ? "Withheld" : h.h13.net === null ? "n/a" : h.h13.net > 0 ? n0(h.h13.net) : dash}</TD>
                  <TD align="right" numeric>{model.withheld.proposedOrders ? "Withheld" : h.h26.proposed > 0 ? n0(h.h26.proposed) : dash}</TD>
                  <TD align="right" numeric>{model.withheld.proposedOrders ? "Withheld" : h.h26.net === null ? "n/a" : h.h26.net > 0 ? n0(h.h26.net) : dash}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Style-level purchase orders split to sizes</PanelTitle>
        {a.curveLabel === null ? (
          <p data-testid="size-none" className="mt-1 text-sm text-slate-700">No size curve is applied, so style-level purchase-order quantities are held unallocated ({n0(r.inbound.unallocatedStyleUnits)} units).</p>
        ) : (
          <>
            <p data-testid="size-curve-label" className="mt-1 text-sm text-slate-700">
              Curve applied: {a.curveLabel}.{a.curveProvenance ? ` Source: ${a.curveProvenance}` : ""}
            </p>
            <p data-testid="size-reconciliation" className="mt-1 text-sm text-slate-700">
              {n0(a.unitsIn)} units on style-level lines in, {n0(a.unitsAllocated)} units allocated to sizes: {a.reconciles && a.unitsIn === a.unitsAllocated ? "reconciles exactly" : "DOES NOT RECONCILE"}. Rounding is largest remainder, ties to the earlier size.
            </p>
            {a.lines.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>PO / style</TH>
                      <TH align="right">Style quantity</TH>
                      <TH>Allocated by size</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {a.lines.map((l) => (
                      <TR key={`${l.poNo}|${l.styleCode}`}>
                        <TD>
                          <span data-testid="alloc-line" data-sum={l.parts.reduce((x, p) => x + p.units, 0)} data-qty={l.qty} />
                          {l.poNo} / {l.styleCode}
                        </TD>
                        <TD align="right" numeric>{n0(l.qty)}</TD>
                        <TD>{l.parts.map((p) => `${p.size} ${n0(p.units)}`).join(", ")}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </>
        )}
        <p data-testid="overdue-note" className="mt-3 text-sm text-slate-700">
          Overdue on-water units ({n0(r.inbound.overdueOnWaterUnits)}) are kept apart from Available and are never counted as received. Treatment: {r.config.overdueOnWater === "exclude" ? "excluded from usable inbound (conservative demonstration assumption)" : "assumed to arrive in week 1 (demonstration assumption)"}. Stock In transit is never added to purchase-order quantities.
        </p>
      </Panel>
    </>
  );
}
