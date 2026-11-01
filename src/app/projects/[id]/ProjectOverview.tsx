"use client";

// Executive Project Overview (NewQuip). READ-ONLY. Every figure comes from buildProjectOverview (pure, unit-tested); this component only loads the
// inputs and lays them out. Commercial data is read from the database on load; Cin7 fulfilment is read ONLY when the user asks for it, so an
// unread value is shown as "Not read yet" or "Unknown" - never as zero.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { buildProjectOverview, type ExceptionItem, type Kpi, type OverviewTab, type PhysicalLoad, type PhysicalOverviewRow } from "@/lib/projects/overview-model";
import { formatBps, formatCents } from "@/lib/projects/project-view";
import { getPhysicalStatusAction } from "../physical-actions";
import { getProjectOverviewDataAction, type OverviewDataResult } from "../overview-actions";

const qty = (n: number | null): string => (n === null ? "Unknown" : Number.isInteger(n) ? String(n) : n.toFixed(2));
const stamp = (iso: string | null): string => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "None recorded");
const SEVERITY_TONE: Record<ExceptionItem["severity"], BadgeTone> = { critical: "danger", attention: "warning", info: "info" };
const SEVERITY_LABEL: Record<ExceptionItem["severity"], string> = { critical: "Act now", attention: "Needs attention", info: "For information" };
const CIN7_TONE: Record<string, BadgeTone> = { NOT_POSTED: "neutral", POSTING: "warning", DRAFT_CREATED: "info", AUTHORISED: "success", CREATED_OTHER: "info", FAILED: "danger", UNCERTAIN: "danger" };

