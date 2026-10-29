"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { GROWER_RULES, CCM_FEEDER_CAPACITY_PIGS, PIGS_PER_DRINKER } from "@/newquip/grower/rules";
import { buildCustomerSummary } from "@/newquip/grower/customer-summary";
import { READINESS_LABEL, type ReadinessCategory, type ReadinessState } from "@/newquip/grower/readiness";
import { CHARGE_LABEL, expectedSkuFor, type BridgeLine, type ChargeKey } from "@/newquip/grower/quote-bridge";
import { packageFor, manualSelectionSkusFor } from "@/newquip/grower/commercial";
import { ROOMS_HELP, VENTILATION_SCOPE_STATUS } from "@/newquip/grower/open-items";
import { valueKindOf, VALUE_KIND_LABEL, type ValueKind } from "@/newquip/grower/bom-view";
import { QUOTE_TYPE_LABEL, type QuoteType } from "@/newquip/grower/pricing-source";
import { TOPIGS_GROWER_INPUT } from "@/newquip/grower/fixture";
import { DEMO_DEFAULTS_SOURCE, applyDemoDefaults, hasEntries } from "@/newquip/grower/demo-defaults";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { GrowerItemKey, OptionalItemKey, PenningPigSize } from "@/newquip/grower/types";
import { QUOTE_STATE_LABEL, QUOTE_STATES, type QuoteState } from "@/newquip/quote/workflow";
import {
  approveGrowerQuoteAction, createProjectFromGrowerQuoteAction, getGrowerQuoteAction, previewGrowerDraftAction, returnGrowerQuoteToEstimatorAction, returnGrowerQuoteToRepAction,
  saveGrowerDraftAction, sendGrowerQuoteToEstimatorAction, signOffGrowerQuoteAction, type QuoteView,
} from "../actions";
import { fmtCents, fmtZar, NumField, TextField } from "../fields";
import { MarginPanel } from "./MarginPanel";
import { BuildStamp } from "@/components/BuildStamp";
import { ScheduleChooser } from "./ScheduleChooser";
import { ScopePanel } from "./ScopePanel";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { resolveScheduleChoice, type ScheduleChoice } from "@/newquip/quote/billing-schedule";

// NewQuip Grower quote editor: Configuration (rep) → Estimator review → Customer quote → Approval. The browser holds only the
// editable DRAFT; every number shown comes from the server's evaluateDraft(), and approval re-evaluates on the server again.

type Tab = "config" | "review" | "customer" | "approval";
const TABS: { value: Tab; label: string }[] = [
  { value: "config", label: "1 · Configuration" },
  { value: "review", label: "2 · Estimator review" },
  { value: "customer", label: "3 · Customer quote" },
  { value: "approval", label: "4 · Approval & Project" },
];

const READY_TONE: Record<ReadinessState, BadgeTone> = { DRAFT: "neutral", BLOCKED: "danger", READY: "success" };
const KIND_TONE: Record<ValueKind, BadgeTone> = { auto_calculated: "success", default_suggested: "info", estimator_input_required: "warning", estimator_input: "neutral" };
const CAT_LABEL: Record<ReadinessCategory, string> = {
  autoCalculated: "Auto-calculated", suggestedDefault: "Suggested / default", estimatorInputs: "Estimator inputs", overrides: "Overrides",
  warnings: "Warnings", missingMappings: "Missing product mappings", supplierQuoteRequired: "Supplier quote required", pricingExceptions: "Pricing exceptions",
};
const CAT_TONE: Record<ReadinessCategory, BadgeTone> = {
  autoCalculated: "success", suggestedDefault: "info", estimatorInputs: "neutral", overrides: "warning", warnings: "warning",
  missingMappings: "danger", supplierQuoteRequired: "danger", pricingExceptions: "warning",
};
const PIG_SIZE_LABEL: Record<PenningPigSize, string> = { SMALL: "Small — R1,300 / rm", MEDIUM: "Medium — R1,500 / rm", LARGE: "Large — R2,200 / rm" };
const OPTIONAL_LABELS: Record<OptionalItemKey, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows",
  pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};
const CHARGE_HELP: Record<ChargeKey, string> = {
  delivery: "From the courier invoice — truck size × truck price; distance affects it.",
  installation: "From the teams' service reports — days × daily rate.",
  concrete_slat_delivery: "Truck price ÷ slat weight, by distance.",
};

function StateStepper({ state }: { state: QuoteState }) {
  const idx = QUOTE_STATES.indexOf(state);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs font-medium">
      {QUOTE_STATES.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 ${i < idx ? "bg-emerald-100 text-emerald-800" : i === idx ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>{i + 1} · {QUOTE_STATE_LABEL[s]}</span>
          {i < QUOTE_STATES.length - 1 && <span className="text-slate-300" aria-hidden>→</span>}
        </li>
      ))}
    </ol>
  );
}

