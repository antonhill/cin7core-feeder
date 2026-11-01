import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { fromCents, type Cents } from "@/rwtsa-demo/engine/money";
import { scenarioById } from "@/rwtsa-demo/state/layers";
import type { MfgModel } from "@/rwtsa-demo/state/mfg-model";
import { LayerBadge, ProvenanceBadge, ReadinessBadge } from "./Badges";
import { RulesBadge, RulesPanel } from "./Rules";

const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = (c: Cents | null): string => {
  if (c === null) return "-";
  const [i, d] = fromCents(Math.abs(c)).toFixed(2).split(".");
  return `${c < 0 ? "-" : ""}R${group(i)}.${d}`;
};
const signed = (c: Cents | null): string => (c === null ? "-" : `${c > 0 ? "+" : ""}${money(c)}`);
const num = (n: number | null, dp = 2): string => {
  if (n === null) return "-";
  const body = Math.abs(n).toFixed(dp);
  const [i, d] = body.split(".");
  const neg = n < 0 && Number(body) !== 0;
  return `${neg ? "-" : ""}${group(i)}${d === undefined ? "" : `.${d}`}`;
};
const pct = (n: number | null): string => (n === null ? "n/a" : `${n.toFixed(1)}%`);
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

function RecoveryChart({ groups }: { groups: readonly { key: string; labourRecoveryPct: number | null }[] }) {
  const W = 720;
  const H = 240;
  const m = { l: 56, r: 12, t: 14, b: 44 };
  const vals = groups.map((g) => g.labourRecoveryPct ?? 0);
  const max = Math.max(110, ...vals);
  const bw = (W - m.l - m.r) / groups.length;
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b);
  return (
    <figure data-testid="recovery-chart" className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Labour recovery percentage by group, against 100 percent" className="h-auto w-full max-w-3xl">
        <title>Labour recovery by group</title>
        {[0, 50, 100].map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 100 ? "#b45309" : "#e2e8f0"} strokeDasharray={t === 100 ? "6 4" : undefined} />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#475569">
              {t}%
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const x = m.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          const v = g.labourRecoveryPct;
          return (
            <g key={g.key} data-testid="recovery-bar" data-key={g.key} data-pct={v === null ? "" : v.toFixed(2)}>
              {v !== null && <rect x={x} y={y(v)} width={w} height={y(0) - y(v)} fill={v >= 100 ? "#15803d" : "#1d4ed8"} />}
              <text x={x + w / 2} y={H - 26} textAnchor="middle" fontSize="11" fill="#475569">
                {g.key.length > 14 ? `${g.key.slice(0, 13)}…` : g.key}
              </text>
              <text x={x + w / 2} y={(v === null ? y(0) : y(v)) - 4} textAnchor="middle" fontSize="11" fill="#0f172a">
                {pct(v)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-600">Total planned minutes over total actual minutes, per group. Dashed line: 100% (the plan was exactly recovered).</figcaption>
    </figure>
  );
}

const COMPOSITION: { key: string; label: string; fill: string }[] = [
  { key: "fabric-materials", label: "Fabric and materials", fill: "#1d4ed8" },
  { key: "trims-thread", label: "Trims and thread", fill: "#0e7490" },
  { key: "print-packaging", label: "Printing and packaging", fill: "#7c3aed" },
  { key: "other", label: "Other components", fill: "#64748b" },
  { key: "labour", label: "Labour (SMV x rate)", fill: "#15803d" },
  { key: "efficiency", label: "Efficiency allowance", fill: "#b45309" },
  { key: "overhead", label: "Overhead", fill: "#b91c1c" },
];

export function ManufacturingPageView({ model }: { model: MfgModel }) {
  const s = model.settings;
  const v = model.variance;
  const c = model.costing;
  const meta = scenarioById("B");
  const sizeSel = model.size;
  const totalCents = sizeSel?.totalCents ?? null;
  const incompleteCosts = c ? c.styles.flatMap((st) => st.sizes).filter((z) => z.status === "incomplete").length : 0;
  const allCosts = c ? c.styles.flatMap((st) => st.sizes).length : 0;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scenario B</p>
        <h1 className="text-xl font-semibold text-slate-900">Manufacturing, production variance and costing</h1>
        <p className="mt-1 text-sm text-slate-600">Production variance by order, style, line and order size, and per-size product cost from the bill of material and routing, calculated on this machine from the loaded data.</p>
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
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Panel>
        <PanelTitle>Data readiness is separate from the engine</PanelTitle>
        {model.readiness === "READY" ? (
          <p className="mt-2 text-sm text-slate-700">The validator reports the inputs for this scenario as present and populated. It does not check units or the percentage scale, so the assumptions below still apply.</p>
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
        <p className="mt-1 text-sm text-slate-600">Only the TOOLBOX rows are calculated on this page. The BOM and production orders are source records held in Cin7 Core; this page reads the loaded workbook, writes nothing, and builds no Fast React file.</p>
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

      {!v || !c ? (
        <Panel>
          <EmptyState title="No results" description="No validated dataset is loaded, so there is nothing to calculate. Nothing has been substituted." />
        </Panel>
      ) : (
        <>
          <Panel>
            <PanelTitle>Assumptions and warnings (none hidden)</PanelTitle>
            <ul data-testid="assumptions" className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {[...v.assumptions, ...c.assumptions].map((a) => (
                <li key={a.id} data-assumption={a.id}>
                  {a.text}
                </li>
              ))}
            </ul>
            {(v.warnings.length > 0 || c.warnings.length > 0) && (
              <>
                <p className="mt-3 text-sm font-medium text-slate-800">Warnings on these results</p>
                <ul data-testid="warnings" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {[...v.warnings, ...c.warnings].map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            {c.scale === null && (
              <p data-testid="scale-observation" className="mt-3 text-sm text-slate-700">
                Overhead, efficiency and margin in the workbook look like: {c.scaleObservation.hint === "none" ? "no values" : c.scaleObservation.hint === "percent" ? "percent values (all above 1)" : c.scaleObservation.hint === "mixed" ? "a mix of values at and below 1 and above 1" : "values all at or below 1 (a fraction such as 0.15, or a very small percent: this cannot be told apart)"}
                {c.scaleObservation.count > 0 ? ` (${c.scaleObservation.count} values, ${c.scaleObservation.min} to ${c.scaleObservation.max})` : ""}. This is a hint only; choose the scale below.
              </p>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Controls</PanelTitle>
            <form method="get" action="/scenario-b" data-testid="controls" className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-sm">
              <label className="flex flex-col gap-1">
                Overhead and efficiency scale
                <select name="scale" defaultValue={s.values.scale} className={field}>
                  <option value="unset">Not chosen (percentage lines unresolved)</option>
                  <option value="fraction">Fraction (0.15 means 15%)</option>
                  <option value="percent">Percent (15 means 15%)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Markup (selling = cost x)
                <input name="markup" type="number" min={1} max={10} step="any" defaultValue={s.values.markup} className={`${field} w-24`} />
              </label>
              <label className="flex flex-col gap-1">
                Size-specific components
                <select name="rule" defaultValue={s.values.rule} className={field}>
                  <option value="replace">Replace the base component</option>
                  <option value="add">Add to the base components</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Order-size brackets (lower bounds)
                <input name="brackets" defaultValue={s.values.brackets} className={`${field} w-48`} />
              </label>
              <label className="flex flex-col gap-1">
                Group variance by
                <select name="by" defaultValue={s.values.by} className={field}>
                  <option value="style">Style</option>
                  <option value="line">Production line</option>
                  <option value="bracket">Order-size bracket</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Style
                <select name="style" defaultValue={model.style?.styleCode ?? ""} className={field}>
                  {model.styles.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Size
                <select name="size" defaultValue={sizeSel?.size ?? ""} className={field}>
                  {(model.style?.sizes ?? []).map((z) => (
                    <option key={z.size} value={z.size}>
                      {z.size}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white">
                Recalculate
              </button>
              <Link href="/scenario-b" prefetch={false} className="py-1.5 text-primary hover:underline">
                Reset to defaults
              </Link>
            </form>
          </Panel>

          <div data-testid="indicators" className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Indicator label="Production orders" testid="ind-orders" value={String(v.total.orders)} hint={`${v.orders.length - v.total.orders} excluded`} />
            <Indicator label="Labour recovery" testid="ind-recovery" value={pct(v.total.labourRecoveryPct)} hint="total planned / total actual minutes" />
            <Indicator label="Usage variance" testid="ind-usage" value={signed(v.total.usageVarianceCents)} hint={`${num(v.total.usageVarianceM)} m; ${v.total.usageIncluded} of ${v.total.orders} orders`} />
            <Indicator label="Price variance" testid="ind-price" value={signed(v.total.priceVarianceCents)} hint={`${v.total.priceIncluded} of ${v.total.orders} orders`} />
            <Indicator label="Labour variance" testid="ind-labour" value={signed(v.total.labourVarianceCents)} hint={`${v.total.labourIncluded} of ${v.total.orders} orders`} />
            <Indicator label="Costs complete" testid="ind-costs" value={`${allCosts - incompleteCosts} of ${allCosts}`} hint="style/size costs with every input" />
          </div>

          <Panel>
            <PanelTitle>Production variance by {s.by === "style" ? "style" : s.by === "line" ? "production line" : "order-size bracket"}</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Positive rand variances are unfavourable. Recovery is total planned over total actual minutes, not an average of order percentages.</p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Group</TH>
                    <TH align="right">Orders</TH>
                    <TH align="right">Units</TH>
                    <TH align="right">Fabric planned m</TH>
                    <TH align="right">Fabric actual m</TH>
                    <TH align="right">Usage variance m</TH>
                    <TH align="right">Usage variance</TH>
                    <TH align="right">Price variance</TH>
                    <TH align="right">Planned min</TH>
                    <TH align="right">Actual min</TH>
                    <TH align="right">Labour recovery</TH>
                    <TH align="right">Labour variance</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.groups.map((g) => (
                    <TR key={g.key}>
                      <TD>
                        <span data-testid="group-row" data-key={g.key} data-recovery={g.labourRecoveryPct === null ? "" : g.labourRecoveryPct.toFixed(2)} data-labour={g.labourVarianceCents} data-usage={g.usageVarianceCents} />
                        {g.key}
                      </TD>
                      <TD align="right" numeric>
                        {g.orders}
                      </TD>
                      <TD align="right" numeric>
                        {group(String(g.qty))}
                      </TD>
                      <TD align="right" numeric>
                        {num(g.plannedFabricM)}
                      </TD>
                      <TD align="right" numeric>
                        {num(g.actualFabricM)}
                      </TD>
                      <TD align="right" numeric>
                        {num(g.usageVarianceM)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(g.usageVarianceCents)}
                        {g.usageIncluded < g.orders && ` (${g.usageIncluded} of ${g.orders})`}
                      </TD>
                      <TD align="right" numeric>
                        {signed(g.priceVarianceCents)}
                        {g.priceIncluded < g.orders && ` (${g.priceIncluded} of ${g.orders})`}
                      </TD>
                      <TD align="right" numeric>
                        {group(String(Math.round(g.plannedMinutes)))}
                      </TD>
                      <TD align="right" numeric>
                        {group(String(Math.round(g.actualMinutes)))}
                      </TD>
                      <TD align="right" numeric>
                        {pct(g.labourRecoveryPct)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(g.labourVarianceCents)}
                        {g.labourIncluded < g.orders && ` (${g.labourIncluded} of ${g.orders})`}
                      </TD>
                      <TD>{g.complete ? <Badge tone="success">COMPLETE</Badge> : <Badge tone="warning">PARTIAL</Badge>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Labour recovery comparison</PanelTitle>
            <div className="mt-3">{model.groups.length > 0 ? <RecoveryChart groups={model.groups} /> : <EmptyState title="No groups" description="There are no valid production orders to compare." />}</div>
          </Panel>

          <Panel>
            <PanelTitle>Production orders</PanelTitle>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Order</TH>
                    <TH>Style</TH>
                    <TH>Line</TH>
                    <TH align="right">Units</TH>
                    <TH>Bracket</TH>
                    <TH align="right">Usage m</TH>
                    <TH align="right">Usage variance</TH>
                    <TH align="right">Price variance</TH>
                    <TH align="right">Recovery</TH>
                    <TH align="right">Labour variance</TH>
                    <TH>Issues</TH>
                  </TR>
                </THead>
                <TBody>
                  {v.orders.map((o) => (
                    <TR key={o.orderNo}>
                      <TD>
                        <span data-testid="order-row" data-order={o.orderNo} data-valid={String(o.valid)} data-usage={o.usageVarianceCents ?? ""} data-price={o.priceVarianceCents ?? ""} data-labour={o.labourVarianceCents ?? ""} />
                        {o.orderNo}
                      </TD>
                      <TD>{o.styleCode}</TD>
                      <TD>{o.line}</TD>
                      <TD align="right" numeric>
                        {group(String(o.qty))}
                      </TD>
                      <TD>{o.bracket}</TD>
                      <TD align="right" numeric>
                        {num(o.usageVarianceM)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(o.usageVarianceCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(o.priceVarianceCents)}
                      </TD>
                      <TD align="right" numeric>
                        {pct(o.labourRecoveryPct)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(o.labourVarianceCents)}
                      </TD>
                      <TD>{o.issues.length === 0 ? "-" : <span className="text-xs text-amber-700">{o.issues.join(" ")}</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

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
                  {[...v.checks.map((k) => ({ ...k, area: "variance" })), ...c.checks.map((k) => ({ ...k, area: "costing" }))].map((k) => (
                    <TR key={`${k.area}|${k.id}`}>
                      <TD>
                        <span data-testid="check" data-id={`${k.area}:${k.id}`} data-ok={String(k.ok)} />
                        {k.label}
                      </TD>
                      <TD>
                        <Badge tone={k.ok ? "success" : "danger"}>{k.ok ? "OK" : "ATTENTION"}</Badge>
                      </TD>
                      <TD>{k.detail}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Per-size cost: {model.style?.styleCode ?? "no style"}</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Calculated cost against the workbook&apos;s reference cost (Items.standardCost), with the selling price at cost x {c.config.markup}.</p>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Size</TH>
                    <TH align="right">Calculated cost</TH>
                    <TH align="right">Reference cost</TH>
                    <TH align="right">Difference</TH>
                    <TH align="right">vs smallest size</TH>
                    <TH align="right">Selling price</TH>
                    <TH>Size-specific components</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {(model.style?.sizes ?? []).map((z) => (
                    <TR key={z.size}>
                      <TD>
                        <span data-testid="size-row" data-size={z.size} data-total={z.totalCents ?? ""} data-selling={z.sellingCents ?? ""} data-status={z.status} />
                        <Link href={`/scenario-b?${new URLSearchParams({ ...s.values, style: model.style?.styleCode ?? "", size: z.size }).toString()}#breakdown`} prefetch={false} className="text-primary hover:underline">
                          {z.size}
                        </Link>
                      </TD>
                      <TD align="right" numeric>
                        {money(z.totalCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(z.referenceCents)}
                      </TD>
                      <TD align="right" numeric>
                        {signed(z.diffCents)}
                        {z.diffPct !== null && ` (${z.diffPct > 0 ? "+" : ""}${z.diffPct.toFixed(1)}%)`}
                      </TD>
                      <TD align="right" numeric>
                        {signed(z.deltaVsBaseCents)}
                      </TD>
                      <TD align="right" numeric>
                        {money(z.sellingCents)}
                      </TD>
                      <TD>{z.substitutions.length === 0 ? "-" : z.substitutions.map((x) => `${x.replaced} replaced by ${x.by}`).join("; ")}</TD>
                      <TD>{z.status === "complete" ? <Badge tone="success">COMPLETE</Badge> : <span className="text-xs text-amber-700">{`INCOMPLETE: ${z.missing.join("; ")}`}</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </Panel>

          {sizeSel && (
            <Panel>
              <span id="breakdown" />
              <PanelTitle>
                Cost breakdown: {model.style?.styleCode} size {sizeSel.size}
              </PanelTitle>
              <div className="mt-3 grid gap-4 md:grid-cols-3">
                <Indicator label="Calculated cost" testid="sel-total" value={money(totalCents)} hint={sizeSel.status === "complete" ? "complete" : "incomplete: withheld"} />
                <Indicator label="Selling price" testid="sel-selling" value={money(sizeSel.sellingCents)} hint={`cost x ${c.config.markup}`} />
                <Indicator label="Reference cost" testid="sel-reference" value={money(sizeSel.referenceCents)} hint="Items.standardCost" />
              </div>
              {totalCents !== null && totalCents > 0 && (
                <figure data-testid="composition" className="mt-4 m-0">
                  <svg viewBox="0 0 720 56" role="img" aria-label="Cost composition" className="h-auto w-full max-w-3xl">
                    <title>Cost composition</title>
                    {(() => {
                      let x = 0;
                      return COMPOSITION.map((p) => {
                        const cents = sizeSel.lines.filter((l) => l.category === p.key).reduce((a, l) => a + l.cents, 0);
                        const w = (cents / totalCents) * 720;
                        const rect = cents > 0 ? <rect key={p.key} data-testid="composition-part" data-part={p.key} data-cents={cents} x={x} y={4} width={w} height={32} fill={p.fill} /> : null;
                        x += w;
                        return rect;
                      });
                    })()}
                  </svg>
                  <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    {COMPOSITION.map((p) => (
                      <span key={p.key} className="inline-flex items-center gap-1">
                        <svg width="10" height="10" aria-hidden="true">
                          <rect width="10" height="10" fill={p.fill} />
                        </svg>
                        {p.label}
                      </span>
                    ))}
                  </figcaption>
                </figure>
              )}
              <div className="mt-4 overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Component</TH>
                      <TH>Group</TH>
                      <TH align="right">Qty</TH>
                      <TH align="right">Unit cost</TH>
                      <TH align="right">Cost</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sizeSel.lines.map((l, idx) => (
                      <TR key={`${l.code}|${idx}`}>
                        <TD>
                          <span data-testid="cost-line" data-code={l.code} data-cents={l.cents} />
                          {l.label}
                        </TD>
                        <TD>{COMPOSITION.find((p) => p.key === l.category)?.label ?? l.category}</TD>
                        <TD align="right" numeric>
                          {l.qty === null || l.qty === undefined ? "-" : String(l.qty)}
                        </TD>
                        <TD align="right" numeric>
                          {l.unitCost === null || l.unitCost === undefined ? "-" : l.unitCost.toFixed(2)}
                        </TD>
                        <TD align="right" numeric>
                          {money(l.cents)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              {sizeSel.status === "incomplete" && (
                <p data-testid="missing" className="mt-3 text-sm text-amber-700">
                  Not calculated because: {sizeSel.missing.join("; ")}. Nothing has been estimated in its place.
                </p>
              )}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
