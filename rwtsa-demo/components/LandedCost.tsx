import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { fromCents, type Cents } from "@/rwtsa-demo/engine/money";
import { scenarioById } from "@/rwtsa-demo/state/layers";
import type { LandedModel } from "@/rwtsa-demo/state/landed-model";
import { LayerBadge, ProvenanceBadge, ReadinessBadge } from "./Badges";
import { RulesBadge, RulesPanel } from "./Rules";

const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = (c: Cents | null, cur: "R" | "$" = "R"): string => {
  if (c === null) return "-";
  const v = fromCents(Math.abs(c)).toFixed(2);
  const [i, d] = v.split(".");
  return `${c < 0 ? "-" : ""}${cur}${group(i)}.${d}`;
};
const signed = (c: Cents | null): string => (c === null ? "-" : `${c > 0 ? "+" : ""}${money(c)}`);
const qty = (n: number): string => {
  const [i, d] = String(n).split(".");
  return d === undefined ? group(i) : `${group(i)}.${d}`;
};
const rate = (v: number | null): string => (v === null ? "-" : String(v));
const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";

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

function ExposureChart({ buckets }: { buckets: readonly { key: string; usdCents: number; coveredUsdCents: number; uncoveredUsdCents: number }[] }) {
  const W = 720;
  const H = 230;
  const m = { l: 70, r: 12, t: 12, b: 40 };
  const max = Math.max(1, ...buckets.map((b) => b.usdCents));
  const bw = (W - m.l - m.r) / buckets.length;
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b);
  return (
    <figure data-testid="exposure-chart" className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="USD exposure by due date, covered by an FEC and uncovered" className="h-auto w-full max-w-3xl">
        <title>USD exposure by due date</title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={m.l} x2={W - m.r} y1={y(f * max)} y2={y(f * max)} stroke="#e2e8f0" />
            <text x={m.l - 6} y={y(f * max) + 4} textAnchor="end" fontSize="11" fill="#475569">
              {money(Math.round(f * max), "$").replace(/\.00$/, "")}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = m.l + i * bw + bw * 0.15;
          const w = bw * 0.7;
          return (
            <g key={b.key} data-testid="exposure-bar" data-key={b.key} data-covered={b.coveredUsdCents} data-uncovered={b.uncoveredUsdCents}>
              <rect x={x} y={y(b.coveredUsdCents)} width={w} height={y(0) - y(b.coveredUsdCents)} fill="#1d4ed8" />
              <rect x={x} y={y(b.usdCents)} width={w} height={y(b.coveredUsdCents) - y(b.usdCents)} fill="#b45309" />
              <text x={x + w / 2} y={H - 22} textAnchor="middle" fontSize="11" fill="#475569">
                {b.key}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-600">Blue: covered by an FEC (reference and locked rate). Amber: uncovered. USD, by due date.</figcaption>
    </figure>
  );
}

