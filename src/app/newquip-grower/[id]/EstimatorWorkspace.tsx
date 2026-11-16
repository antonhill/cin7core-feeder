"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import { manualSelectionSkusFor } from "@/newquip/grower/commercial";
import type { GrowerItemKey } from "@/newquip/grower/types";
import { buildWorkspace, costText, decodeManualReason, money, needsEvidence, targetOf, taskStatusWord, type TaskKind, type WorkspaceTask } from "@/newquip/quote/estimator-workspace";
import { applyEditor, revisionReason, type SkuEditor } from "@/newquip/quote/workspace-submission";
import { applyEstimatorPricingAction, attestEstimatorRatesAction, getEstimatorPricingAction, recordManualPriceEvidenceAction, verifyEstimatorCostsAction } from "../pricing-actions";
import type { IndicativeComparison } from "@/newquip/pricing/comparison";
import { M75PriceForm, ManualPriceForm, PackageConfirm, ProductChoice, Rail, SkuCostForm, type SaveResult } from "./WorkspaceEditors";
import { CompleteGroup, EvidenceOpenRow, HowItWorks, NextActionBar, OpenRow, ReadinessList, RepItems, SummaryPanel, WorkspaceHeader } from "./WorkspaceParts";

// NewQuip Phase 2: the ESTIMATOR WORKSPACE. It replaces the stacked Line decisions / Product mappings / Cin7 cost capture / Margin detail / Cost overrides / supplier-pricing forms for a quotation
// whose supplier pricing is ON. Everything it shows comes from the existing bridge and pricing model; every save goes through the existing server actions (supplier pricing: one revision merged
// onto the CURRENT stored pricing with the base read just before saving; draft decisions: the existing draft save). Typed values are never discarded by a refusal or a conflict.

export interface EstimatorWorkspaceProps {
  quoteId: string;
  /** REP_DRAFT | ESTIMATOR_REVIEW */
  state: string;
  confirmedCents: number | null;
  signedOff: boolean;
  draft: QuoteDraft;
  budget: BudgetQuote;
  /** The page holds unsaved draft edits: draft-level saves are refused until they are saved or discarded. */
  pageDirty: boolean;
  /** The viewer is the Estimator (the only role that may enter pricing). */
  canEdit: boolean;
  title: string;
  subtitle: string;
  /** Header facts (all optional so older callers still render): the quotation reference, customer, rooms and pricing basis. */
  siteName?: string;
  reference?: string;
  /** The quotation revision (above 1 with the Rep means it was returned to the Rep). */
  revision?: number;
  customerName?: string;
  rooms?: number;
  basis?: string;
  /** The legacy strips that used to stack above the workspace (calculation status, submission and confirmation history, readiness sentence, total-changed note, phase descriptions), shown behind ONE Details disclosure. */
  details?: ReactNode;
  /** One compact phase stepper line (the phase navigation), shown under the header. */
  phases?: ReactNode;
  /** Changes whenever the saved quotation changed elsewhere (re-reads the pricing). */
  refreshKey: string;
  /** Saves the page's CURRENT draft with one change applied, through the existing draft save (server rules, sign-off withdrawal and concurrency unchanged). */
  saveDraft: (mut: (d: QuoteDraft) => void) => Promise<SaveResult>;
  /** Re-reads the quotation (after a pricing revision). The promise settles when the page shows the new figures, so a save can wait for them. */
  reload: () => Promise<void> | void;
  /** The Rep's handoff comparison (cost-entitled viewers only): what each line was worth on the reference basis, for the "excluded until costed" explanation. */
  comparison?: IndicativeComparison | null;
  onGoSignoff: () => void;
  onGoApproval: () => void;
  /** The Estimator's final-review mark is still needed before sign-off (the existing in-session acknowledgement). */
  reviewNeeded: boolean;
  onMarkReviewed: () => void;
  /** Reports whether an editor holds unsaved typed values (the page uses it to guard its own buttons that leave the workspace). */
  onDirtyChange?: (dirty: boolean) => void;
}

type Open = { id: string; kind: TaskKind } | null;

