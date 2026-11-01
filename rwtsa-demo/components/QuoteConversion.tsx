import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { fromCents, type Cents } from "@/rwtsa-demo/engine/money";
import { ISSUE_CODES, ISSUE_LABELS, type GroupMetrics } from "@/rwtsa-demo/engine/quote-conversion";
import type { CrmModel } from "@/rwtsa-demo/state/crm-model";
import { scenarioById } from "@/rwtsa-demo/state/layers";
import { formatRate } from "@/rwtsa-demo/state/crm-format";
import { LayerBadge, ProvenanceBadge, ReadinessBadge } from "./Badges";
import { RulesBadge } from "./Rules";

const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = (c: Cents | null): string => {
  if (c === null) return "-";
  const [i, d] = fromCents(Math.abs(c)).toFixed(2).split(".");
  return `${c < 0 ? "-" : ""}R${group(i)}.${d}`;
};
const pct = formatRate;
const raw2 = (n: number | null): string => (n === null ? "" : n.toFixed(2));
const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";
const MAX_DETAIL = 200;

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

/** Horizontal bars as plain HTML (no chart library, no script). A null value draws no bar and says N/A. */
function Bars({ title, caption, rows, max, format }: { title: string; caption: string; rows: readonly { key: string; value: number | null; pct: string }[]; max: number; format: (n: number | null) => string }) {
  return (
    <figure data-testid="conv-chart" className="m-0" aria-label={title}>
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 text-xs">
            <span data-testid="conv-bar" data-key={r.key} data-pct={r.pct} />
            <span className="w-40 shrink-0 truncate text-slate-700">{r.key}</span>
            <span className="h-3 flex-1 rounded bg-slate-100" aria-hidden="true">
              {r.value !== null && <span className="block h-3 rounded bg-blue-700" style={{ width: `${Math.max(0, Math.min(100, max > 0 ? (r.value / max) * 100 : 0))}%` }} />}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-slate-900">{format(r.value)}</span>
          </li>
        ))}
      </ul>
      <figcaption className="mt-1 text-xs text-slate-600">{caption}</figcaption>
    </figure>
  );
}