export function LandedPageView({ model }: { model: LandedModel }) {
  const s = model.settings;
  const r = model.landed;
  const x = model.exposure;
  const meta = scenarioById("C");
  const incomplete = r ? r.lines.filter((l) => l.status === "incomplete").length : 0;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scenario C</p>
        <h1 className="text-xl font-semibold text-slate-900">Imports, landed cost and foreign currency</h1>
        <p className="mt-1 text-sm text-slate-600">Shipment-specific landed cost, estimated versus actual, and USD exposure by due date, calculated on this machine from the loaded data.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={model.provenance} />
          <span data-testid="structure">
            <Badge tone={model.structure === "PASS" ? "success" : "danger"}>{`STRUCTURE ${model.structure}`}</Badge>
          </span>
          <ReadinessBadge readiness={model.readiness} />
          <span data-testid="engine">
            <Badge tone={model.engine === "AVAILABLE" ? "success" : "danger"}>{`ENGINE ${model.engine}`}</Badge>
          </span>
          <Badge tone="success">CALCULATED HERE: TOOLBOX</Badge>
          <RulesBadge rules={model.rules} />
        </div>
      </div>

      <Alert tone={model.banner.tone === "neutral" ? "info" : model.banner.tone}>{model.banner.text}</Alert>
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
          <p className="mt-2 text-sm text-slate-700">The validator reports the inputs for this scenario as present and populated. The assumptions below still apply.</p>
        ) : (
          <div className="mt-2">
            <Alert tone="warning">The engines being available does not make the data ready. These inputs are NOT READY, so treat any figure below as indicative only.</Alert>
            <ul data-testid="reasons" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {model.readinessReasons.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
        {model.engineNote && <p className="mt-2 text-sm text-red-700">{model.engineNote}</p>}
      </Panel>

      <RulesPanel rules={model.rules} />

      <Panel>
        <PanelTitle>Where each function lives</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Only the TOOLBOX rows are calculated on this page. Purchasing and receipts belong to Cin7 Core, and bills, payments and aged payables to Xero; this page neither reads nor writes either.</p>
        <div data-testid="layers" className="mt-3 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Capability</TH>
                <TH>Layer</TH>
                <TH>Native claim</TH>
              </TR>
            </THead>
            <TBody>
              {meta.capabilities.map((c) => (
                <TR key={c.name}>
                  <TD>{c.name}</TD>
                  <TD>
                    <LayerBadge layer={c.layer} />
                  </TD>
                  <TD>{c.verify ? <Badge tone="warning">TO BE VERIFIED INDEPENDENTLY</Badge> : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      {!r || !x ? (
        <Panel>
          <EmptyState title="No results" description="No validated dataset is loaded, so there is nothing to calculate. Nothing has been substituted." />
        </Panel>
      ) : (
        <>
          <Panel>
            <PanelTitle>Assumptions and warnings (none hidden)</PanelTitle>
            <ul data-testid="assumptions" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {r.assumptions.map((a) => (
                <li key={a.id} data-assumption={a.id}>
                  {a.text}
                </li>
              ))}
            </ul>
            {(r.shipments.some((sh) => sh.warnings.length > 0) || x.warnings.length > 0) && (
              <>
                <p className="mt-3 text-sm font-medium text-slate-800">Warnings on these results</p>
                <ul data-testid="warnings" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {r.shipments.flatMap((sh) => sh.warnings.map((w) => <li key={`${sh.shipmentRef}|${w}`}>{`${sh.shipmentRef}: ${w}`}</li>))}
                  {x.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Controls</PanelTitle>
            <form method="get" action="/scenario-c" data-testid="controls" className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-sm">
              <label className="flex flex-col gap-1">
                Duty rate on customs value (%), blank = workbook duty amounts
                <input name="duty" type="number" min={0} max={100} step="any" defaultValue={s.values.duty} className={`${field} w-28`} />
              </label>
              <label className="flex flex-col gap-1">
                Shipment
                <select name="ship" defaultValue={s.shipment ?? ""} className={field}>
                  <option value="">All shipments</option>
                  {model.shipmentRefs.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input name="issues" type="checkbox" value="1" defaultChecked={s.issuesOnly} />
                Lines with issues only
              </label>
              <label className="flex flex-col gap-1">
                Exposure as-at date
                <input name="asof" type="date" defaultValue={s.values.asof} className={field} />
              </label>
              {model.provenance === "LOCAL WORKBOOK" && (
                <label className="flex flex-col gap-1">
                  Paid / open status (no paid column in the workbook)
                  <select name="exposure" defaultValue={s.values.exposure} className={field}>
                    <option value="">Not chosen (exposure withheld)</option>
                    <option value="due">Treat payments due on or after the as-at date as open</option>
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                Exposure buckets
                <select name="bucket" defaultValue={s.values.bucket} className={field}>
                  <option value="month">Month</option>
                  <option value="week">Week</option>
                </select>
              </label>
              <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white">
                Recalculate
              </button>
              <Link href="/scenario-c" prefetch={false} className="py-1.5 text-primary hover:underline">
                Reset to defaults
              </Link>
            </form>
          </Panel>

          <div data-testid="indicators" className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Indicator label="Shipments" testid="ind-shipments" value={String(r.shipments.length)} hint={`${r.lines.length} lines`} />
            <Indicator label="Landed cost (actual)" testid="ind-landed" value={money(r.totals.landedActualCents)} hint={r.totals.complete ? "all lines complete" : "complete lines only"} />
            <Indicator label="FX variance" testid="ind-variance" value={signed(r.totals.fxVarianceCents)} hint={`actual minus estimate (planning FX)${r.totals.complete ? "" : "; complete lines only"}`} />
            <Indicator label="Incomplete lines" testid="ind-incomplete" value={String(incomplete)} hint="inputs missing, nothing invented" />
            <Indicator label="Open USD exposure" testid="ind-exposure" value={model.exposureWithheld ? "Withheld" : money(x.totals.openUsdCents, "$")} hint={model.exposureWithheld ? "paid / open status unresolved" : `uncovered ${money(x.totals.uncoveredUsdCents, "$")}`} />
          </div>

          <Panel>
            <PanelTitle>Reconciliation</PanelTitle>
            <div data-testid="checks" className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Check</TH>
                    <TH>Result</TH>
                    <TH>Detail</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.checks.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <span data-testid="check" data-id={c.id} data-ok={String(c.ok)} />
                        {c.label}
                      </TD>
                      <TD>
                        <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "OK" : "ATTENTION"}</Badge>
                      </TD>
                      <TD>{c.detail}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Shipments</PanelTitle>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Shipment</TH>
                    <TH align="right">Lines</TH>
                    <TH align="right">CBM</TH>
                    <TH align="right">Customs value</TH>
                    <TH align="right">Duty</TH>
                    <TH align="right">Freight (allocated / shipment)</TH>
                    <TH align="right">Landed (actual)</TH>
                    <TH align="right">Landed (estimate)</TH>
                    <TH align="right">FX variance</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.shipments
                    .filter((sh) => s.shipment === null || sh.shipmentRef === s.shipment)
                    .map((sh) => {
                      const t = sh.totals ?? sh.partial;
                      return (
                        <TR key={sh.shipmentRef}>
                          <TD>
                            <span data-testid="shipment-row" data-key={sh.shipmentRef} data-landed={t.landedActualCents} data-complete={String(sh.complete)} />
                            {sh.shipmentRef}
                          </TD>
                          <TD align="right" numeric>
                            {sh.lineCount}
                          </TD>
                          <TD align="right" numeric>
                            {sh.totalCbm}
                          </TD>
                          <TD align="right" numeric>
                            {money(t.customsValueCents)}
                          </TD>
                          <TD align="right" numeric>
                            {money(t.dutyCents)}
                          </TD>
                          <TD align="right" numeric>
                            {money(sh.freightAllocatedCents)} / {money(sh.freightTotalCents)}
                          </TD>
                          <TD align="right" numeric>
                            {money(t.landedActualCents)}
                            {!sh.complete && " (partial)"}
                          </TD>
                          <TD align="right" numeric>
                            {money(t.landedEstimatedCents)}
                            {!sh.complete && " (partial)"}
                          </TD>
                          <TD align="right" numeric>
                            {signed(t.fxVarianceCents)}
                            {!sh.complete && " (partial)"}
                          </TD>
                          <TD>{sh.complete ? <Badge tone="success">COMPLETE</Badge> : <Badge tone="warning">{`INCOMPLETE: partial (${sh.partial.lineCount} of ${sh.lineCount} lines)`}</Badge>}</TD>
                        </TR>
                      );
                    })}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>SKU landed cost by shipment (freight allocated by CBM share within the shipment only)</PanelTitle>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Shipment</TH>
                    <TH>SKU</TH>
                    <TH align="right">Qty</TH>
                    <TH align="right">CBM share</TH>
                    <TH align="right">FOB USD</TH>
                    <TH align="right">Customs value</TH>
                    <TH align="right">Duty</TH>
                    <TH align="right">Freight</TH>
                    <TH align="right">Landed (actual)</TH>
                    <TH align="right">Per unit</TH>
                    <TH align="right">Estimate</TH>
                    <TH align="right">FX variance</TH>
                    <TH>Missing inputs</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.lines.length === 0 && (
                    <TR>
                      <TD>
                        <span data-testid="no-lines">No lines match these filters.</span>
                      </TD>
                    </TR>
                  )}
                  {model.lines.map((l) => (
                    <TR key={`${l.shipmentRef}|${l.sku}`}>
                      <TD>
                        <span data-testid="line" data-shipment={l.shipmentRef} data-sku={l.sku} data-landed={l.landedActualCents ?? ""} data-freight={l.freightCents ?? ""} />
                        {l.shipmentRef}
                      </TD>
                      <TD>{l.sku}</TD>
                      <TD align="right" numeric>
                        {qty(l.qty)}
                      </TD>
                      <TD align="right" numeric>
                        {l.cbmShare === null ? "-" : `${(l.cbmShare * 100).toFixed(1)}%`}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.fobUsdCents, "$")}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.customsValueCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.dutyCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.freightCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.landedActualCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.landedPerUnitActualCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(l.landedEstimatedCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(l.fxVarianceCents)}
                      </TD>
                      <TD>{l.missing.length === 0 ? "-" : <span className="text-amber-700">{l.missing.join(", ")}</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>SKU totals across shipments</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Each shipment&apos;s own allocation, added up. Freight is never re-allocated by SKU.</p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>SKU</TH>
                    <TH>Shipments</TH>
                    <TH align="right">Qty</TH>
                    <TH align="right">Freight</TH>
                    <TH align="right">Landed (actual)</TH>
                    <TH align="right">Per unit</TH>
                    <TH align="right">FX variance</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.skus.map((k) => (
                    <TR key={k.sku}>
                      <TD>
                        <span data-testid="sku-row" data-sku={k.sku} data-shipments={k.shipments.length} />
                        {k.sku}
                      </TD>
                      <TD>{k.shipments.join(", ")}</TD>
                      <TD align="right" numeric>
                        {qty(k.qty)}
                      </TD>
                      <TD align="right" numeric>
                        {money(k.freightCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(k.landedActualCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(k.perUnitActualCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(k.fxVarianceCents)}
                      </TD>
                      <TD>{k.complete ? "complete" : "partial"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>FX rates used, and where each comes from</PanelTitle>
            <div data-testid="rates" className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Shipment</TH>
                    <TH>Planning FX (LandedCost.planningFx)</TH>
                    <TH>Customs FX (LandedCost.customsFx)</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.rates.map((t) => (
                    <TR key={t.shipmentRef}>
                      <TD>{t.shipmentRef}</TD>
                      <TD>{t.planning.length === 0 ? "missing" : t.planning.join(", ")}</TD>
                      <TD>{t.customs.length === 0 ? "missing" : t.customs.join(", ")}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          {model.exposureWithheld ? (
            <Panel>
              <PanelTitle>USD exposure by due date (read-only)</PanelTitle>
              <p data-testid="exposure-withheld" className="mt-2 text-sm text-slate-700">
                Withheld: the workbook has no paid-status column, so which payments are still open is not known. Choose the basis in the controls to see the exposure; nothing has been assumed.
              </p>
            </Panel>
          ) : (
          <Panel>
            <PanelTitle>USD exposure by due date (read-only)</PanelTitle>
            <p className="mt-1 text-sm text-slate-600">
              {model.provenance === "LOCAL WORKBOOK" ? "Basis chosen on this page: " : ""}Payments due on or after {x.asOf}. Not a forward-contract register; nothing is recorded. The workbook has no paid flag.
            </p>
            {x.buckets.length === 0 ? (
              <p className="mt-3 text-sm text-slate-700" data-testid="no-exposure">
                No open USD payments on or after the as-at date.
              </p>
            ) : (
              <div className="mt-3">
                <ExposureChart buckets={x.buckets} />
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Due ({x.bucket})</TH>
                        <TH align="right">Payments</TH>
                        <TH align="right">USD</TH>
                        <TH align="right">Covered by FEC</TH>
                        <TH align="right">Uncovered</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {x.buckets.map((b) => (
                        <TR key={b.key}>
                          <TD>
                            <span data-testid="bucket-row" data-key={b.key} data-usd={b.usdCents} />
                            {b.key}
                          </TD>
                          <TD align="right" numeric>
                            {b.count}
                          </TD>
                          <TD align="right" numeric>
                            {money(b.usdCents, "$")}
                          </TD>
                          <TD align="right" numeric>
                            {money(b.coveredUsdCents, "$")}
                          </TD>
                          <TD align="right" numeric>
                            {money(b.uncoveredUsdCents, "$")}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
            )}
          </Panel>

          )}

          <Panel>
            <PanelTitle>Planning, FEC and customs FX compared, per payment</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Positive = the FEC costs more than that rate would. Rates are matched through ImportPOs to one shipment; where that is not possible the comparison is withheld, not guessed.</p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>PO</TH>
                    <TH>Due</TH>
                    <TH align="right">USD</TH>
                    <TH>FEC (Payments_FEC)</TH>
                    <TH align="right">ZAR at FEC</TH>
                    <TH align="right">ZAR at planning</TH>
                    <TH align="right">ZAR at customs</TH>
                    <TH align="right">FEC vs planning</TH>
                    <TH align="right">FEC vs customs</TH>
                    <TH>Note</TH>
                  </TR>
                </THead>
                <TBody>
                  {x.rows.map((p) => (
                    <TR key={`${p.poNo}|${p.dueDate}|${p.usdCents}`}>
                      <TD>
                        <span data-testid="payment-row" data-po={p.poNo} data-open={String(p.open)} />
                        {p.poNo}
                        {p.deposit && (
                          <div>
                            <Badge tone="neutral">DEPOSIT</Badge>
                          </div>
                        )}
                      </TD>
                      <TD>
                        {p.dueDate}
                        {!p.open && <div className="text-xs text-amber-700">before as-at date; paid status unknown</div>}
                      </TD>
                      <TD align="right" numeric>
                        {money(p.usdCents, "$")}
                      </TD>
                      <TD>{p.covered ? `${p.fecRef} @ ${rate(p.lockedRate)}` : "none"}</TD>
                      <TD align="right" numeric>
                        {money(p.zarAtFecCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(p.zarAtPlanningCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(p.zarAtCustomsCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(p.fecVsPlanningCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(p.fecVsCustomsCents)}
                      </TD>
                      <TD>{p.rateNote ? <span className="text-xs text-amber-700">{p.rateNote}</span> : "-"}</TD>
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