export function EstimatorWorkspace(p: EstimatorWorkspaceProps) {
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<Open | "list" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const readSeq = useRef(0);
  /** > 0 while one of THIS workspace's own saves is running: the page changes that follow it are its own, so they do not trigger a second read of the workspace (the save already carries it). */
  const busyRef = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  useUnsavedGuard(dirty, "You have unsaved changes in this editor. If you leave now they are lost.");
  const { onDirtyChange } = p;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const load = useCallback((): Promise<void> => {
    const seq = ++readSeq.current;
    return getEstimatorPricingAction(p.quoteId).then((r) => {
      if (seq !== readSeq.current) return;
      if (r.ok && r.data) { setBundle(r.data); setLoadError(null); } else setLoadError(r.error ?? "Supplier pricing could not be loaded.");
    }, () => { if (seq === readSeq.current) setLoadError("Supplier pricing could not be read (the connection or the server failed). Nothing you typed was lost."); });
  }, [p.quoteId]);
  /** The page change a save of this workspace causes commits a moment AFTER the save's promise settles, so its own refresh-key change is ignored for a short window after it. */
  const ownUntil = useRef(0);
  useEffect(() => { if (busyRef.current > 0 || Date.now() < ownUntil.current) return; void load(); }, [load, p.refreshKey]);
  async function own<T>(fn: () => Promise<T>): Promise<T> { busyRef.current += 1; try { return await fn(); } finally { busyRef.current -= 1; ownUntil.current = Date.now() + 1500; } }
  /** Waits for the page to show the new figures (the heading, task count, summary, readiness and next action all derive from them), with an honest status line meanwhile. */
  async function refreshPage() { setRefreshing(true); try { await p.reload(); } finally { setRefreshing(false); } }

  const ws = useMemo(() => (bundle ? buildWorkspace({
    budget: p.budget, view: bundle.view,
    facts: { state: p.state, revision: p.revision, confirmedCents: p.confirmedCents, signedOff: p.signedOff, canEdit: p.canEdit && bundle.canEdit, canReview: bundle.verification.canReview, confirmedPackages: p.draft.estimator.confirmedPackages, reference: p.comparison ?? null, confirmedMappings: p.draft.estimator.confirmedMappings, priceResolutionReasons: Object.fromEntries(Object.entries(p.draft.estimator.priceResolutions).map(([k, v]) => [k, v?.reason])) },
  }) : null), [bundle, p.budget, p.state, p.revision, p.confirmedCents, p.signedOff, p.canEdit, p.draft, p.comparison]);

  if (loadError && !bundle) return <div className="mt-4"><Alert tone="warning"><span data-testid="workspace-error">{loadError}</span></Alert><Button className="mt-2 min-h-11" variant="secondary" onClick={() => void load()}>Try again</Button></div>;
  if (!bundle || !ws) return <p className="mt-4 text-sm text-slate-800" data-testid="workspace-loading">Loading the Estimator workspace…</p>;

  const bnd = bundle; // narrowed once: the save closures below use it
  const canEdit = p.canEdit && bundle.canEdit;
  const live = p.budget.lines.filter((l) => l.status !== "not_selected");
  const lineOf = (id: string) => live.find((l) => l.itemKey === id);

  // ── navigation with an unsaved-editor guard ──
  const go = (to: Open | "list") => { if (dirty) { setPendingNav(to); return; } setOpen(to === "list" ? null : to); setNote(null); };
  const hasChoices = (id: string) => manualSelectionSkusFor(id as GrowerItemKey).length > 0;
  const openTask = (t: WorkspaceTask) => go({ id: t.id, kind: t.kind !== "m75" && hasChoices(t.id) ? "product" : t.kind });
  const openLine = (id: string) => { const l = lineOf(id); if (!l) return; const tg = targetOf(l); go({ id, kind: tg.kind === "complete_manual" ? "manual" : tg.kind !== "m75" && hasChoices(id) ? "product" : tg.kind }); };

  // ── saves ──
  /**
   * Supplier pricing: ONE product's inputs merged onto the stored pricing. The base is the stored pricing these edits were made AGAINST (the workspace as last read, which every save of this
   * workspace refreshes), so the server's field-by-field merge refuses a real conflict with a change made by someone else and every typed value is kept. A save is ONE write call (it returns the
   * workspace as it is after the write) plus ONE page read; nothing here reads the workspace a second time.
   */
  async function saveSku(sku: string, ed: SkuEditor, beforeMapping?: () => Promise<SaveResult>): Promise<SaveResult> {
    return own(async () => {
      let productSaved = false;
      if (beforeMapping) { const m = await beforeMapping(); if (!m.ok) return m; productSaved = true; }
      const withProduct = (errs: string[]): string[] => (productSaved ? ["The product was saved, but the cost was not.", ...errs] : errs);
      const base = bnd.current;
      const sub = applyEditor(base, sku, ed, new Date().toISOString());
      if (!sub) return { ok: false, errors: withProduct(["The values are not complete, so the cost was not saved."]) };
      const r = await applyEstimatorPricingAction(p.quoteId, sub, revisionReason(`supplier cost for ${sku}`), base);
      if (!r.ok) { if (r.conflicts?.length) await load(); return { ok: false, errors: withProduct(r.errors?.length ? r.errors : [r.error ?? "Could not save."]) }; }
      const c = r.data?.confirmation;
      setNote(c?.returnedToRep ? `Saved as revision ${r.data!.seq}. The customer total changed, so the Rep's confirmation was withdrawn and the quotation is back with the Rep to reconfirm.` : `Saved as revision ${r.data!.seq}.`);
      if (r.data?.workspace) { setBundle(r.data.workspace); setLoadError(null); } else await load();
      await refreshPage();
      return { ok: true };
    });
  }
  /** A draft-level decision (product, package confirmation, manual price, M75 price): the existing draft save, then the workspace re-read once (a product choice changes which supplier costs are needed). */
  const draftSave = (mut: (d: QuoteDraft) => void, opts: { rereadWorkspace?: boolean } = {}): Promise<SaveResult> => own(async () => {
    const r = await p.saveDraft(mut);
    if (r.ok && opts.rereadWorkspace !== false) await load();
    return r;
  });
  const saveMapping = (itemKey: string, sku: string | null, opts?: { rereadWorkspace?: boolean }) => draftSave((d) => { if (sku) d.estimator.confirmedMappings[itemKey as GrowerItemKey] = sku; else delete d.estimator.confirmedMappings[itemKey as GrowerItemKey]; }, opts);
  const saveConfirmed = (itemKey: string, yes: boolean) => draftSave((d) => { const rest = d.estimator.confirmedPackages.filter((k) => k !== itemKey); d.estimator.confirmedPackages = yes ? [...rest, itemKey as GrowerItemKey] : rest; });
  /** The pricing-evidence record the approval needs for a SKU-less manual line (the EXISTING action; it never changes a price and binds the note to the current price). */
  const recordEvidence = (itemKey: string, note: string, reference: string): Promise<SaveResult> => own(async () => {
    const r = await recordManualPriceEvidenceAction(p.quoteId, [{ itemKey, note, ...(reference ? { reference } : {}) }]);
    if (!r.ok) return { ok: false, errors: r.errors?.length ? r.errors : [r.error ?? "Could not record the evidence."] };
    setNote("Pricing evidence recorded. No price changed.");
    await load(); await refreshPage();
    return { ok: true };
  });
  /** A manual quotation price: the draft save carries the labelled reason + evidence; the SAME evidence is then recorded in the approval's pricing-evidence record, so one input satisfies both. */
  const saveManual = (itemKey: string, unit: number, reason: string): Promise<SaveResult> => own(async () => {
    const r = await draftSave((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [itemKey]: { unitPriceExVat: unit, reason } }; }, { rereadWorkspace: false });
    if (!r.ok) return r;
    const evidence = decodeManualReason(reason).evidence.trim();
    // Decide from the SERVER's own record of which lines need pricing evidence (the same rule it enforces) and whether it already covers the current price: a line the server does not list (for example a package with a SKU-bearing component) gets no
    // evidence call and no gate, and an unchanged price with the same evidence note is already recorded (nothing to do).
    const fresh = await getEstimatorPricingAction(p.quoteId);
    if (fresh.ok && fresh.data) setBundle(fresh.data);
    const row = fresh.ok && fresh.data ? (fresh.data.view.manualEvidence ?? []).find((m) => m.itemKey === itemKey) : undefined;
    if (row && !(row.state === "recorded" && (row.note ?? "").trim() === evidence)) {
      const e = await recordManualPriceEvidenceAction(p.quoteId, [{ itemKey, note: evidence }]);
      const already = !e.ok && /nothing changed/i.test([e.error ?? "", ...(e.errors ?? [])].join(" "));
      await load();
      if (!e.ok && !already) return { ok: false, errors: ["The price was saved, but its evidence could not be recorded in the approval's evidence record.", ...(e.errors?.length ? e.errors : [e.error ?? ""])].filter(Boolean) };
    }
    await refreshPage();
    return { ok: true };
  });
  const saveM75 = (itemKey: string, unit: number) => draftSave((d) => { d.estimator.unitPrices = { ...d.estimator.unitPrices, [itemKey]: unit }; });
  const removeManual = (itemKey: string) => draftSave((d) => { const n = { ...d.estimator.priceResolutions }; delete n[itemKey as GrowerItemKey]; d.estimator.priceResolutions = n; });

  const s = ws.summary;
  /** Lines whose only open item is their pricing-evidence record: they gate sign-off, so they are listed with the open tasks (not hidden in the completed group). */
  const evidenceRows = ws.complete.filter(needsEvidence);
  const doneLines = ws.complete.filter((c) => !needsEvidence(c));
  const openRows = ws.tasks.length + evidenceRows.length;
  const taskById = (id: string) => ws.tasks.find((t) => t.id === id);
  const rail = ws.tasks.map((t) => ({ id: t.id, n: t.n, label: t.label }));
  const onNext = ((): (() => void) | null => {
    switch (ws.next.kind) {
      case "open_task": { const t = taskById(ws.next.taskId ?? ""); return t ? () => openTask(t) : null; }
      case "return_to_rep": case "sign_off": return p.reviewNeeded && ws.next.kind === "sign_off" ? p.onMarkReviewed : p.onGoSignoff;
      case "verify_costs": return () => document.getElementById("ws-verify")?.scrollIntoView({ behavior: "smooth" });
      case "wait_manager_approval": return p.onGoApproval;
      case "record_evidence": return () => document.getElementById("ws-needs")?.scrollIntoView({ behavior: "smooth" });
      default: return null;
    }
  })();
  const nextForBar = ws.next.kind === "sign_off" && p.reviewNeeded ? { ...ws.next, headline: "Mark the final review, then sign off", detail: "Review the commercial summary once. This is not a sign-off.", button: "Mark reviewed" } : ws.next;
  const step: 1 | 2 | 3 | 4 | 5 = ws.next.kind === "open_task" || ws.next.kind === "return_to_rep" ? 1 : ws.next.kind === "wait_rep" ? 2 : ws.next.kind === "verify_costs" || ws.next.kind === "wait_manager" ? 3 : ws.next.kind === "sign_off" ? 4 : 5;

  // ── the editor for the open task ──
  const editor = (() => {
    if (!open) return null;
    const line = lineOf(open.id);
    if (!line) return <p className="text-sm text-slate-700">That line is no longer on the quotation.</p>;
    const tg = targetOf(line);
    const qty = line.quantity ?? 0;
    const chosenSaved = p.draft.estimator.confirmedMappings[open.id as GrowerItemKey];
    const manualHere = p.draft.estimator.priceResolutions[open.id as GrowerItemKey];
    const costForm = (sku: string, label: string, q: number, before?: () => Promise<SaveResult>, saveLabel?: string) => <SkuCostForm key={sku} sku={sku} label={label} quantity={q} bundle={bundle} canEdit={canEdit} save={(k, e) => saveSku(k, e, before)} onDirty={setDirty} saveLabel={saveLabel} />;
    // The editor is chosen by the kind the task was OPENED with (stable): a save that changes the line's status never swaps the editor, so typed values are never rebuilt away.
    if (open.kind === "m75") return <M75PriceForm key={`m75-${open.id}`} itemKey={open.id} label={line.label} quantity={qty} existing={p.draft.estimator.unitPrices[open.id as GrowerItemKey]} canEdit={canEdit} save={saveM75} onDirty={setDirty} onSaved={() => setNote("M75 price saved.")} />;
    if (open.kind === "manual") {
      const parts = line.components && line.components.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="manual-parts"><h3 className="mb-2 text-[15px] font-bold">Why a product cannot be mapped yet <span className="font-normal text-slate-600">· read-only</span></h3>
          <ul className="text-sm">{line.components.map((c) => <li key={c.id} className="flex justify-between border-t border-slate-100 py-1.5 first:border-0"><span>{c.description}</span><span className="text-amber-900">{c.sku ? c.sku : "No SKU or contradictory sources"}</span></li>)}</ul>
          <p className="mt-2 text-xs text-slate-700">This screen invents no product and substitutes no look-alike. Only NewQuip can settle the codes.</p></section>
      ) : undefined;
      return <ManualPriceForm key={`manual-${open.id}`} itemKey={open.id} label={line.label} quantity={qty} existing={manualHere} canEdit={canEdit} parts={parts} save={saveManual} onDirty={setDirty} onSaved={() => setNote("Saved. This line is priced as a manual, provisional quotation price.")} remove={removeManual} />;
    }
    if (open.kind === "package") {
      const confirmed = p.draft.estimator.confirmedPackages.includes(open.id as GrowerItemKey);
      return <PackageEditor key={`pkg-${open.id}`} line={line} confirmed={confirmed} bundle={bundle} canEdit={canEdit} onConfirm={(yes) => saveConfirmed(open.id, yes)} costForm={costForm} onManual={() => go({ id: open.id, kind: "manual" })} />;
    }
    if (open.kind === "product") {
      return <DoorEditor key={`door-${open.id}`} itemKey={open.id} label={line.label} qty={qty} chosenSaved={chosenSaved} canEdit={canEdit} saveMapping={saveMapping} costForm={costForm} onSaved={() => setNote("Product saved.")} />;
    }
    return costForm(line.sku ?? tg.skus[0] ?? open.id, line.label, qty);
  })();

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4" data-testid="estimator-workspace">
      {/* 1 · ONE compact header */}
      <WorkspaceHeader name={p.siteName ?? p.title} reference={p.reference ?? ""} customer={p.customerName ?? ""} rooms={p.rooms ?? 0} basis={p.basis ?? ""} stageLabel={p.state === "REP_DRAFT" ? "WITH THE REP" : "ESTIMATOR REVIEW"} summary={s} outstanding={openRows} phases={p.phases} details={p.details} />

      <NextActionBar next={nextForBar.kind === "open_task" ? { ...nextForBar, detail: "" } : nextForBar} onAction={onNext} />
      {refreshing && <Alert tone="info"><span role="status" data-testid="refreshing-note">Saved. Refreshing the totals, readiness and next action…</span></Alert>}
      {note && <Alert tone="info"><span role="status" data-testid="pricing-note">{note}</span></Alert>}
      {loadError && <Alert tone="warning"><span data-testid="workspace-refresh-error">{loadError}</span> <button type="button" className="font-semibold underline" onClick={() => void load()}>Reload</button></Alert>}
      {pendingNav && (
        <Alert tone="warning"><div role="alertdialog" aria-label="Unsaved changes" data-testid="unsaved-warning" className="flex flex-wrap items-center gap-3"><span>You have unsaved changes in this editor.</span>
          <Button size="sm" variant="secondary" onClick={() => setPendingNav(null)}>Keep editing</Button>
          <Button size="sm" variant="destructive" onClick={() => { const to = pendingNav; setPendingNav(null); setDirty(false); setOpen(to === "list" ? null : to); setNote(null); }}>Discard and continue</Button></div></Alert>
      )}

      {open && editor ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" onClick={() => go("list")} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-800 underline">← Back to tasks</button><span className="text-sm text-slate-700">{p.title} · {openRows} task{openRows === 1 ? "" : "s"} open · partial total {money(s.totalExVat)}</span></div>
          <div className="flex min-w-0 flex-col gap-5 sm:flex-row">
            <Rail tasks={rail} activeId={open.id} onSelect={(id) => { const t = taskById(id); if (t) openTask(t); }} />
            <div className="min-w-0 flex-1"><h3 className="text-2xl font-bold" data-testid="editor-title">{lineOf(open.id)?.label ?? open.id}</h3>{taskById(open.id) && <div className="mb-3 mt-1"><ReadinessList value={taskById(open.id)!.indicators} /></div>}{editor}</div>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-4">
            <section aria-labelledby="ws-needs" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="needs-you">
              <div className="border-b border-slate-200 px-4 py-2.5 sm:px-5"><h2 id="ws-needs" className="text-base font-bold">Needs you <span className="text-amber-900">· {openRows} item{openRows === 1 ? "" : "s"}</span></h2></div>
              {openRows === 0 ? <p className="px-5 py-4 text-sm text-emerald-900" data-testid="no-tasks">Nothing is left for you to price or choose.</p> : (
                <ol>
                  {ws.tasks.map((t, i) => <OpenRow key={t.id} n={t.n} id={t.id} label={t.label} meta={t.meta} why={t.why} status={taskStatusWord(t)} action={t.action} active={i === 0} onAct={() => openTask(t)} canEdit={canEdit} />)}
                  {evidenceRows.map((c, k) => <EvidenceOpenRow key={c.id} n={ws.tasks.length + k + 1} line={c} canEdit={canEdit} onRecord={recordEvidence} />)}
                </ol>
              )}
            </section>
            <RepItems items={ws.repItems} />
            <CompleteGroup lines={doneLines} charges={p.budget.charges} onEdit={openLine} canEdit={canEdit} onRecordEvidence={recordEvidence} />
            <p className="text-[13px] text-slate-700">Room measurements, quantities, delivery, installation and the M75 price belong to the Rep.</p>
          </div>
          <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:max-w-sm lg:self-start lg:overflow-y-auto"><SummaryPanel s={s} /><HowItWorks s={s} step={step} verified={bundle.view.costs.verified} required={bundle.view.costs.required} /></div>
        </div>
      )}

      {p.reviewNeeded && ws.next.kind === "sign_off" && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm" data-testid="final-review"><h3 className="font-bold">Final review</h3><p className="mt-1 text-slate-800">The commercial summary above is what you are signing off. Marking it reviewed is not a sign-off.</p><Button className="mt-2 min-h-11" onClick={p.onMarkReviewed}>Mark reviewed</Button></section>
      )}
      <VerifyBlock quoteId={p.quoteId} bundle={bundle} onDone={async (msg) => { setNote(msg); await load(); p.reload(); }} />
    </div>
  );
}

