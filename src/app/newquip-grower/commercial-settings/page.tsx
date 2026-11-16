"use client";

import { pageContainerClass } from "@/app/PageContainer";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SOLUTION_BUILDER_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
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
            <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900">Markup on landed cost</h3>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useDefaultMarkup} onChange={(e) => setUseDefaultMarkup(e.target.checked)} /> Use the default. {MARKUP_DEFAULT_LABEL}.</label>
              {!useDefaultMarkup && <label className="flex max-w-xs flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Markup (%)</span><input className={inputCls} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} /></label>}
            </section>
            <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900">Freight policy</h3>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={freightOn} onChange={(e) => setFreightOn(e.target.checked)} /> A freight policy is set. Leave off to keep it unset (no automatic prices).</label>
              {freightOn && <div className="grid gap-3 md:grid-cols-3">
                <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Factor (1 = no uplift)</span><input className={inputCls} inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} /></label>
                <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Fixed add-on per unit (rand)</span><input className={inputCls} inputMode="decimal" value={addOn} onChange={(e) => setAddOn(e.target.value)} /></label>
                <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Source</span><input className={inputCls} value={freightSource} onChange={(e) => setFreightSource(e.target.value)} /></label>
              </div>}
            </section>
            <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900">Exchange rates (rand per 1 unit)</h3>
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
              <label className="flex max-w-xs flex-col gap-1 text-sm"><span className="font-medium text-slate-700">A rate is not used once older than (days)</span><input className={inputCls} inputMode="numeric" value={fxMax} onChange={(e) => setFxMax(e.target.value)} /></label>
            </section>
            <section className="space-y-2"><h3 className="text-sm font-semibold text-slate-900">Cost-age escalation (simple, marginal, 365.25-day year)</h3>
              <p className="text-sm text-slate-600">Each year of a supplier cost&apos;s age is charged at the rate of the band it falls in. The bands start from the owner-approved proposal and can be edited. The last band has no end year.</p>
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
              <label className="flex max-w-xs flex-col gap-1 text-sm"><span className="font-medium text-slate-700">No automatic price for a cost older than (years)</span><input className={inputCls} inputMode="numeric" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} /></label>
            </section>
            <Button type="button" onClick={() => void save()} loading={busy}>Save as a new version</Button>
          </div>
        </Panel>
      )}
    </main>
  );
}
