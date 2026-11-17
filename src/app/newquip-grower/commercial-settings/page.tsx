"use client";

import { pageContainerClass } from "@/app/PageContainer";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SOLUTION_BUILDER_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
type BadgeTone = "neutral" | "success" | "warning" | "danger";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { getCommercialSettingsAction, saveCommercialSettingsAction, type CommercialSettingsView } from "../auto-pricing-actions";
import { MARKUP_DEFAULT_LABEL, emptyCommercialSettings, type AgeBand, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { bpsToPct, centsToRand, decimalToMicro, microToDecimal, pctToBps, randToCents } from "@/newquip/pricing/commercial-form";

// MANAGER-ONLY commercial settings for automatic supplier pricing. Server-checked: the action refuses anyone but a Manager to change them and returns the VALUES to a Manager only (an Estimator
// sees the list of unresolved items alone; a Rep gets nothing). Nothing here is invented: a freight policy and an exchange rate stay empty until a Manager enters them, and every save is a new version.
const inputCls = "h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm";
interface FxRow { cur: string; rate: string; source: string; asOf: string }
interface BandRow { to: string; rate: string }

const isTestOnly = (t: string | undefined | null): boolean => !!t && t.includes("TEST-ONLY");
const BAND_COLOURS = ["bg-emerald-700", "bg-sky-700", "bg-amber-700", "bg-rose-700", "bg-violet-700", "bg-slate-700"];

const PILL: Record<BadgeTone, string> = { neutral: "bg-slate-100 text-slate-700", success: "bg-emerald-50 text-emerald-800", warning: "bg-amber-50 text-amber-800", danger: "bg-rose-50 text-rose-800" };
function StatusPill({ tone = "neutral", children }: { tone?: BadgeTone; dot?: boolean; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${PILL[tone]}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}
function Help({ children }: { children: React.ReactNode }) { return <p className="text-xs text-slate-600">{children}</p>; }
function Section({ title, status, tone, intro, children }: { title: string; status: string; tone: BadgeTone; intro: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-sm font-semibold text-slate-900">{title}</h3><p className="mt-0.5 max-w-2xl text-xs text-slate-600">{intro}</p></div>
        <StatusPill tone={tone} dot>{status}</StatusPill>
      </div>
      {children}
    </section>
  );
}
function Field({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{label}</span>{children}<span className="text-xs text-slate-600">{help}</span></label>;
}

const toLocalInput = (iso: string): string => iso.slice(0, 16);
const fromLocalInput = (t: string): string => (t ? `${t}${t.length === 16 ? ":00Z" : ""}` : "");

export default function CommercialSettingsPage() {
  const [view, setView] = useState<CommercialSettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useDefaultMarkup, setUseDefaultMarkup] = useState(true);
  const [markup, setMarkup] = useState("");
  const [freightOn, setFreightOn] = useState(false);
  const [factor, setFactor] = useState("");
  const [addOn, setAddOn] = useState("0");
  const [freightSource, setFreightSource] = useState("");
  const [fx, setFx] = useState<FxRow[]>([]);
  const [fxMax, setFxMax] = useState("1");
  const [bands, setBands] = useState<BandRow[]>([]);
  const [maxAge, setMaxAge] = useState("5");

  const load = (s: CommercialSettings) => {
    setUseDefaultMarkup(s.markupBps === null); setMarkup(s.markupBps === null ? "" : bpsToPct(s.markupBps));
    setFreightOn(s.freight !== null); setFactor(s.freight ? microToDecimal(s.freight.factorMicro) : ""); setAddOn(s.freight ? centsToRand(s.freight.addOnCents) : "0"); setFreightSource(s.freight?.source ?? "");
    setFx(Object.entries(s.fx).map(([cur, q]) => ({ cur, rate: microToDecimal(q.rateMicro), source: q.source, asOf: toLocalInput(q.asOf) })));
    setFxMax(String(s.fxMaxAgeDays)); setMaxAge(String(s.maxAgeYears));
    setBands(s.ageBands.map((b) => ({ to: b.toYears === null ? "" : String(b.toYears), rate: bpsToPct(b.rateBps) })));
  };
  useEffect(() => {
    let live = true;
    void getCommercialSettingsAction().then((r) => { if (!live) return; if (r.ok && r.data) { setView(r.data); load(r.data.settings ?? emptyCommercialSettings()); } else setErr(r.error ?? "Could not load."); });
    return () => { live = false; };
  }, []);

  const build = (): CommercialSettings | string => {
    const base = emptyCommercialSettings();
    let markupBps: number | null = null;
    if (!useDefaultMarkup) { markupBps = pctToBps(markup); if (markupBps === null) return "The markup must be a percentage with at most 2 decimals."; }
    let freight: CommercialSettings["freight"] = null;
    if (freightOn) {
      const f = decimalToMicro(factor), a = randToCents(addOn);
      if (f === null) return "The freight factor must be a number with at most 6 decimals."; if (a === null) return "The freight add-on must be an amount in rand with at most 2 decimals.";
      freight = { factorMicro: f, addOnCents: a, source: freightSource.trim() };
    }
    const fxOut: CommercialSettings["fx"] = {};
    for (const r of fx) {
      const m = decimalToMicro(r.rate); const cur = r.cur.trim().toUpperCase();
      if (m === null) return `The ${cur || "currency"} rate must be a number with at most 6 decimals.`;
      if (fxOut[cur]) return `${cur} appears twice.`;
      fxOut[cur] = { rateMicro: m, source: r.source.trim(), asOf: fromLocalInput(r.asOf) };
    }
    const ab: AgeBand[] = []; let from = 0;
    for (let i = 0; i < bands.length; i++) {
      const last = i === bands.length - 1; const r = pctToBps(bands[i].rate);
      if (r === null) return `Age band ${i + 1}: the yearly rate must be a percentage with at most 2 decimals.`;
      const to = last ? null : Number(bands[i].to);
      if (!last && !Number.isInteger(to)) return `Age band ${i + 1}: give the end year as a whole number.`;
      ab.push({ fromYears: from, toYears: to, rateBps: r }); if (to !== null) from = to;
    }
    return { ...base, markupBps, freight, fx: fxOut, fxMaxAgeDays: Number(fxMax), ageBands: ab, maxAgeYears: Number(maxAge) };
  };
  const save = async () => {
    setErr(null); setOk(null);
    const s = build();
    if (typeof s === "string") { setErr(s); return; }
    setBusy(true);
    const r = await saveCommercialSettingsAction(s, view?.revision ?? null);
    setBusy(false);
    if (r.ok && r.data) { setView(r.data); if (r.data.settings) load(r.data.settings); setOk(`Saved as version ${r.data.revision}.`); } else setErr(r.error ?? "Could not save.");
  };

  const blocking = view?.unresolved.filter((u) => u.severity === "blocking") ?? [];
  const notices = view?.unresolved.filter((u) => u.severity === "notice") ?? [];
  return (
    <main className={`${pageContainerClass("form", "compact")} space-y-4`}>
      <ModuleHeader variant="workspace" module={SOLUTION_BUILDER_MODULE}>Commercial settings</ModuleHeader>
      <Link href="/newquip-grower" className="text-sm text-indigo-700 hover:underline">Back to quotes</Link>
      <p className="max-w-3xl text-sm text-slate-700">These are commercial inputs entered by a Manager. Nothing here is supplied or assumed by the application: until freight and an exchange rate are entered, products costed from Cin7 are not priced automatically and are flagged. Every save is a new version; earlier versions are kept.</p>
      {view?.available && view.canEdit && view.settings && (() => {
        const st = view.settings;
        const fxTest = Object.values(st.fx).some((q) => isTestOnly(q.source));
        const fTest = isTestOnly(st.freight?.source);
        const items: Array<{ label: string; status: string; tone: BadgeTone }> = [
          { label: "Markup", status: st.markupBps === null ? "Default" : "Configured", tone: st.markupBps === null ? "neutral" : "success" },
          { label: "Exchange rates", status: Object.keys(st.fx).length === 0 ? "Missing" : fxTest ? "TEST-ONLY" : "Configured", tone: Object.keys(st.fx).length === 0 ? "danger" : fxTest ? "warning" : "success" },
          { label: "Freight", status: st.freight === null ? "Missing" : fTest ? "TEST-ONLY" : "Configured", tone: st.freight === null ? "danger" : fTest ? "warning" : "success" },
          { label: "Cost-age escalation", status: st.ageBands.length === 0 ? "Missing" : "Configured", tone: st.ageBands.length === 0 ? "danger" : "success" },
        ];
        return (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Saved settings status" data-testid="commercial-status-summary">
            {items.map((i) => <li key={i.label} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><span className="font-medium text-slate-800">{i.label}</span><StatusPill tone={i.tone} dot>{i.status}</StatusPill></li>)}
          </ul>
        );
      })()}
      {err && <Alert tone="danger">{err}</Alert>}
      {ok && <Alert tone="success">{ok}</Alert>}
      {view && !view.available && <Alert tone="info">This becomes available once the database update for customer quotations (migration 0115) has been applied.</Alert>}
      {view?.available && blocking.length > 0 && <div data-testid="unresolved-blocking"><Alert tone="danger"><strong>Unresolved, automatic prices are withheld:</strong><ul className="mt-1 list-disc pl-5">{blocking.map((u) => <li key={u.text}>{u.text}</li>)}</ul></Alert></div>}
      {view?.available && notices.length > 0 && <Alert tone="warning"><ul className="list-disc pl-5">{notices.map((u) => <li key={u.text}>{u.text}</li>)}</ul></Alert>}
      {view?.available && !view.canEdit && <Alert tone="info">Only a Manager can see or change these settings. You can see what is still unresolved.</Alert>}
      {view?.available && view.canEdit && (
        <Panel>
          <PanelTitle>{view.revision ? `Current version ${view.revision}${view.enteredBy ? `, entered by ${view.enteredBy}` : ""}` : "No settings entered yet"}</PanelTitle>
          <div className="mt-4 space-y-6">
            <Section title="Markup on landed cost" intro="The percentage added on top of landed cost (supplier cost plus freight, in rand) to give the automatic selling price." status={useDefaultMarkup ? "Default in use" : "Configured"} tone={useDefaultMarkup ? "neutral" : "success"}>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useDefaultMarkup} onChange={(e) => setUseDefaultMarkup(e.target.checked)} /> Use the default. {MARKUP_DEFAULT_LABEL}.</label>
              {!useDefaultMarkup && <div className="max-w-xs"><Field label="Markup (%)" help="Percentage with at most 2 decimals, for example 25 or 27.5."><input className={inputCls} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} /></Field></div>}
            </Section>
            <Section title="Freight policy" intro="Freight is applied to each supplier cost before markup. Until a policy is set, no automatic price is produced." status={!freightOn ? "Missing" : isTestOnly(freightSource) ? "TEST-ONLY" : "Configured"} tone={!freightOn ? "danger" : isTestOnly(freightSource) ? "warning" : "success"}>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={freightOn} onChange={(e) => setFreightOn(e.target.checked)} /> A freight policy is set. Leave off to keep it unset (no automatic prices).</label>
              {freightOn && <div className="grid gap-3 md:grid-cols-3">
                <Field label="Factor (1 = no uplift)" help="Multiplier on the rand cost, up to 6 decimals. 1.08 adds 8%."><input className={inputCls} inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} /></Field>
                <Field label="Fixed add-on per unit (rand)" help="Flat rand amount added per unit after the factor. 0 for none."><input className={inputCls} inputMode="decimal" value={addOn} onChange={(e) => setAddOn(e.target.value)} /></Field>
                <Field label="Source" help="Where this policy comes from, for the audit trail. A source containing TEST-ONLY marks it as test data."><input className={inputCls} value={freightSource} onChange={(e) => setFreightSource(e.target.value)} /></Field>
              </div>}
            </Section>
            <Section title="Exchange rates (rand per 1 unit)" intro="Used to convert foreign-currency supplier costs to rand. A rate older than the limit below is not used and its products are flagged." status={fx.length === 0 ? "Missing" : fx.some((r) => isTestOnly(r.source)) ? "TEST-ONLY" : "Configured"} tone={fx.length === 0 ? "danger" : fx.some((r) => isTestOnly(r.source)) ? "warning" : "success"}>
              {fx.map((r, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[6rem_1fr_1fr_14rem_auto]">
                  <input aria-label="Currency" placeholder="EUR" className={inputCls} value={r.cur} onChange={(e) => setFx((x) => x.map((y, j) => (j === i ? { ...y, cur: e.target.value } : y)))} />
                  <input aria-label="Rate" placeholder="Rate" className={inputCls} inputMode="decimal" value={r.rate} onChange={(e) => setFx((x) => x.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))} />
                  <input aria-label="Source" placeholder="Source" className={inputCls} value={r.source} onChange={(e) => setFx((x) => x.map((y, j) => (j === i ? { ...y, source: e.target.value } : y)))} />
                  <input aria-label="As of (UTC)" type="datetime-local" className={inputCls} value={r.asOf} onChange={(e) => setFx((x) => x.map((y, j) => (j === i ? { ...y, asOf: e.target.value } : y)))} />
                  <Button type="button" variant="secondary" onClick={() => setFx((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="secondary" onClick={() => setFx((x) => [...x, { cur: "", rate: "", source: "", asOf: "" }])}>Add a currency</Button>
              <div className="max-w-xs"><Field label="A rate is not used once older than (days)" help="Whole days. 1 means the rate must have been set within the last day."><input className={inputCls} inputMode="numeric" value={fxMax} onChange={(e) => setFxMax(e.target.value)} /></Field></div>
              {fx.length > 0 && <Help>Row order: currency code, rate, source, as-of time (UTC). A source containing TEST-ONLY marks a rate as test data.</Help>}
            </Section>
            <Section title="Cost-age escalation (simple, marginal, 365.25-day year)" intro="Each year of a supplier cost's age is charged at the rate of the band it falls in. The bands start from the owner-approved proposal and can be edited. The last band has no end year." status={bands.length === 0 ? "Missing" : "Configured"} tone={bands.length === 0 ? "danger" : "success"}>
              <dl className="grid gap-2 sm:grid-cols-2" data-testid="escalation-method">
                <div className="rounded-md bg-slate-50 px-3 py-2"><dt className="text-xs font-medium text-slate-600">Method</dt><dd className="text-sm font-semibold text-slate-900">Simple (fixed)</dd><Help>Simple marginal escalation. Compound escalation is not offered.</Help></div>
                <div className="rounded-md bg-slate-50 px-3 py-2"><dt className="text-xs font-medium text-slate-600">Maximum historical cost age</dt><dd className="text-sm font-semibold text-slate-900">{maxAge.trim() === "" ? "Not set" : `${maxAge} years`}</dd><Help>Set below. Older costs get no automatic price.</Help></div>
              </dl>
              {bands.length > 0 && (
                <div data-testid="band-timeline" aria-label="Escalation bands by cost age" role="group">
                  <div className="flex h-8 w-full overflow-hidden rounded-md border border-slate-200 text-xs font-semibold text-white">
                    {bands.map((b, i) => {
                      const end = i === bands.length - 1 ? Number(maxAge) : Number(b.to);
                      const start = i === 0 ? 0 : Number(bands[i - 1].to);
                      const w = Number.isFinite(end) && Number.isFinite(start) && end > start ? end - start : 1;
                      return <div key={i} style={{ flexGrow: w, flexBasis: 0 }} className={`flex min-w-10 items-center justify-center ${BAND_COLOURS[i % BAND_COLOURS.length]}`}>{b.rate.trim() === "" ? "?" : `${b.rate}%`}</div>;
                    })}
                  </div>
                  <div className="mt-1 flex text-xs text-slate-600">
                    {bands.map((b, i) => <span key={i} style={{ flexGrow: 1, flexBasis: 0 }} className="min-w-10">{i === 0 ? "0" : bands[i - 1].to || "?"} yr</span>)}
                  </div>
                  <Help>Bar widths follow each band&apos;s years; the labels show the yearly rate.</Help>
                </div>
              )}
              {bands.map((b, i) => {
                const last = i === bands.length - 1; const from = i === 0 ? "0" : bands[i - 1].to;
                return (
                  <div key={i} className="grid items-center gap-2 md:grid-cols-[8rem_8rem_10rem_auto]">
                    <span className="text-sm">From {from || "?"} years</span>
                    {last ? <span className="text-sm">and over</span> : <input aria-label={`Band ${i + 1} ends (years)`} className={inputCls} inputMode="numeric" value={b.to} onChange={(e) => setBands((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} />}
                    <input aria-label={`Band ${i + 1} rate (% a year)`} className={inputCls} inputMode="decimal" value={b.rate} onChange={(e) => setBands((x) => x.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))} />
                    <Button type="button" variant="secondary" disabled={bands.length <= 1} onClick={() => setBands((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                );
              })}
              <Button type="button" variant="secondary" onClick={() => setBands((x) => [...x.slice(0, -1), { to: String(Number(x.length > 1 ? x[x.length - 2].to : 0) + 1), rate: x[x.length - 1]?.rate ?? "0" }, x[x.length - 1] ?? { to: "", rate: "0" }])}>Add a band</Button>
              <div className="max-w-xs"><Field label="No automatic price for a cost older than (years)" help="Whole years. This is the maximum historical cost age."><input className={inputCls} inputMode="numeric" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} /></Field></div>
            </Section>
            <section className="rounded-lg border border-slate-200 bg-slate-50 p-4" data-testid="activation-help">
              <h3 className="text-sm font-semibold text-slate-900">Activation status</h3>
              <p className="mt-1 text-sm text-slate-700">Activation is controlled by the deployment (NEWQUIP_AUTO_PRICING and NEWQUIP_AUTO_PRICING_FROM). It cannot be switched on or off from this page, and saving these settings does not activate automatic pricing.</p>
            </section>
            <Button type="button" onClick={() => void save()} loading={busy}>Save as a new version</Button>
          </div>
        </Panel>
      )}
    </main>
  );
}