function PackageEditor({ line, confirmed, bundle, canEdit, onConfirm, costForm, onManual }: {
  line: BudgetQuote["lines"][number]; confirmed: boolean; bundle: WorkspaceBundle; canEdit: boolean; onConfirm: (yes: boolean) => Promise<SaveResult>;
  costForm: (sku: string, label: string, q: number) => React.ReactNode; onManual: () => void;
}) {
  const [local, setLocal] = useState(confirmed);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
    const comps = (line.components ?? []).filter((c) => c.sku);
  const rows = comps.map((c) => ({ c, r: bundle.view.rows.find((x) => x.sku === c.sku) }));
  const costed = rows.filter((x) => x.r && x.r.costState !== "missing").length;
  async function saveConfirm(yes: boolean) { setBusy(true); setErr(null); try { const r = await onConfirm(yes); if (!r.ok) { setErr(r.errors?.[0] ?? "Could not save."); setLocal(confirmed); } } finally { setBusy(false); } }
  const act = comps.find((c) => c.sku === active);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="package-editor">
      <PackageConfirm itemKey={line.itemKey} confirmed={local} canEdit={canEdit} busy={busy} onConfirm={(yes) => { setLocal(yes); void saveConfirm(yes); }} />
      {err && <Alert tone="warning"><span data-testid="package-error">{err}</span></Alert>}
      <p className="text-sm text-slate-800">Cannot price it this way? <button type="button" className="font-semibold text-blue-800 underline" onClick={onManual}>Quote a manual price for the whole {line.label.toLowerCase()}</button>. It needs a reason and written evidence and is labelled provisional.</p>
      {local && (
        <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="component-table"><h3 className="mb-3 text-[15px] font-bold">B. Cost each component <span className="font-normal text-slate-600">· {costed} of {comps.length} costed · the {line.label.toLowerCase()} is priced only when all are</span></h3>
          <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-sm"><thead><tr className="text-left text-xs text-slate-700"><th className="py-1.5 pr-2">COMPONENT</th><th className="px-2">SKU</th><th className="px-2 text-right">QTY PER / TOTAL</th><th className="px-2">COST</th></tr></thead>
            <tbody>{rows.map(({ c, r }) => <tr key={c.id} className={`border-t border-slate-100 ${active === c.sku ? "bg-sky-50" : ""}`}><td className="py-2 pr-2">{c.description}</td><td className="px-2">{c.sku}</td><td className="px-2 text-right tabular-nums">{c.qtyPerUnit ?? "—"} / {c.quantity ?? "—"}</td><td className="px-2">{canEdit || r ? <button type="button" className="font-semibold text-blue-800 underline" onClick={() => setActive(c.sku)} aria-label={`${r && r.costState !== "missing" ? "Edit" : "Enter"} cost for ${c.description}`}>{r && r.costState !== "missing" ? `${r.currency ?? ""} ${r.nativeUnitCostE7 != null ? r.nativeUnitCostE7 / 1e7 : ""}` : "Enter cost"}</button> : "—"}</td></tr>)}</tbody></table></div>
        </section>
      )}
      {local && act?.sku && <section className="rounded-xl border-2 border-blue-700 p-3" data-testid="component-editor"><h3 className="mb-2 px-2 text-[15px] font-bold">Component: {act.description} ({act.sku})</h3>{costForm(act.sku, act.description, act.quantity ?? line.quantity ?? 0)}</section>}
    </div>
  );
}