export default function QuoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<QuoteView | null>(null);
  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [ev, setEv] = useState<QuoteEvaluation | null>(null);
  const [dirty, setDirty] = useState(false);
  const [scheduleChoice, setScheduleChoice] = useState<ScheduleChoice | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("config");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [demoLoaded, setDemoLoaded] = useState<string[] | null>(null);
  const [isWorking, start] = useTransition();
  const [confirmedBy, setConfirmedBy] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const seq = useRef(0);

  function adopt(v: QuoteView) {
    setView(v);
    setDraft(v.quote.draft);
    setEv(v.evaluation);
    setDirty(false);
  }
  useEffect(() => {
    getGrowerQuoteAction(id).then((r) => (r.ok && r.data ? (adopt(r.data), setError(null)) : setError(r.error ?? "Unknown error")));
  }, [id]);

  // Live recalculation (writes nothing).
  useEffect(() => {
    if (!draft || !dirty) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const r = await previewGrowerDraftAction(draft);
      if (mine === seq.current && r.ok && r.data) setEv(r.data);
    }, 300);
    return () => clearTimeout(t);
  }, [draft, dirty]);

  if (!view || !draft || !ev) {
    return (
      <main className="mx-auto w-full max-w-[1480px] px-6 py-12">
        <ModuleHeader module={QUOTES_MODULE}>Grower quote</ModuleHeader>
        {error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <p className="mt-6 text-sm text-slate-500">Loading…</p>}
      </main>
    );
  }

  const q = view.quote;
  const roles = new Set(view.viewer.roles);
  const final = q.state === "MANAGER_APPROVED_FINAL";
  const editable = !final && (roles.has("rep") || roles.has("estimator"));
  const budget = ev.budget;
  const rd = ev.readiness;
  const totalCents = budget && !budget.incomplete ? Math.round(budget.totals.subtotalExTax * 100) : null;

  // One-click demonstration quotation: replaces the inputs of THIS editable draft only (not saved, nothing created, approved or sent).
  function loadDemo() {
    const r = applyDemoDefaults(draft!);
    setDraft(r.draft); setDirty(true); setConfirmDemo(false); setDemoLoaded(r.replaced); setNotice(null); setError(null);
  }
  const edit = (fn: (d: QuoteDraft) => void) => { setDraft((p) => { const n = structuredClone(p!); fn(n); return n; }); setDirty(true); };
  const num = (v: number | null) => v ?? 0;

  function act(fn: () => Promise<{ ok: boolean; error?: string; data?: QuoteView }>, done: string) {
    start(async () => {
      if (dirty && !final) {
        const s = await saveGrowerDraftAction(id, draft!);
        if (!s.ok) return setError(s.error ?? "Could not save");
      }
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Unknown error");
      setError(null);
      setNotice(done);
      if (r.data) adopt(r.data);
    });
  }
  function save() {
    start(async () => {
      const r = await saveGrowerDraftAction(id, draft!);
      if (!r.ok || !r.data) return setError(r.error ?? "Could not save");
      setError(null);
      setNotice("Draft saved. Any estimator sign-off made on earlier content no longer applies.");
      adopt(r.data);
    });
  }

  const cfg = draft.config;
  const lineByKey = new Map(ev.calc.lines.map((l) => [l.itemKey, l]));
  const bridgeByKey = new Map<string, BridgeLine>((budget?.lines ?? []).map((b) => [b.itemKey, b]));
  const summary = budget ? buildCustomerSummary(budget) : null;

  return (
    <main className="mx-auto w-full max-w-[1480px] px-6 py-12">
      <ModuleHeader module={QUOTES_MODULE}>
        <Link href="/newquip-grower" className="text-indigo-700 hover:underline">← Grower quotes</Link> · {q.quote_ref} <span className="text-slate-400">rev {q.revision}</span>
      </ModuleHeader>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <StateStepper state={q.state} />
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>Grower House Template v1</span><span className="text-slate-300">·</span>
            <span>{QUOTE_TYPE_LABEL[draft.quoteType]} pricing</span><span className="text-slate-300">·</span>
            <span>{budget?.priceSource.label ?? "NewQuip Master workbook – POC controlled snapshot"}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={READY_TONE[rd.state]} dot>{READINESS_LABEL[rd.state]}</Badge>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Quote total (ex VAT)</p>
            <p className="whitespace-nowrap text-2xl font-bold tabular-nums text-slate-900">{totalCents == null ? "—" : fmtCents(totalCents)}</p>
          </div>
        </div>
      </div>

      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      {notice && <div className="mt-4"><Alert tone="success">{notice}</Alert></div>}
      {final && <div className="mt-4"><Alert tone="info">This quote is the manager-approved final. Its accepted baseline is frozen; any change after acceptance must be a Variation on the Project.</Alert></div>}
      {budget && <p className="mt-3 text-xs text-slate-500">{budget.priceSource.notice} Provenance: {budget.priceSource.provenance}</p>}

      <nav className="mt-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Quote sections">
        {TABS.map((t) => (
          <button key={t.value} onClick={() => setTab(t.value)} aria-current={tab === t.value ? "page" : undefined}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.value ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab !== "approval" && tab !== "customer" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={save} loading={isWorking} disabled={!editable || !dirty}>Save draft</Button>
          {dirty && <span className="text-xs text-amber-700">Unsaved changes — figures below are a live preview.</span>}
          {!editable && <span className="text-xs text-slate-500">{final ? "Read-only: accepted quote." : "You do not have permission to edit."}</span>}
          {editable && !confirmDemo && <Button variant="secondary" onClick={() => (hasEntries(draft) ? setConfirmDemo(true) : loadDemo())}>Load Demo Defaults</Button>}
          {editable && confirmDemo && (
            <span className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
              This replaces the values in this draft with the demonstration quotation (nothing is saved until you press Save draft).
              <Button size="sm" onClick={loadDemo}>Replace with demo</Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDemo(false)}>Cancel</Button>
            </span>
          )}
        </div>
      )}
      {demoLoaded && tab !== "approval" && tab !== "customer" && (
        <div className="mt-3">
          <Alert tone={rd.state === "READY" ? "success" : "warning"}>
            Demo defaults loaded into this draft ({DEMO_DEFAULTS_SOURCE}) {demoLoaded.length ? `Replaced: ${demoLoaded.join(", ")}.` : "The draft already matched the demonstration; nothing changed."}{" "}
            Status: {READINESS_LABEL[rd.state]}.{rd.reasons.length ? ` Open: ${rd.reasons.join("; ")}.` : ""}
            {rd.counts.supplierQuoteRequired + rd.counts.missingMappings + rd.counts.pricingExceptions > 0 ? ` Unresolved: ${rd.counts.supplierQuoteRequired} supplier-quote-required, ${rd.counts.missingMappings} unmapped, ${rd.counts.pricingExceptions} pricing exceptions (listed below).` : " No supplier-quote-required, unmapped or pricing-exception items remain."}
            {" "}Prices marked POC MANUAL PRICE OVERRIDE are the demonstration quote&apos;s own estimator values. Not saved, approved, frozen or sent anywhere.
          </Alert>
        </div>
      )}

      {/* ───────────── 1 · CONFIGURATION ───────────── */}
      {tab === "config" && (
        <fieldset disabled={!editable} className="mt-4 space-y-6 border-0 p-0">
          <Panel>
            <PanelTitle>Customer & site</PanelTitle>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <TextField label="Customer" value={draft.customerName} onChange={(v) => edit((d) => { d.customerName = v; })} />
              <TextField label="Site / project name" value={draft.siteName} onChange={(v) => edit((d) => { d.siteName = v; })} />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Pricing basis</span>
                <select value={draft.quoteType} onChange={(e) => edit((d) => { d.quoteType = e.target.value as QuoteType; })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                  <option value="project">Project — landed cost + 20%</option>
                  <option value="day_to_day">Day-to-day — workbook Retail ex VAT</option>
                </select>
              </label>
            </div>
          </Panel>

          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PanelTitle>Room inputs — describe ONE room</PanelTitle>
              <Button variant="secondary" size="sm" onClick={() => edit((d) => { d.config = { ...structuredClone(TOPIGS_GROWER_INPUT), feederVariant: "STANDARD", exclusions: {}, estimatorQuantities: {}, quantityOverrides: {}, quantityOverrideReasons: {} }; })}>Load Topigs sample inputs</Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">{ROOMS_HELP}</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              <NumField label="Length" unit="m" value={cfg.lengthM || null} onChange={(v) => edit((d) => { d.config.lengthM = num(v); })} />
              <NumField label="Width" unit="m" value={cfg.widthM || null} onChange={(v) => edit((d) => { d.config.widthM = num(v); })} />
              <NumField label="Number of rooms" value={cfg.rooms || null} onChange={(v) => edit((d) => { d.config.rooms = num(v); })} hint="Multiplies every per-room quantity" />
              <NumField label="Total pens" unit="per room" value={cfg.totalPens || null} onChange={(v) => edit((d) => { d.config.totalPens = num(v); })} />
              <NumField label="Hospital pens" unit="per room" value={cfg.hospitalPens} onChange={(v) => edit((d) => { d.config.hospitalPens = num(v); })} />
              <NumField label="Pigs per room" value={cfg.pigsPerRoom || null} onChange={(v) => edit((d) => { d.config.pigsPerRoom = num(v); })} hint="±600 is per room" />
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Room floor area: <strong className="tabular-nums">{ev.calc.derived.floorAreaM2 == null ? "—" : `${Math.round(ev.calc.derived.floorAreaM2 * 1000) / 1000} m²`}</strong>
              {" "}· minimum lights per room = ceil(area ÷ 25) = <strong>{lineByKey.get("led_light")?.defaultQuantityPerRoom ?? "—"}</strong>
            </p>
          </Panel>

          <Panel>
            <PanelTitle>Selections</PanelTitle>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">CCM feeder variant</span>
                <select value={cfg.feederVariant ?? "STANDARD"} onChange={(e) => edit((d) => { d.config.feederVariant = e.target.value as "STANDARD" | "WINDOW"; delete d.estimator.confirmedMappings.feeder; })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                  <option value="STANDARD">Standard — PNQ082</option>
                  <option value="WINDOW">With window — PNQ082-WINDOW</option>
                </select>
                <span className="text-xs text-slate-500">One feeder, two variants. Capacity {CCM_FEEDER_CAPACITY_PIGS} pigs per feeder.</span>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Penning pig size</span>
                <select value={cfg.penningPigSize ?? ""} onChange={(e) => edit((d) => { d.config.penningPigSize = (e.target.value || null) as PenningPigSize | null; })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                  <option value="">Select…</option>
                  {(Object.keys(PIG_SIZE_LABEL) as PenningPigSize[]).map((k) => <option key={k} value={k}>{PIG_SIZE_LABEL[k]}</option>)}
                </select>
              </label>
              <NumField label="Penning running metres" unit="per room" value={cfg.penningRunningMetresPerRoom} onChange={(v) => edit((d) => { d.config.penningRunningMetresPerRoom = v; })} hint="Running metres, not m²" />
              <NumField label="Slatted floor area (context only)" unit="m², one room" value={cfg.slattedFloorAreaM2} onChange={(v) => edit((d) => { d.config.slattedFloorAreaM2 = v; })} hint="Never converted to a slat quantity — the rep enters the quantity" />
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Ventilation — optional inside Grower</PanelTitle>
            <p className="mt-2 text-xs text-warning">{VENTILATION_SCOPE_STATUS}. AS.03 is not yet ingested: no fan, cooling or controller rule is invented — once selected, the estimator enters the quantity after engineering review.</p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {(Object.keys(OPTIONAL_LABELS) as OptionalItemKey[]).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={cfg.optionalEquipment[k]} onChange={(e) => edit((d) => { d.config.optionalEquipment[k] = e.target.checked; })} /> {OPTIONAL_LABELS[k]}
                </label>
              ))}
            </div>
          </Panel>
        </fieldset>
      )}

      {/* ───────────── 2 · ESTIMATOR REVIEW ───────────── */}
      {tab === "review" && (
        <fieldset disabled={!editable} className="mt-4 space-y-6 border-0 p-0">
          <Panel>
            <div className="flex flex-wrap items-center gap-3">
              <PanelTitle>Quote readiness</PanelTitle>
              <Badge tone={READY_TONE[rd.state]} dot>{READINESS_LABEL[rd.state]}</Badge>
            </div>
            {rd.reasons.length > 0 && (
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-red-700">{rd.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {(Object.keys(CAT_LABEL) as ReadinessCategory[]).map((c) => (
                <details key={c} className="rounded-lg border border-slate-200 p-3 open:col-span-2 md:open:col-span-2">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-600">{CAT_LABEL[c]}</span>
                    <Badge tone={rd.counts[c] > 0 ? CAT_TONE[c] : "neutral"}>{rd.counts[c]}</Badge>
                  </summary>
                  {rd.items[c].length === 0 ? <p className="mt-2 text-xs text-slate-400">None.</p> : (
                    <ul className="mt-2 space-y-1 text-xs text-slate-700">{rd.items[c].map((i, n) => <li key={n}><span className="font-medium">{i.label}</span> — {i.detail}</li>)}</ul>
                  )}
                </details>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Manual-by-design items (feeder / drinker / slat quantities, M75, doors, tank, ventilation scope) only block the quote until the estimator supplies them.</p>
          </Panel>

          <Panel>
            <PanelTitle>Line decisions (per room × {cfg.rooms || 0} rooms)</PanelTitle>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">Item</th><th className="py-2 pr-3">Basis</th><th className="py-2 pr-3">Quantity per room</th><th className="py-2 pr-3 text-right">Project qty</th>
                    <th className="py-2 pr-3">Product</th><th className="py-2 pr-3 text-right">Line total (ex VAT)</th><th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.calc.lines.map((l) => {
                    const rule = GROWER_RULES.find((r) => r.itemKey === l.itemKey)!;
                    const b = bridgeByKey.get(l.itemKey);
                    const kind = valueKindOf(l);
                    const k = l.itemKey as GrowerItemKey;
                    const optionalOff = l.basis === "not_selected" && !l.exclusionReason;
                    return (
                      <tr key={l.itemKey} className={`border-b border-slate-100 align-top ${optionalOff ? "opacity-60" : ""}`}>
                        <td className="py-3 pr-3"><div className="font-medium text-slate-900">{l.label}</div><div className="font-mono text-[11px] text-slate-400">{l.ruleId}</div>
                          {l.exclusionReason && <div className="mt-1 text-xs text-amber-700">Excluded — {l.exclusionReason}</div>}</td>
                        <td className="py-3 pr-3"><Badge tone={l.overrideState === "manual_override" ? "warning" : KIND_TONE[kind]}>{l.overrideState === "manual_override" ? "OVERRIDE" : VALUE_KIND_LABEL[kind]}</Badge>
                          <div className="mt-1 text-[11px] text-slate-500">{rule.treatment.replace(/_/g, " ")}</div></td>
                        <td className="py-3 pr-3 min-w-[230px]">
                          {rule.estimatorEntry && l.basis !== "not_selected" && (
                            <NumField label="" value={cfg.estimatorQuantities?.[k] ?? null} onChange={(v) => edit((d) => { d.config.estimatorQuantities = { ...d.config.estimatorQuantities }; if (v == null) delete d.config.estimatorQuantities[k]; else d.config.estimatorQuantities[k] = v; })}
                              hint={l.itemKey === "feeder" ? `Capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs/feeder · ${cfg.pigsPerRoom} pigs/room. You confirm the number.` : l.itemKey === "cup_drinker" ? `Suggested ${l.suggestedQuantityPerRoom ?? "—"} (${cfg.pigsPerRoom} ÷ ${PIGS_PER_DRINKER}, unrounded). You confirm the number.` : l.itemKey === "flex_auger" ? "Number of M75 systems per room (client preference)" : "Estimator input"} />
                          )}
                          {l.itemKey === "penning_package" && <span className="text-slate-700">{l.quantityPerRoom == null ? <span className="text-amber-700">{l.inputRequired ?? "Enter on the Configuration tab"}</span> : `${l.quantityPerRoom} rm`}</span>}
                          {!rule.estimatorEntry && rule.defaultCompute && (
                            <div className="space-y-1">
                              <div className="text-xs text-slate-600">Default <strong>{l.defaultQuantityPerRoom ?? "—"}</strong>{l.itemKey === "led_light" ? " = ceil(area ÷ 25)" : " = 1 per feeder"}</div>
                              <NumField label="" placeholder="Override (blank = default)" value={cfg.quantityOverrides?.[k] ?? null} onChange={(v) => edit((d) => { d.config.quantityOverrides = { ...d.config.quantityOverrides }; if (v == null) delete d.config.quantityOverrides[k]; else d.config.quantityOverrides[k] = v; })} />
                              {cfg.quantityOverrides?.[k] != null && (
                                <TextField label="" placeholder="Reason for the override (required)" value={cfg.quantityOverrideReasons?.[k] ?? ""} onChange={(v) => edit((d) => { d.config.quantityOverrideReasons = { ...d.config.quantityOverrideReasons, [k]: v }; })} />
                              )}
                            </div>
                          )}
                          {l.basis === "not_selected" && !l.exclusionReason && <span className="text-xs text-slate-400">Optional — not selected</span>}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums">{l.projectQuantity ?? "—"}</td>
                        <td className="py-3 pr-3 text-xs text-slate-700">{b?.sku ?? (b?.pricedBy === "penning_rate" ? "Pig-size / running-metre basis" : b?.pricedBy === "estimator_input" ? "Estimator-priced system" : b?.pricedBy === "estimator_resolution" ? "Estimator-resolved" : "—")}</td>
                        <td className="py-3 pr-3 text-right tabular-nums">{b?.revenueExTax != null ? fmtZar(b.revenueExTax) : "—"}</td>
                        <td className="py-3 text-xs">{b ? (b.status === "priced" ? <span className="text-emerald-700">Priced</span> : b.status === "not_selected" ? "" : <span className="text-amber-700" title={b.reason}>{b.reason.slice(0, 80)}</span>) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PanelTitle>Product mappings</PanelTitle>
                <Button variant="secondary" size="sm" onClick={() => edit((d) => {
                  for (const l of ev.calc.lines) {
                    if (l.basis === "not_selected") continue;
                    const sku = expectedSkuFor(l.itemKey, d.config.feederVariant);
                    if (sku && l.itemKey !== "pvc_door") d.estimator.confirmedMappings[l.itemKey] = sku;
                    if (packageFor(l.itemKey) && !packageFor(l.itemKey)!.estimatorPriced && !d.estimator.confirmedPackages.includes(l.itemKey)) d.estimator.confirmedPackages.push(l.itemKey);
                  }
                })}>Confirm source-backed mappings</Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">Source-backed SKUs are recommendations until you confirm them. A historic surrogate (e.g. FERAX for FORTIS 1.2) is never substituted.</p>
              <ul className="mt-3 space-y-2 text-sm">
                {ev.calc.lines.filter((l) => l.basis !== "not_selected").map((l) => {
                  const exp = expectedSkuFor(l.itemKey, cfg.feederVariant);
                  const pkg = packageFor(l.itemKey);
                  const confirmed = draft.estimator.confirmedMappings[l.itemKey];
                  const door = l.itemKey === "pvc_door";
                  if (l.itemKey === "penning_package" || pkg?.estimatorPriced) return null;
                  return (
                    <li key={l.itemKey} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                      <span className="text-slate-700">{l.label}</span>
                      {door ? (
                        <select value={confirmed ?? ""} onChange={(e) => edit((d) => { if (e.target.value) d.estimator.confirmedMappings.pvc_door = e.target.value; else delete d.estimator.confirmedMappings.pvc_door; })} className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs">
                          <option value="">Select door product…</option>
                          {manualSelectionSkusFor("pvc_door").map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : pkg ? (
                        <Badge tone={draft.estimator.confirmedPackages.includes(l.itemKey) ? "success" : "warning"}>{draft.estimator.confirmedPackages.includes(l.itemKey) ? "Package confirmed" : "Package unconfirmed"}</Badge>
                      ) : (
                        <Badge tone={confirmed && confirmed === exp ? "success" : "warning"}>{confirmed && confirmed === exp ? `Confirmed ${confirmed}` : `Recommended ${exp ?? "—"}`}</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel>
              <PanelTitle>Commercial inputs (ex VAT)</PanelTitle>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {(["delivery", "installation", "concrete_slat_delivery"] as ChargeKey[]).map((c) => (
                  <NumField key={c} label={CHARGE_LABEL[c]} unit="R" hint={CHARGE_HELP[c]} value={draft.estimator.charges[c] ?? null} onChange={(v) => edit((d) => { d.estimator.charges = { ...d.estimator.charges, [c]: v }; })} />
                ))}
                <NumField label="M75 system price" unit="R per system" hint="Estimator input by design. NQ3132 is N/A — supplier quote required; it is not priced separately." value={draft.estimator.unitPrices.flex_auger ?? null} onChange={(v) => edit((d) => { d.estimator.unitPrices = { ...d.estimator.unitPrices, flex_auger: v }; })} />
              </div>
              <label className="mt-4 flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Assumptions (frozen with the quote)</span>
                <textarea value={draft.estimator.assumptions} onChange={(e) => edit((d) => { d.estimator.assumptions = e.target.value; })} rows={3} className="rounded-md border border-slate-300 p-2 text-sm" />
              </label>
            </Panel>
          </div>

          <ScopePanel quoteId={id} draft={draft} />

          {(budget?.lines ?? []).some((b) => ["unmapped", "not_in_price_source", "supplier_quote_required", "package_unconfirmed", "package_incomplete"].includes(b.status) || b.pricedBy === "estimator_resolution") && (
            <Panel>
              <PanelTitle>POC MANUAL PRICE OVERRIDE — pricing exceptions</PanelTitle>
              <p className="mt-2 text-xs text-slate-500">A line the price source cannot price (no SKU yet, not in the workbook, or a zero price needing a supplier quote) is never quoted at R0. Enter the commercial unit price and why (e.g. “Master workbook has no usable price for this SKU. Temporary POC estimator value only.”). This is a quote input — it is never written back to the Master snapshot.</p>
              <div className="mt-4 space-y-4">
                {(budget?.lines ?? []).filter((b) => ["unmapped", "not_in_price_source", "supplier_quote_required", "package_unconfirmed", "package_incomplete"].includes(b.status) || b.pricedBy === "estimator_resolution").map((b) => {
                  const k = b.itemKey as GrowerItemKey;
                  const r = draft.estimator.priceResolutions[k];
                  return (
                    <div key={b.itemKey} className="grid items-end gap-3 md:grid-cols-[1.4fr_1fr_2fr]">
                      <div><div className="text-sm font-medium text-slate-900">{b.label}</div><div className="text-xs text-amber-700">{b.reason}</div></div>
                      <NumField label="Unit price" unit="R ex VAT" value={r?.unitPriceExVat ?? null} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: v ?? 0, reason: d.estimator.priceResolutions[k]?.reason ?? "" } }; })} />
                      <TextField label="Reason" value={r?.reason ?? ""} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: d.estimator.priceResolutions[k]?.unitPriceExVat ?? 0, reason: v } }; })} />
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          <Panel>
            <PanelTitle>Customer-driven exclusions</PanelTitle>
            <p className="mt-2 text-xs text-slate-500">Everything in the template is required by default. Exclude a section only at the customer&apos;s request, with a reason that stays visible and is frozen in the baseline.</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {ev.calc.lines.filter((l) => !GROWER_RULES.find((r) => r.itemKey === l.itemKey)!.optionalKey).map((l) => {
                const k = l.itemKey as GrowerItemKey;
                const on = cfg.exclusions?.[k] !== undefined;
                return (
                  <div key={l.itemKey} className="flex items-center gap-3 text-sm">
                    <label className="flex w-64 items-center gap-2 text-slate-700"><input type="checkbox" checked={on} onChange={(e) => edit((d) => { d.config.exclusions = { ...d.config.exclusions }; if (e.target.checked) d.config.exclusions[k] = ""; else delete d.config.exclusions[k]; })} /> Exclude {l.label.split(" (")[0]}</label>
                    {on && <TextField label="" placeholder="Reason (required)" value={cfg.exclusions?.[k] ?? ""} onChange={(v) => edit((d) => { d.config.exclusions = { ...d.config.exclusions, [k]: v }; })} />}
                  </div>
                );
              })}
            </div>
          </Panel>

          {budget && (
            <Panel>
              <PanelTitle>Totals</PanelTitle>
              <dl className="mt-3 grid max-w-xl grid-cols-2 gap-y-1 text-sm">
                <dt className="text-slate-600">Subtotal (ex VAT)</dt><dd className="text-right tabular-nums">{fmtZar(budget.totals.subtotalExTax)}</dd>
                <dt className="text-slate-600">VAT 15%</dt><dd className="text-right tabular-nums">{fmtZar(budget.totals.taxTotal)}</dd>
                <dt className="font-semibold text-slate-900">Total</dt><dd className="text-right font-semibold tabular-nums">{fmtZar(budget.totals.totalIncTax)}</dd>
                {view.viewer.canViewCommercials && <><dt className="text-slate-600">Estimated cost · GP (managers)</dt><dd className="text-right tabular-nums">{fmtZar(budget.totals.estimatedCost)} · {budget.totals.overallMarginPct == null ? "N/A" : `${budget.totals.overallMarginPct.toFixed(1)}%`}</dd></>}
              </dl>
              <p className="mt-2 text-xs text-slate-500">{budget.pricingBasis}. {budget.state === "complete" ? "Every required line is priced." : "Incomplete: the total is partial until every blocker is resolved."}</p>
            </Panel>
          )}

          {budget && view.viewer.canViewCommercials && (
            <MarginPanel budget={budget} draft={draft} final={final} frozen={q.accepted_baseline?.internalMargin} editable={editable} edit={edit} />
          )}
        </fieldset>
      )}

      {/* ───────────── 3 · CUSTOMER QUOTE ───────────── */}
      {tab === "customer" && (
        <Panel className="mt-4">
          {!summary ? (
            <Alert tone="warning">The customer summary appears once the quote is complete (READY). Resolve the items on the Estimator review tab.</Alert>
          ) : (
            <div className="mx-auto max-w-3xl">
              <p className="text-xs uppercase tracking-wide text-slate-500">Newquip Agri Supplies · Quotation {q.quote_ref}{q.revision > 1 ? ` (revision ${q.revision})` : ""}</p>
              <h2 className="mt-1 text-xl font-bold text-slate-900">Grower house — {draft.siteName}</h2>
              <p className="text-sm text-slate-600">Prepared for {draft.customerName} · {cfg.rooms} room{cfg.rooms === 1 ? "" : "s"}</p>
              <table className="mt-5 w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><th className="py-2 text-left">Scope</th><th className="py-2 text-right">Amount (ex VAT)</th></tr></thead>
                <tbody>
                  {summary.sections.map((s) => (
                    <tr key={s.title} className="border-b border-slate-100 align-top"><td className="py-3 pr-4"><div className="font-medium text-slate-900">{s.title}</div><div className="text-xs text-slate-500">{s.scope}</div></td><td className="py-3 text-right tabular-nums whitespace-nowrap">{fmtZar(s.amountExVat)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td className="pt-3 text-right text-slate-600">Subtotal</td><td className="pt-3 text-right tabular-nums">{fmtZar(summary.subtotalExVat)}</td></tr>
                  <tr><td className="text-right text-slate-600">VAT 15%</td><td className="text-right tabular-nums">{fmtZar(summary.vat)}</td></tr>
                  <tr><td className="pt-1 text-right font-semibold text-slate-900">Total</td><td className="pt-1 text-right text-lg font-bold tabular-nums">{fmtZar(summary.totalIncVat)}</td></tr>
                </tfoot>
              </table>
              {draft.estimator.assumptions.trim() && <p className="mt-4 text-xs text-slate-500"><strong>Assumptions:</strong> {draft.estimator.assumptions}</p>}
              {Object.entries(cfg.exclusions ?? {}).filter(([, r]) => r.trim()).length > 0 && <p className="mt-2 text-xs text-slate-500"><strong>Excluded at your request:</strong> {Object.keys(cfg.exclusions ?? {}).filter((k) => cfg.exclusions![k as GrowerItemKey]?.trim()).join(", ").replace(/_/g, " ")}</p>}
              <p className="mt-6 text-xs text-slate-400">Summary view — individual stock lines are kept on the internal estimator view. Not an e-signature; acceptance is recorded by the manager&apos;s final approval.</p>
            </div>
          )}
        </Panel>
      )}

      {/* ───────────── 4 · APPROVAL & PROJECT ───────────── */}
      {tab === "approval" && (
        <div className="mt-4 space-y-6">
          <Panel>
            <PanelTitle>Approval history</PanelTitle>
            <div className="mt-2"><ApprovalHistory docType="QUOTE" docId={id} label="Show the timestamped approval history (also on the Approvals page)" /></div>
          </Panel>

          <Panel>
            <PanelTitle>Workflow</PanelTitle>
            <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
              {[
                ["Customer confirmed amount", q.customer_confirmed_cents ? `${fmtCents(q.customer_confirmed_cents)} · ${q.customer_confirmed_by ?? ""}` : "—"],
                ["Sent to estimator by", q.handoff_by_email ?? "—"],
                ["Estimator sign-off", q.estimator_signoff_hash ? (q.estimator_signoff_hash === q.draft_hash ? `${q.estimator_signoff_by_email} · current` : "stale") : "—"],
                ["Manager approval", q.approved_by_email ? `${q.approved_by_email}` : "—"],
              ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 font-medium text-slate-900">{v}</dd></div>)}
            </dl>

            <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-5">
              {q.state === "REP_DRAFT" && (
                <>
                  <TextField label="Customer contact who confirmed the amount" value={confirmedBy} onChange={setConfirmedBy} />
                  <Button loading={isWorking} disabled={!roles.has("rep") || rd.state !== "READY" || totalCents == null || !confirmedBy.trim()}
                    onClick={() => act(() => sendGrowerQuoteToEstimatorAction(id, totalCents!, confirmedBy), "Sent to the estimator. The customer's confirmation of the amount is recorded.")}>
                    Customer confirmed {totalCents == null ? "amount" : fmtCents(totalCents)} — send to estimator
                  </Button>
                  {rd.state !== "READY" && <span className="text-xs text-amber-700">The quote must be READY before a customer can confirm an amount.</span>}
                </>
              )}
              {q.state === "ESTIMATOR_REVIEW" && (
                <>
                  <Button loading={isWorking} disabled={!roles.has("estimator") || rd.state !== "READY"} onClick={() => act(() => signOffGrowerQuoteAction(id), "Estimator sign-off recorded for this exact content.")}>Estimator: I double-checked this quote</Button>
                  <Button variant="primary" loading={isWorking} disabled={!roles.has("manager") || !q.estimator_signoff_hash || q.estimator_signoff_hash !== q.draft_hash || dirty}
                    onClick={() => act(() => approveGrowerQuoteAction(id), "Approved. The accepted baseline is frozen; the Project can now be created.")}>Manager: final approval</Button>
                  {!roles.has("manager") && <span className="text-xs text-slate-500">Final approval needs the manager role (org owner/admin).</span>}
                  <TextField label="Return to rep — reason" value={returnReason} onChange={setReturnReason} />
                  <Button variant="secondary" loading={isWorking} disabled={!returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToRepAction(id, returnReason), "Returned to the rep as a new revision.")}>Return to rep</Button>
                  {q.estimator_signoff_hash && (
                    <Button variant="secondary" loading={isWorking} disabled={!roles.has("manager") || !returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToEstimatorAction(id, returnReason), "Returned to the estimator. Their sign-off is withdrawn and must be given again; the quote and its history are kept.")}>Manager: return to estimator</Button>
                  )}
                </>
              )}
              {final && <Badge tone="success" dot>Manager approved — final</Badge>}
            </div>
          </Panel>

          {final && <ScopePanel quoteId={id} draft={draft} />}

          {final && q.accepted_baseline && (
            <Panel>
              <PanelTitle>Accepted baseline (frozen)</PanelTitle>
              <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                {[
                  ["Total contract value (ex VAT)", fmtCents(q.accepted_baseline.contractCents)],
                  ["Template", `${q.accepted_baseline.template.name} v${q.accepted_baseline.template.version}`],
                  ["Rule set", q.accepted_baseline.template.rulesetVersion],
                  ["Quote revision", String(q.accepted_baseline.quote.revision)],
                  ["Price source", q.accepted_baseline.pricing.source.label],
                  ["Pricing basis", q.accepted_baseline.pricing.basis],
                  ["Overrides · exclusions · price resolutions", `${q.accepted_baseline.overrides.length} · ${q.accepted_baseline.exclusions.length} · ${q.accepted_baseline.priceResolutions.length}`],
                  ["Seal (sha256)", `${(q.baseline_hash ?? "").slice(0, 16)}…`],
                ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 break-words font-medium text-slate-900">{v}</dd></div>)}
              </dl>
              <p className="mt-3 text-xs text-slate-500">Cin7: <strong>NOT SENT TO CIN7</strong> — the push to Cin7 comes later and is not part of the POC.</p>

              <div className="mt-5 border-t border-slate-100 pt-5">
                {q.project_id ? (
                  <Link href={`/projects/${q.project_id}`} className="inline-flex h-9 items-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">Open the Project</Link>
                ) : (
                  <>
                  <ScheduleChooser contractCents={q.accepted_baseline.contractCents} onChange={setScheduleChoice} />
                  <p className="mb-2"><BuildStamp /></p>
                  <Button loading={isWorking} disabled={!resolveScheduleChoice(scheduleChoice).ok} onClick={() => start(async () => {
                    const r = await createProjectFromGrowerQuoteAction(id, scheduleChoice);
                    if (!r.ok) return setError(r.error ?? "Unknown error");
                    setError(null);
                    const made = r.data;
                    setNotice(`Project ${made?.created === false ? "already existed (its stages were not changed)" : "created from the accepted baseline (no engineering recalculation)"}. Billing stages: ${(made?.stages ?? []).map((x) => `${x.name} ${fmtCents(x.valueCents)}`).join(" · ") || "none"}.`);
                    const v = await getGrowerQuoteAction(id);
                    if (v.ok && v.data) adopt(v.data);
                  })}>Create Project from accepted quote</Button>
                  </>
                )}
              </div>
            </Panel>
          )}
        </div>
      )}
    </main>
  );
}