function KpiCard({ k }: { k: Kpi }) {
  return (
    <div className={`rounded-xl border p-4 ${k.tone === "accent" ? "border-indigo-200 bg-indigo-50" : k.tone === "warning" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`} data-testid={`kpi-${k.id}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{k.label}</p>
      <p className="mt-1.5 whitespace-nowrap text-xl font-bold tabular-nums text-slate-900">
        {k.cents === null ? "Unknown" : formatCents(k.cents)}
        {k.percent !== undefined && k.percent !== null && <span className="ml-2 text-sm font-semibold text-slate-600">{k.percent.toFixed(2)}%</span>}
        {k.count !== undefined && <span className="ml-2 text-sm font-semibold text-slate-600">{k.count} claim{k.count === 1 ? "" : "s"}</span>}
      </p>
      <p className="mt-1 text-xs leading-snug text-slate-500">{k.unknown ?? k.hint}</p>
    </div>
  );
}

/** Display-only meter for a basis-point percentage; the number beside it is the information, the bar is decoration. */
function Meter({ bps, fill, label }: { bps: number; fill: string; label: string }) {
  const pct = Math.max(0, Math.min(100, bps / 100));
  return (
    <span className="flex items-center gap-2" title={label}>
      <span className="block h-1.5 w-12 overflow-hidden rounded-full bg-slate-200" aria-hidden><span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} /></span>
      <span className="w-12 text-right tabular-nums">{formatBps(bps)}</span>
    </span>
  );
}
const bpsOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part * 10_000) / whole) : 0);

function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-sm font-semibold text-slate-800">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export function ProjectOverview({ projectId, refreshKey, onOpenTab }: { projectId: string; refreshKey: string; onOpenTab: (tab: OverviewTab) => void }) {
  const [res, setRes] = useState<OverviewDataResult | null>(null);
  const [phys, setPhys] = useState<PhysicalLoad>({ state: "not_loaded" });
  const [physBusy, setPhysBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getProjectOverviewDataAction(projectId).then((r) => { if (live) setRes(r); }).catch(() => { if (live) setRes({ ok: false, error: "The overview could not be loaded." }); });
    return () => { live = false; };
  }, [projectId, refreshKey, attempt]);

  async function readFulfilment() {
    setPhysBusy(true);
    try {
      const r = await getPhysicalStatusAction(projectId);
      setPhys(r.ok && r.data
        ? { state: "loaded", asOf: r.data.sections[0]?.asOf ?? new Date().toISOString(), sections: r.data.sections.map((s) => ({ label: s.label, scope: s.scope, linked: s.linked, saleNumber: s.saleNumber, rows: s.rows, exceptions: s.exceptions, scopeBlockers: s.scopeBlockers })) }
        : { state: "error", error: r.error ?? "Cin7 fulfilment could not be read." });
    } catch {
      setPhys({ state: "error", error: "Cin7 fulfilment could not be read." });
    } finally {
      setPhysBusy(false);
    }
  }

  const overview = useMemo(() => {
    if (!res?.ok || !res.data) return null;
    try {
      return buildProjectOverview({ scopes: res.data.scopes, unbilledApprovedVariations: res.data.unbilledApprovedVariations, deliveries: res.data.deliveries, physical: phys, estimates: res.data.estimates, viewer: res.data.viewer });
    } catch (e) {
      return e instanceof Error ? e : new Error("The overview could not be built.");
    }
  }, [res, phys]);

  if (res === null) return <p role="status" className="text-sm text-slate-500" data-testid="overview-loading">Loading the executive overview…</p>;
  if (!res.ok || overview === null || overview instanceof Error) {
    return (
      <div className="space-y-3" data-testid="overview-error">
        <Alert tone="danger">{overview instanceof Error ? overview.message : res.error ?? "The overview could not be loaded."}</Alert>
        <Button variant="secondary" size="sm" onClick={() => { setRes(null); setAttempt((n) => n + 1); }}>Try again</Button>
      </div>
    );
  }
  const o = overview;
  const open = (e: ExceptionItem) => e.link.kind === "tab"
    ? <button type="button" className="text-xs font-medium text-indigo-700 underline-offset-2 hover:underline" onClick={() => onOpenTab((e.link as { tab: OverviewTab }).tab)}>{e.linkLabel}</button>
    : <Link className="text-xs font-medium text-indigo-700 underline-offset-2 hover:underline" href={e.link.href}>{e.linkLabel}</Link>;

  return (
    <div className="space-y-8" data-testid="overview">
      <Section id="ov-summary" title="Executive summary" subtitle="All commercial amounts are ex VAT.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{o.kpis.map((k) => <KpiCard key={k.id} k={k} />)}</div>
        {!o.costVisible && <p className="text-xs text-slate-500" data-testid="cost-hidden">Cost and margin are shown to organisation owners and administrators only.</p>}
      </Section>

      <Section id="ov-attention" title="Needs attention" subtitle="Each item opens the workflow that resolves it.">
        {o.exceptions.length === 0 ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="no-exceptions">Nothing needs attention right now.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white" data-testid="exceptions">
            {o.exceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <span className="mt-0.5"><Badge tone={SEVERITY_TONE[e.severity]}>{SEVERITY_LABEL[e.severity]}</Badge></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{e.title} <span className="font-normal text-slate-500">· {e.area}</span></p>
                  <p className="text-xs leading-snug text-slate-600">{e.detail}</p>
                </div>
                {open(e)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="ov-commercial" title="Commercial progress" subtitle="Three different measures: site progress reported by the team, progress approved for billing, and what is billed or committed.">
        {o.milestones.map((g) => (
          <div key={g.projectId} className="space-y-1">
            <p className="text-xs font-semibold text-slate-600">{g.label}</p>
            {g.rows.length === 0 ? <p className="text-sm text-slate-500">No billing milestones yet.</p> : (
              <Table>
                <THead><TR><TH>Milestone</TH><TH align="right">Contract value</TH><TH align="right">Site progress (reported)</TH><TH align="right">Approved for billing</TH><TH align="right">Earned</TH><TH align="right">Billed / committed</TH><TH align="right">Remaining</TH><TH align="right">Claimable now</TH></TR></THead>
                <TBody>
                  {g.rows.map((r) => (
                    <TR key={r.id}>
                      <TD>{r.name}</TD>
                      <TD align="right">{formatCents(r.valueCents)}</TD>
                      <TD align="right"><Meter bps={r.reportedBps} fill="bg-sky-500" label="Reported on site; informational only" /></TD>
                      <TD align="right"><Meter bps={r.approvedBps} fill="bg-indigo-500" label="Approved by a manager for billing" /></TD>
                      <TD align="right">{formatCents(r.earnedCents)}</TD>
                      <TD align="right"><span className="flex flex-col items-end"><span>{formatCents(r.committedCents)}</span><Meter bps={bpsOf(r.committedCents, r.valueCents)} fill="bg-emerald-500" label="Share of the milestone billed or committed" /></span></TD>
                      <TD align="right">{formatCents(r.remainingCents)}</TD>
                      <TD align="right"><strong>{formatCents(r.claimableCents)}</strong></TD>
                    </TR>
                  ))}
                  <TR><TD><strong>Total</strong></TD><TD align="right"><strong>{formatCents(g.totals.valueCents)}</strong></TD><TD /><TD /><TD align="right"><strong>{formatCents(g.totals.earnedCents)}</strong></TD><TD align="right"><strong>{formatCents(g.totals.committedCents)}</strong></TD><TD align="right"><strong>{formatCents(g.totals.remainingCents)}</strong></TD><TD align="right"><strong>{formatCents(g.totals.claimableCents)}</strong></TD></TR>
                </TBody>
              </Table>
            )}
          </div>
        ))}
      </Section>

      <Section id="ov-physical" title="Physical fulfilment" subtitle="What Cin7 holds for the Sale, read only when you ask. Physical delivery is separate from billing.">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" loading={physBusy} onClick={readFulfilment}>{o.physical.state === "loaded" ? "Refresh from Cin7" : "Read fulfilment from Cin7"}</Button>
          {o.physical.asOf && <span className="text-xs text-slate-500">As of {stamp(o.physical.asOf)}</span>}
        </div>
        {o.physical.state === "error" && <Alert tone="warning">{o.physical.error}</Alert>}
        {o.physical.state === "not_loaded" && <p className="text-sm text-slate-600" data-testid="physical-not-loaded">Not read yet. Quantities are unknown until Cin7 is read; they are not zero.</p>}
        {o.physical.totals && (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-testid="physical-totals">
            {[["Units ordered", qty(o.physical.totals.orderedUnits)], ["Units shipped", qty(o.physical.totals.shippedUnits)], ["Units still to ship", qty(o.physical.totals.remainingUnits)], ["Products short of stock", String(o.physical.totals.shortSkuCount)]].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-slate-200 bg-white px-3 py-2"><dt className="text-xs text-slate-500">{k}</dt><dd className="font-semibold tabular-nums text-slate-900">{v}</dd></div>
            ))}
          </dl>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-testid="deliveries">
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2"><dt className="text-xs text-slate-500">Deliveries recorded</dt><dd className="font-semibold tabular-nums">{o.physical.deliveries ? o.physical.deliveries.total : "Unknown"}</dd></div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2"><dt className="text-xs text-slate-500">Dispatched</dt><dd className="font-semibold tabular-nums">{o.physical.deliveries ? o.physical.deliveries.dispatched : "Unknown"}</dd></div>
          <div className="col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-2"><dt className="text-xs text-slate-500">Latest delivery activity (Toolbox register)</dt><dd className="font-semibold">{o.physical.deliveries ? stamp(o.physical.deliveries.latestActivityAt) : "Unknown"}</dd></div>
        </dl>
        {o.physical.sections.map((s) => (
          <div key={s.label} className="space-y-1">
            <p className="text-xs font-semibold text-slate-600">{s.label} · {s.saleNumber ? `Cin7 ${s.saleNumber}` : "No Cin7 Sale linked"}</p>
            {s.rows.length === 0 ? <p className="text-sm text-slate-500">No physical products in this scope (commercial charges only).</p> : (
              <Table>
                <THead><TR><TH>Product</TH><TH align="right">Approved</TH><TH align="right">Ordered</TH><TH align="right">Shipped</TH><TH align="right">Outstanding</TH><TH align="right">Free stock (whole account)</TH><TH align="right">Short by</TH></TR></THead>
                <TBody>
                  {s.rows.map((r: PhysicalOverviewRow) => (
                    <TR key={r.sku}><TD><span className="font-mono text-xs">{r.sku}</span> <span className="text-slate-500">{r.name}</span></TD><TD align="right">{qty(r.approved)}</TD><TD align="right">{qty(r.ordered)}</TD><TD align="right">{qty(r.shipped)}</TD><TD align="right">{qty(r.remaining)}</TD><TD align="right">{qty(r.availableAccountWide)}</TD><TD align="right">{r.shortfall === null ? "Unknown" : r.shortfall > 0 ? <strong className="text-amber-700">{qty(r.shortfall)}</strong> : "0"}</TD></TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        ))}
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500">{o.physical.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </Section>

      <Section id="ov-recon" title="Financial reconciliation" subtitle="Cin7 invoices against approved claims, by Sale.">
        {o.reconciliation.scopes.map((r) => (
          <Panel key={r.projectId}>
            <PanelTitle>{r.label} · {r.saleNumber ? `Cin7 ${r.saleNumber}` : "No Cin7 Sale linked"}</PanelTitle>
            {r.claims.length === 0 ? <p className="mt-2 text-sm text-slate-500">No claims have been raised against this Sale yet.</p> : (
              <div className="mt-2">
                <Table>
                  <THead><TR><TH>Claim</TH><TH align="right">Amount (ex VAT)</TH><TH>Cin7 invoice</TH><TH>Cin7 status</TH><TH>Toolbox reconciliation</TH></TR></THead>
                  <TBody>
                    {r.claims.map((cl) => (
                      <TR key={cl.claimNumber}>
                        <TD>{cl.claimNumber}</TD><TD align="right">{formatCents(cl.exVatCents)}</TD><TD>{cl.invoiceNumber ?? "—"}</TD>
                        <TD><Badge tone={CIN7_TONE[cl.cin7Kind] ?? "neutral"}>{cl.cin7Label}</Badge></TD>
                        <TD>{cl.reconciled ? "Reconciled with Cin7" : cl.cin7Kind === "NOT_POSTED" ? "—" : "Not reconciled yet"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <p className="mt-2 text-xs text-slate-500">{r.summary.invoiceCount} Cin7 invoice{r.summary.invoiceCount === 1 ? "" : "s"} ({formatCents(r.summary.invoicedExVatCents)} ex VAT), {r.summary.reconciledCount} reconciled{r.summary.notPostedCount ? `, ${r.summary.notPostedCount} approved claim${r.summary.notPostedCount === 1 ? "" : "s"} not yet invoiced` : ""}{r.summary.problemCount ? `, ${r.summary.problemCount} failed or uncertain` : ""}.</p>
              </div>
            )}
          </Panel>
        ))}
        <p className="text-sm font-medium text-slate-800" data-testid="invoiced-total">Invoiced in Cin7 across all Sales: {formatCents(o.reconciliation.invoicedExVatCents)} ex VAT</p>
        <Alert tone="info">{o.reconciliation.cin7Note}</Alert>
        <Alert tone="warning">{o.reconciliation.xeroNote}</Alert>
      </Section>
    </div>
  );
}