function DoorEditor({ itemKey, label, qty, chosenSaved, canEdit, saveMapping, costForm, onSaved }: {
  itemKey: string; label: string; qty: number; chosenSaved: string | undefined; canEdit: boolean; saveMapping: (itemKey: string, sku: string | null, opts?: { rereadWorkspace?: boolean }) => Promise<SaveResult>;
  costForm: (sku: string, label: string, q: number, before?: () => Promise<SaveResult>, saveLabel?: string) => React.ReactNode; onSaved: () => void;
}) {
  const [chosen, setChosen] = useState<string | undefined>(chosenSaved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
    const changed = chosen !== chosenSaved;
  async function saveProduct() {
    if (!chosen) return;
    setBusy(true); setErr(null);
    try { const r = await saveMapping(itemKey, chosen); if (!r.ok) setErr(r.errors?.[0] ?? "Could not save the product."); else onSaved(); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="door-editor">
      <ProductChoice itemKey={itemKey} label={label} chosen={chosen} canEdit={canEdit} busy={busy} onChoose={(s) => setChosen(s ?? undefined)}>
        <div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="secondary" className="min-h-11" disabled={!canEdit || !chosen || !changed || busy} loading={busy} onClick={saveProduct}>Save the product choice only</Button>
          <span className="text-sm text-slate-700" role="status">{!chosen ? "Choose a product." : changed ? "Saving the product alone clears the product-choice part of the task and leaves the price part open." : "Product saved."}</span></div>
        {err && <p className="mt-2 text-sm text-amber-900" data-testid="product-error">{err}</p>}
      </ProductChoice>
      {chosen ? (
        <div data-testid="door-pricing"><h3 className="mb-2 text-[15px] font-bold">Step 2. Price it: supplier cost for {chosen}</h3>{costForm(chosen, label, qty, changed ? () => saveMapping(itemKey, chosen, { rereadWorkspace: false }) : undefined, changed ? "Save product and price" : "Save cost")}</div>
      ) : <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-800" data-testid="door-pricing-wait">Choose the product first. Its supplier cost is entered here next.</p>}
    </div>
  );
}

/** Independent verification of supplier costs and attestation of forward-cover rates (a Manager; never the person who entered them: the server enforces it). */
function VerifyBlock({ quoteId, bundle, onDone }: { quoteId: string; bundle: WorkspaceBundle; onDone: (msg: string) => Promise<void> }) {
  const v = bundle.view;
  const [picked, setPicked] = useState<string[]>([]);
  const [evidence, setEvidence] = useState("");
  const [rates, setRates] = useState<string[]>([]);
  const [rateEvidence, setRateEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const verifiable = new Set(bundle.verification.verifiableSkus);
  const attestable = new Set(bundle.rateAttestation.attestableCurrencies);
  if (v.rows.length === 0 || !(bundle.verification.canReview || bundle.rateAttestation.canReview)) return null; // only a reviewer sees the verification block; everyone else reads the counts in the summary
  async function verify() {
    setBusy(true); setErrors([]);
    try {
      const r = await verifyEstimatorCostsAction(quoteId, picked.map((sku) => ({ sku, costHash: v.rows.find((x) => x.sku === sku)?.costHash ?? "" })), evidence);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not verify."]); return; }
      const n = r.data!.verified; setPicked([]); setEvidence(""); await onDone(`Recorded: ${n} supplier cost${n === 1 ? "" : "s"} independently verified. No price changed.`);
    } catch { setErrors(["That did not complete. Nothing was recorded."]); } finally { setBusy(false); }
  }
  async function attest() {
    setBusy(true); setErrors([]);
    try {
      const r = await attestEstimatorRatesAction(quoteId, rates.map((currency) => ({ currency, rateHash: v.currencies.find((c) => c.currency === currency)?.forwardCover?.rateHash ?? "" })), rateEvidence);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not attest."]); return; }
      const n = r.data!.attested; setRates([]); setRateEvidence(""); await onDone(`Recorded: ${n} forward-cover rate${n === 1 ? "" : "s"} independently attested.`);
    } catch { setErrors(["That did not complete. Nothing was recorded."]); } finally { setBusy(false); }
  }
  return (
    <section id="ws-verify" aria-labelledby="ws-verify-h" className="rounded-xl border border-slate-200 bg-white p-5" data-testid="verify-block">
      <h2 id="ws-verify-h" className="text-lg font-bold">Independent verification <span className="font-normal text-slate-700">· {v.costs.verified} of {v.costs.required} supplier costs verified</span></h2>
      <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[32rem] text-sm"><thead><tr className="text-left text-xs text-slate-700"><th className="py-1 pr-2">SKU</th><th className="px-2">COST</th><th className="px-2">STATE</th><th className="px-2">ENTERED BY</th><th className="px-2">VERIFY</th></tr></thead>
        <tbody>{v.rows.map((r) => <tr key={r.sku} data-testid="pricing-row" className="border-t border-slate-100"><td className="py-1.5 pr-2">{r.sku}</td><td className="px-2 tabular-nums">{r.nativeUnitCostE7 == null ? "—" : `${r.currency} ${costText(r.nativeUnitCostE7)}`}</td><td className="px-2">{r.costStateText}</td><td className="px-2 text-slate-700">{r.enteredBy ?? "—"}</td>
          <td className="px-2">{verifiable.has(r.sku) ? <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5" aria-label={`Verify ${r.sku} cost`} checked={picked.includes(r.sku)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.sku] : p.filter((x) => x !== r.sku)))} />Verify</label> : <span className="text-slate-700">{r.costState === "verified" ? "Verified" : r.costState === "missing" ? "—" : "Not by you"}</span>}</td></tr>)}</tbody></table></div>
      {bundle.verification.canReview && verifiable.size > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-3"><div className="min-w-[16rem] flex-1"><Input label="Evidence checked (for example the supplier quote reference)" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></div><Button className="min-h-11" data-testid="verify-save" loading={busy} disabled={busy || picked.length === 0 || evidence.trim().length < 3} onClick={verify}>Verify {picked.length || ""} selected cost{picked.length === 1 ? "" : "s"}</Button></div>
      )}
      {bundle.rateAttestation.canReview && attestable.size > 0 && (
        <div className="mt-4 border-t border-slate-200 pt-3"><p className="text-sm font-semibold">Forward-cover rates to attest</p>
          {[...attestable].map((c) => <label key={c} className="mr-4 inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" aria-label={`Attest ${c} forward-cover rate`} checked={rates.includes(c)} onChange={(e) => setRates((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))} />{c}</label>)}
          <div className="mt-1 flex flex-wrap items-end gap-3"><div className="min-w-[16rem] flex-1"><Input label="Contract checked" value={rateEvidence} onChange={(e) => setRateEvidence(e.target.value)} /></div><Button className="min-h-11" data-testid="attest-save" loading={busy} disabled={busy || rates.length === 0 || rateEvidence.trim().length < 3} onClick={attest}>Attest selected</Button></div></div>
      )}
      {errors.length > 0 && <Alert tone="warning"><ul className="list-disc pl-5" data-testid="pricing-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
    </section>
  );
}