function GroupTable({ rows, testid, first }: { rows: readonly GroupMetrics[]; testid: string; first: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>{first}</TH>
            <TH align="right">Quotes</TH>
            <TH align="right">Won</TH>
            <TH align="right">Lost</TH>
            <TH align="right">Open</TH>
            <TH align="right">Unclassified</TH>
            <TH align="right">Won value</TH>
            <TH align="right">Closed value</TH>
            <TH align="right">Count conversion</TH>
            <TH align="right">Value conversion</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((g) => (
            <TR key={g.key}>
              <TD>
                <span data-testid={testid} data-key={g.key} data-quotes={g.quotes} data-won={g.won} data-lost={g.lost} data-open={g.open} data-unclassified={g.unclassified} data-closed={g.closed} data-won-cents={g.wonCents} data-closed-cents={g.closedCents} data-count-pct={raw2(g.countConversionPct)} data-value-pct={raw2(g.valueConversionPct)} />
                {g.key}
              </TD>
              <TD align="right" numeric>{g.quotes}</TD>
              <TD align="right" numeric>{g.won}</TD>
              <TD align="right" numeric>{g.lost}</TD>
              <TD align="right" numeric>{g.open}</TD>
              <TD align="right" numeric>{g.unclassified}</TD>
              <TD align="right" numeric>{money(g.wonCents)}</TD>
              <TD align="right" numeric>{money(g.closedCents)}</TD>
              <TD align="right" numeric>{pct(g.countConversionPct)}</TD>
              <TD align="right" numeric>{pct(g.valueConversionPct)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

const STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning"> = { WON: "success", LOST: "danger", OPEN: "info", UNCLASSIFIED: "warning" };

export function QuoteConversionPageView({ model }: { model: CrmModel }) {
  const s = model.settings;
  const r = model.result;
  const meta = scenarioById("D");
  const byCount = s.compare === "count";
  const barsOf = (rows: readonly GroupMetrics[]) => rows.map((g) => ({ key: g.key, value: byCount ? g.countConversionPct : g.valueConversionPct, pct: raw2(byCount ? g.countConversionPct : g.valueConversionPct) }));
  const period = s.grain === "month" ? "month" : s.grain === "quarter" ? "quarter" : "year";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scenario D</p>
        <h1 className="text-xl font-semibold text-slate-900">CRM, quote conversion and sales analytics</h1>
        <p className="mt-1 text-sm text-slate-600">Quote status, conversion by count and value, and win/loss reasons, calculated on this machine from the loaded quotes. It reads the data and writes nothing.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={model.provenance} />
          <span data-testid="structure">
            <Badge tone={model.structure === "PASS" ? "success" : "danger"}>{`STRUCTURE ${model.structure}`}</Badge>
          </span>
          <ReadinessBadge readiness={model.readiness} />
          <span data-testid="engine">
            <Badge tone={model.engine === "AVAILABLE" ? "success" : "danger"}>{`ENGINE ${model.engine}`}</Badge>
          </span>
          <span data-testid="real-workbook">
            <Badge tone="warning">{`REAL WORKBOOK: ${model.realWorkbook}`}</Badge>
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
              <li key={e}>
                <span data-testid="settings-error" />
                {e}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Panel>
        <PanelTitle>Data readiness is separate from the engine</PanelTitle>
        {model.readiness === "READY" ? (
          <p className="mt-2 text-sm text-slate-700">The validator reports the quote inputs as present and populated. It cannot confirm that the figures are right, so the assumptions below still apply.{r && r.total.unclassified > 0 ? ` ${r.total.unclassified} quote(s) have an unrecognised status (UNCLASSIFIED), so READY here does not mean the analysis is complete.` : ""}</p>
        ) : (
          <div className="mt-2">
            <Alert tone="warning">The engine being available does not make the data ready. These inputs are NOT READY, so treat any figure below as indicative only.</Alert>
            <ul data-testid="reasons" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {model.readinessReasons.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
        {model.engineNote && <p className="mt-2 text-sm text-red-700">{model.engineNote}</p>}
      </Panel>

      <Panel>
        <PanelTitle>Where each function lives</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Only the TOOLBOX rows are calculated on this page. Customers, quotations and sales orders are source records held in Cin7 Core. This demonstration is not synchronised with Cin7 Core, creates no quotation or sales order, and calls no Cin7 Core or Xero service. Xero is not needed for this module.</p>
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
              {meta.capabilities.map((cap) => (
                <TR key={cap.name}>
                  <TD>{cap.name}</TD>
                  <TD>
                    <LayerBadge layer={cap.layer} />
                  </TD>
                  <TD>{cap.verify ? <Badge tone="warning">TO BE VERIFIED INDEPENDENTLY</Badge> : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      {!r ? (
        <Panel>
          <EmptyState title="No results" description="No validated dataset is loaded, so there is nothing to calculate. Nothing has been substituted." />
        </Panel>
      ) : (
        <>
          <Panel>
            <PanelTitle>Completeness of this analysis</PanelTitle>
            <p data-testid="completeness" className={`mt-2 inline-block rounded-md px-2 py-1 text-sm font-semibold ${r.completeness.complete ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
              {r.completeness.complete ? (r.completeness.scope === "filtered" ? "ANALYSIS COMPLETE FOR THIS FILTERED VIEW" : "ANALYSIS COMPLETE") : "ANALYSIS INCOMPLETE"}
            </p>
            {r.completeness.reasons.length > 0 && (
              <ul data-testid="incomplete-reasons" className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {r.completeness.reasons.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            {r.completeness.notes.length > 0 && (
              <ul data-testid="notes" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {r.completeness.notes.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            {ISSUE_CODES.some((c) => r.issues[c] > 0) && (
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Finding</TH>
                      <TH align="right">Quotes</TH>
                      <TH>Quote references (first {50})</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {ISSUE_CODES.filter((c) => r.issues[c] > 0).map((c) => (
                      <TR key={c}>
                        <TD>
                          <span data-testid="finding-row" data-code={c} data-count={r.issues[c]} data-refs={r.issueRefs[c].join(",")} />
                          {ISSUE_LABELS[c]}
                        </TD>
                        <TD align="right" numeric>{r.issues[c]}</TD>
                        <TD>{r.issueRefs[c].join(", ")}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
            {r.unclassifiedValues.length > 0 && <p className="mt-2 text-sm text-slate-700">Status text not recognised: {r.unclassifiedValues.join("; ")}.</p>}
            <p className="mt-3 text-sm font-medium text-slate-800">Assumptions (none hidden)</p>
            <ul data-testid="assumptions" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {r.assumptions.map((a) => (
                <li key={a.id} data-assumption={a.id}>
                  {a.text}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <PanelTitle>Controls</PanelTitle>
            <form method="get" action="/scenario-d" data-testid="controls" className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-sm">
              <label className="flex flex-col gap-1">
                Quote date from
                <input name="from" type="date" defaultValue={s.values.from} className={field} />
              </label>
              <label className="flex flex-col gap-1">
                Quote date to
                <input name="to" type="date" defaultValue={s.values.to} className={field} />
              </label>
              <label className="flex flex-col gap-1">
                Reporting period
                <select name="grain" defaultValue={s.values.grain} className={field}>
                  <option value="month">Month</option>
                  <option value="quarter">Quarter</option>
                  <option value="year">Year</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Sales representative
                <select name="rep" defaultValue={s.values.rep} className={field}>
                  <option value="">All</option>
                  {r.options.reps.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Customer
                <select name="customer" defaultValue={s.values.customer} className={field}>
                  <option value="">All</option>
                  {r.options.customers.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              {r.options.products.length > 0 ? (
                <label className="flex flex-col gap-1">
                  Product
                  <select name="product" defaultValue={s.values.product} className={field}>
                    <option value="">All</option>
                    {r.options.products.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="flex flex-col gap-1">
                Quote status (list only)
                <select name="status" defaultValue={s.values.status} className={field}>
                  <option value="ALL">All</option>
                  <option value="WON">Won</option>
                  <option value="LOST">Lost</option>
                  <option value="OPEN">Open</option>
                  <option value="UNCLASSIFIED">Unclassified</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Compare conversion
                <select name="compare" defaultValue={s.values.compare} className={field}>
                  <option value="count">By count</option>
                  <option value="value">By value</option>
                </select>
              </label>
              <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white">
                Recalculate
              </button>
              <Link href="/scenario-d" prefetch={false} className="py-1.5 text-primary hover:underline">
                Reset to defaults
              </Link>
            </form>
            <p data-testid="filter-note" className="mt-3 text-xs text-slate-600">
              Showing {r.filtered.shown} of {r.filtered.total} quotes. Periods use the {r.dateField}.
              {r.filtered.undatedExcluded > 0 ? ` ${r.filtered.undatedExcluded} undated quote(s) are left out because a date range is set.` : ""} The status filter applies to the quote list only, because conversion needs both won and lost quotes.
            </p>
          </Panel>

          <div data-testid="indicators" className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Indicator label="Total quotes" testid="ind-total" value={String(r.total.quotes)} hint={r.total.unclassified > 0 ? `${r.total.unclassified} unclassified` : "every status recognised"} />
            <Indicator label="Won quotes" testid="ind-won" value={String(r.total.won)} hint={money(r.total.wonCents)} />
            <Indicator label="Lost quotes" testid="ind-lost" value={String(r.total.lost)} hint={money(r.total.lostCents)} />
            <Indicator label="Open quotes" testid="ind-open" value={String(r.total.open)} hint={money(r.total.openCents)} />
            <Indicator label="Count conversion" testid="ind-count-conv" value={pct(r.total.countConversionPct)} hint={`${r.total.won} won of ${r.total.closed} closed`} />
            <Indicator label="Value conversion" testid="ind-value-conv" value={pct(r.total.valueConversionPct)} hint={`${money(r.total.wonCents)} of ${money(r.total.closedCents)}`} />
          </div>

          <Panel>
            <PanelTitle>Conversion by sales representative</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Conversion = won / (won + lost). Open and unclassified quotes are not in the denominator.</p>
            <div className="mt-3">
              <Bars title="Conversion by representative" caption={`Conversion ${byCount ? "by count" : "by value"} per representative.`} rows={barsOf(r.byRep)} max={100} format={pct} />
            </div>
            <GroupTable rows={r.byRep} testid="rep-row" first="Representative" />
          </Panel>

          <Panel>
            <PanelTitle>Conversion by customer</PanelTitle>
            <GroupTable rows={r.byCustomer} testid="customer-row" first="Customer" />
          </Panel>

          <Panel>
            <PanelTitle>Conversion by {period} ({r.dateField})</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">A quote is placed in the period of its {r.dateField.toLowerCase()}. The workbook has no won or lost date.</p>
            <GroupTable rows={r.byPeriod} testid="period-row" first="Period" />
          </Panel>

          <Panel>
            <PanelTitle>Product performance</PanelTitle>
            {!r.byProduct.available ? (
              <p data-testid="product-unavailable" className="mt-2 text-sm text-slate-700">
                {r.byProduct.reason}
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-slate-600">
                  A quote that names several products is counted under each, so these counts are not additive ({r.byProduct.multiProductQuotes} multi-product quote(s); {r.byProduct.noProductQuotes} with no product). {r.byProduct.valueNote}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Product</TH>
                        <TH align="right">Quotes featuring</TH>
                        <TH align="right">Won</TH>
                        <TH align="right">Lost</TH>
                        <TH align="right">Open</TH>
                        <TH align="right">Unclassified</TH>
                        <TH align="right">Count conversion</TH>
                        <TH align="right">Single-product quotes</TH>
                        <TH align="right">Won value</TH>
                        <TH align="right">Closed value</TH>
                        <TH align="right">Value conversion</TH>
                        <TH align="right">Closed multi-product quotes (value withheld)</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {r.byProduct.rows.map((p) => (
                        <TR key={p.key}>
                          <TD>
                            <span data-testid="product-row" data-key={p.key} data-quotes={p.quotes} data-won={p.won} data-lost={p.lost} data-sole={p.soleQuotes} data-count-pct={raw2(p.countConversionPct)} data-value-pct={raw2(p.valueConversionPct)} />
                            {p.key}
                            {p.inItems === false ? " (not among Items)" : ""}
                          </TD>
                          <TD align="right" numeric>{p.quotes}</TD>
                          <TD align="right" numeric>{p.won}</TD>
                          <TD align="right" numeric>{p.lost}</TD>
                          <TD align="right" numeric>{p.open}</TD>
                          <TD align="right" numeric>{p.unclassified}</TD>
                          <TD align="right" numeric>{pct(p.countConversionPct)}</TD>
                          <TD align="right" numeric>{p.soleQuotes}</TD>
                          <TD align="right" numeric>{p.valueWithheld ? "Withheld" : money(p.wonCents)}</TD>
                          <TD align="right" numeric>{p.valueWithheld ? "Withheld" : money(p.closedCents)}</TD>
                          <TD align="right" numeric>{p.valueWithheld ? "Withheld" : pct(p.valueConversionPct)}</TD>
                          <TD align="right" numeric>{p.sharedClosed}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Win/loss by reason</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Lost quotes only. {r.reasons.complete ? "Every lost quote has a reason." : "Some lost quotes have no reason, so this analysis is incomplete; no reason has been assumed."}</p>
            {r.reasons.rows.length === 0 && r.reasons.missing.count === 0 ? (
              <p className="mt-2 text-sm text-slate-700">No lost quotes in this view.</p>
            ) : (
              <>
                <div className="mt-3">
                  <Bars
                    title="Lost quotes by reason"
                    caption={`Lost quotes by reason, ${byCount ? "by count" : "by value"}.`}
                    rows={r.reasons.rows.map((x) => ({ key: x.reason, value: byCount ? x.count : fromCents(x.cents), pct: String(byCount ? x.count : x.cents) }))}
                    max={Math.max(0, ...r.reasons.rows.map((x) => (byCount ? x.count : fromCents(x.cents))))}
                    format={(n) => (n === null ? "N/A" : byCount ? String(n) : money(Math.round(n * 100)))}
                  />
                </div>
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Reason</TH>
                        <TH align="right">Lost quotes</TH>
                        <TH align="right">Lost value</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {r.reasons.rows.map((x) => (
                        <TR key={x.key}>
                          <TD>
                            <span data-testid="reason-row" data-key={x.key} data-count={x.count} data-value-cents={x.cents} />
                            {x.reason}
                          </TD>
                          <TD align="right" numeric>{x.count}</TD>
                          <TD align="right" numeric>{money(x.cents)}</TD>
                        </TR>
                      ))}
                      {r.reasons.missing.count > 0 && (
                        <TR>
                          <TD>
                            <span data-testid="reason-missing-row" data-count={r.reasons.missing.count} data-value-cents={r.reasons.missing.cents} />
                            Reason missing (not a reason: no reason was recorded)
                          </TD>
                          <TD align="right" numeric>{r.reasons.missing.count}</TD>
                          <TD align="right" numeric>{money(r.reasons.missing.cents)}</TD>
                        </TR>
                      )}
                    </TBody>
                  </Table>
                </div>
              </>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Reconciliation</PanelTitle>
            <ul data-testid="checks" className="mt-2 space-y-1 text-sm text-slate-700">
              {r.checks.map((c) => (
                <li key={c.code}>
                  <span data-testid="check" data-code={c.code} data-pass={String(c.pass)} />
                  <Badge tone={c.pass ? "success" : "danger"}>{c.pass ? "PASS" : "FAIL"}</Badge> {c.label}: {c.detail}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <PanelTitle>Quote detail</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">
              {model.detail.length} quote(s){s.status === "ALL" ? "" : ` with status ${s.status}`}. The converted sales order is the original reference from the source; none is generated.
              {model.detail.length > MAX_DETAIL ? ` Showing the first ${MAX_DETAIL}.` : ""}
            </p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Quote reference</TH>
                    <TH>Customer</TH>
                    <TH>Sales representative</TH>
                    <TH>Quote date</TH>
                    <TH>Status</TH>
                    <TH align="right">Quote value</TH>
                    <TH>Lost reason</TH>
                    <TH>Converted sales order</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.detail.slice(0, MAX_DETAIL).map((q) => (
                    <TR key={q.ref}>
                      <TD>
                        <span data-testid="quote-row" data-ref={q.ref} data-status={q.status} data-reason={q.lostReason ?? ""} data-order={q.convertedOrder ?? ""} data-value-cents={q.valueCents ?? ""} />
                        {q.ref}
                      </TD>
                      <TD>{q.customer}</TD>
                      <TD>{q.rep ?? "(unassigned)"}</TD>
                      <TD>{q.date ?? "-"}</TD>
                      <TD>
                        <Badge tone={STATUS_TONE[q.status]}>{q.status}</Badge>
                        {q.status === "UNCLASSIFIED" ? ` ${q.rawStatus === "" ? "(blank)" : q.rawStatus.slice(0, 40)}` : ""}
                      </TD>
                      <TD align="right" numeric>{money(q.valueCents)}</TD>
                      <TD>{q.status === "LOST" ? (q.lostReason ?? "Reason missing") : "-"}</TD>
                      <TD>{q.status === "WON" ? (q.convertedOrder ?? "No sales order recorded") : q.convertedOrder ?? "-"}</TD>
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
