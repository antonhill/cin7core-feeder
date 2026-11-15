"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import { changedOwners, copyUnit, cost7, emptySubmission, formatCost7, fromMicro, mergePricing, micro, providerTimestampOf, samePricingValue, LEGACY_RULE_VERSION, type PricingConflict, type PricingSubmission, type SkuRow } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { applyEstimatorPricingAction, disableEstimatorPricingAction, attestEstimatorRatesAction, getEstimatorPricingAction, recordManualPriceEvidenceAction, verifyEstimatorCostsAction } from "../pricing-actions";
import { fmtCents } from "../fields";

// NQ-008B Phase 2: the ESTIMATOR PRICING WORKSPACE. INTERNAL: it shows supplier costs, rates, freight, markup and margin, so the page mounts it only for an Estimator or
// Manager who may see costs, and the server re-checks every action. It renders what the server computed and does no pricing arithmetic of its own; "Save" records one
// immutable revision (who, when, why) and the existing Rep reconfirmation workflow runs when the customer-facing total moved. A SKU with no supplier cost is shown as NOT
// priced, never as R0. The panel never disappears: it says when it is loading, and shows the reason with a retry when the server refuses.

const rand = (cents: number | null | undefined) => (cents == null ? "Not priced" : fmtCents(cents));
const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(2)}%`);
const signed = (c: number) => (c === 0 ? fmtCents(0) : `${c > 0 ? "+" : "-"}${fmtCents(Math.abs(c))}`);
const dec = (m: number | null | undefined) => (m == null ? "" : String(fromMicro(m)));
/** A typed supplier cost: the exact E7 value, nothing (empty: leave the cost as it is), or a plain-language reason it cannot be accepted. Never rounds or truncates. */
type CostParse = { kind: "empty" } | { kind: "ok"; value: number } | { kind: "bad"; message: string };
function parseCost(text: string): CostParse {
  const t = text.trim();
  if (t === "") return { kind: "empty" };
  try { return { kind: "ok", value: cost7(t) }; } catch (e) {
    if (/^\d+\.\d{8,}$/.test(t)) return { kind: "bad", message: "This value has not been saved. At most 7 decimal places are allowed (Cin7 supplies up to 7). Nothing was rounded: shorten or correct the value. The previous value is kept." };
    if (e instanceof Error && /too large/.test(e.message)) return { kind: "bad", message: "This value has not been saved. That cost is too large. The previous value is kept." };
    return { kind: "bad", message: "This value has not been saved. Enter the cost as a plain number such as 6.5454755 (digits and one decimal point, no commas or units). The previous value is kept." };
  }
}
const toMicro = (s: string): number | null => { try { return s.trim() === "" ? null : micro(s.trim()); } catch { return null; } };
const toCents = (s: string): number | null => { const n = Number(s.replace(/\s/g, "").replace(",", ".")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };

type Draft = PricingSubmission;
const blankSku = (): Draft["skus"][string] => ({ supplierId: null, supplierName: "", currency: "ZAR", nativeUnitCostE7: 0, source: "", freight: { factorMicro: 1_000_000, source: "" } });

/**
 * `editable` is the PAGE's own verdict on whether this viewer may edit Stage 2 (the Estimator, on a quotation that is not final). The panel is rendered OUTSIDE the Stage 2 disabled fieldset so
 * that a reviewer who may only VERIFY (a Manager) can operate the verification / attestation blocks, so every editing control here is gated explicitly by `edit` (= server canEdit AND `editable`)
 * and no longer relies on an ancestor fieldset. Defaults to true so any other caller behaves exactly as before.
 */
export function EstimatorPricingPanel({ quoteId, reload, unsaved, editable = true, refreshKey }: { quoteId: string; reload?: () => void; unsaved?: boolean; editable?: boolean; /** Changes whenever the saved quotation changed elsewhere on the page (a mapping confirmed and saved, a recalculation): the workspace re-reads so its SKU rows and counts never go stale. */ refreshKey?: string }) {
  const [b, setB] = useState<WorkspaceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [clears, setClears] = useState<Record<string, number>>({});
  const [evidence, setEvidence] = useState("");
  const [pickedRates, setPickedRates] = useState<string[]>([]);
  const [rateEvidence, setRateEvidence] = useState("");
  const [notes, setNotes] = useState<Record<string, { note: string; reference: string }>>({});
  // Supplier-cost fields holding a value that was NOT accepted (by SKU -> why). Saving is blocked while any exists. Cleared whenever the draft is replaced (load / reload / save / verify / attest),
  // and `epoch` remounts the rows then, so a field never shows text or a message that no longer matches the draft.
  const [costProblems, setCostProblems] = useState<Record<string, string>>({});
  const [epoch, setEpoch] = useState(0);
  const flagCost = useCallback((sku: string, message: string | null) => setCostProblems((p) => {
    if (message === null) { if (!(sku in p)) return p; const n = { ...p }; delete n[sku]; return n; }
    return p[sku] === message ? p : { ...p, [sku]: message };
  }), []);

  // Only the LATEST read may replace what is shown: an earlier, slower read can never overwrite a newer one (the verification counts and cost status must follow the last action at once).
  const readSeq = useRef(0);
  // THE DRAFT AND ITS BASE. `base` is the stored pricing the user's edits are made AGAINST (per unit: a SKU field, a rate, the markup ...). "Unsaved" is the DIFF between draft and base (never a flag set by a
  // blur), so a no-op blur is not an edit and reverting a value un-marks it. A re-read after anything other than this panel's own successful save REBASES: units the user did not touch take the new stored
  // value, units they edited keep their typed value; a unit both changed differently is a CONFLICT (derived below from base / stored / draft), shown until the user resolves it.
  const [base, setBase] = useState<Draft | null>(null);
  const baseOff = useRef(false); // supplier pricing was OFF when the base was read (the server then treats the base as empty)
  const bRef = useRef<WorkspaceBundle | null>(null);
  const baseRef = useRef<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [switchedOff, setSwitchedOff] = useState(false); // someone else switched supplier pricing off while this draft was open
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const blankDraft = (): Draft => ({ ruleVersionId: LEGACY_RULE_VERSION.id, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null });
  /** Resolves true when the read succeeded (or was superseded by a newer one); NEVER rejects: a failed read leaves the draft exactly as it was and is reported by `readError` / `error`. */
  const load = useCallback((mode: "replace" | "rebase" = "replace"): Promise<boolean> => {
    const seq = ++readSeq.current;
    const fail = (msg: string): boolean => { if (bRef.current) setReadError(msg); else setError(msg); return false; };
    return getEstimatorPricingAction(quoteId).then((r): boolean => {
      if (seq !== readSeq.current) return true;
      if (!(r.ok && r.data)) return fail(r.error ?? "Supplier pricing could not be loaded.");
      setError(null); setReadError(null);
      const fresh = r.data;
      const storedNow: Draft = fresh.current ?? blankDraft();
      const d0 = draftRef.current, b0 = baseRef.current;
      if (mode === "rebase" && d0 && b0 && fresh.current == null && !baseOff.current) {
        // Pricing was switched OFF elsewhere. Nothing the user typed is lost: the whole draft is kept as THEIR values (the base becomes "off", so all of it counts as unsaved) and Save switches pricing back on with it.
        const nb = blankDraft(); nb.ruleVersionId = d0.ruleVersionId;
        baseOff.current = true; baseRef.current = nb; setBase(nb); setSwitchedOff(true);
        bRef.current = fresh; setB(fresh);
        return true;
      }
      if (mode === "rebase" && d0 && b0) {
        const m = mergePricing(b0, fresh.current ?? emptySubmission(d0.ruleVersionId), d0);
        const nextBase = structuredClone(storedNow); for (const c of m.conflicts) copyUnit(nextBase, b0, c.key); // a conflicting unit keeps its OLD base until the user resolves it
        baseRef.current = nextBase; setBase(nextBase);
        draftRef.current = m.merged; setDraft(m.merged);
        setCostProblems((p) => { const n = { ...p }; for (const k of Object.keys(n)) if (!samePricingValue(b0.skus[k], nextBase.skus[k])) delete n[k]; return n; });
        if (fresh.current != null) baseOff.current = false;
        bRef.current = fresh; setB(fresh);
        return true;
      }
      baseOff.current = fresh.current == null;
      setCostProblems({}); setConfirmReload(false); setSwitchedOff(false); setEpoch((e) => e + 1);
      bRef.current = fresh; setB(fresh);
      const d = structuredClone(storedNow), bs = structuredClone(storedNow);
      baseRef.current = bs; setBase(bs); draftRef.current = d; setDraft(d);
      return true;
    }, () => fail("Supplier pricing could not be read (the connection or the server failed). Nothing you typed was lost."));
  }, [quoteId]);
  useEffect(() => { void load("replace"); }, [load]);
  // The saved quotation changed elsewhere (e.g. a product mapping was confirmed and saved): re-read the workspace so the SKU rows follow it. The first value is the one already loaded above.
  const firstKey = useRef(refreshKey);
  useEffect(() => { if (refreshKey === firstKey.current) return; firstKey.current = refreshKey; void load("rebase"); }, [refreshKey, load]);

  // Derived, never stored: what differs from the base (the unsaved changes), and what both the user and someone else changed differently (the conflicts). Both can only be computed once loaded.
  const unsavedOwners = draft && base ? changedOwners(base, draft) : [];
  const conflicts: PricingConflict[] = draft && base && b ? mergePricing(base, b.current ?? emptySubmission(draft.ruleVersionId), draft, null).conflicts : [];
  const unsavedCount = new Set([...unsavedOwners, ...Object.keys(costProblems).map((k) => `sku:${k}`)]).size;
  useEffect(() => { // leaving the page with unsaved supplier pricing: the browser's own confirmation
    if (unsavedCount === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [unsavedCount]);

  if (error && !b) return (<Panel><PanelTitle>Supplier pricing</PanelTitle><Alert tone="warning"><span data-testid="pricing-error">{error}</span></Alert><Button variant="secondary" size="sm" onClick={() => void load("replace")}>Try again</Button></Panel>);
  if (!b || !draft || !base) return (<Panel><PanelTitle>Supplier pricing</PanelTitle><p className="text-sm text-slate-800" data-testid="pricing-loading">Loading supplier pricing…</p></Panel>);

  const v = b.view;
  const edit = b.canEdit && editable;
  const editInputs = edit && !busy; // while an action is in flight nothing can be typed that the action's re-read could then replace
  const set = (f: (d: Draft) => void) => { const n = structuredClone(draftRef.current ?? draft!); f(n); draftRef.current = n; setDraft(n); }; // the ref is assigned synchronously: a rebase can never read a draft missing the last keystroke
  const rowsToShow = v.rows;
  // Exchange-rate rows appear as soon as a SKU is in a foreign currency (not only after a save).
  const foreign = [...new Set([...Object.values(draft.skus).map((s) => s?.currency ?? "").filter((c) => /^[A-Z]{3}$/.test(c) && c !== "ZAR"), ...v.currencies.map((c) => c.currency)])].sort();
  const rateOf = (c: string) => v.rates.find((x) => x.currency === c);
  const verifiable = new Set(b.verification.verifiableSkus);
  const isUnsaved = (key: string) => unsavedOwners.includes(key);
  const unsavedMsg = (n: number) => `Save or discard your ${n} unsaved change${n === 1 ? "" : "s"} first.`;

  /** Runs one action so that `busy` ALWAYS clears and a rejected action or read is reported, never left spinning. The draft is never touched here. */
  async function guarded(fn: () => Promise<void>) {
    setBusy(true); setErrors([]); setNote(null);
    try { await fn(); } catch { setErrors(["That did not complete (the connection or the server failed). Nothing you typed was lost; check the quotation and try again."]); } finally { setBusy(false); }
  }
  /** After a SUCCESSFUL own action: re-read (rebasing, so unsaved typed values survive), then let the page reload. A failed re-read is shown with a retry; the page still reloads. */
  async function afterAction(mode: "replace" | "rebase") { await load(mode); reload?.(); }

  async function save() {
    if (!draft || Object.keys(costProblems).length > 0) return; // belt and braces: the button is disabled too
    await guarded(async () => {
      const r = await applyEstimatorPricingAction(quoteId, draft, reason, baseOff.current ? null : base);
      if (!r.ok) {
        setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not save."]);
        if (r.conflicts?.length) await load("rebase"); // somebody else's change: show it next to the typed values, change nothing the user typed
        return;
      }
      const c = r.data?.confirmation;
      setNote(c?.returnedToRep ? "Saved as revision " + r.data!.seq + ". The customer total changed, so the Rep's confirmation was withdrawn and the quotation is back with the Rep to reconfirm." : `Saved as revision ${r.data!.seq}. The customer total did not change; the Estimator sign-off (if any) was withdrawn because the content changed.`);
      setReason(""); await afterAction("replace"); // a save persisted the draft (merged onto the current stored pricing): the stored values are what is shown now
    });
  }
  async function verify() {
    await guarded(async () => {
      const r = await verifyEstimatorCostsAction(quoteId, picked.map((sku) => ({ sku, costHash: v.rows.find((r) => r.sku === sku)?.costHash ?? "" })), evidence);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not verify."]); return; }
      setNote(`Recorded as revision ${r.data!.seq}: ${r.data!.verified} supplier cost${r.data!.verified === 1 ? "" : "s"} independently verified. No price changed; the Estimator sign-off (if any) was withdrawn.`);
      setPicked([]); setEvidence(""); await afterAction("rebase");
    });
  }
  async function attest() {
    await guarded(async () => {
      const r = await attestEstimatorRatesAction(quoteId, pickedRates.map((currency) => ({ currency, rateHash: v.currencies.find((c) => c.currency === currency)?.forwardCover?.rateHash ?? "" })), rateEvidence);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not attest."]); return; }
      setNote(`Recorded as revision ${r.data!.seq}: ${r.data!.attested} forward-cover rate${r.data!.attested === 1 ? "" : "s"} independently attested. No price changed; the Estimator sign-off (if any) was withdrawn.`);
      setPickedRates([]); setRateEvidence(""); await afterAction("rebase");
    });
  }
  async function saveEvidence() {
    const items = Object.entries(notes).filter(([, n]) => n.note.trim().length > 0).map(([itemKey, n]) => ({ itemKey, note: n.note, ...(n.reference.trim() ? { reference: n.reference } : {}) }));
    await guarded(async () => {
      const r = await recordManualPriceEvidenceAction(quoteId, items);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not record the evidence."]); return; }
      setNote(`Recorded as revision ${r.data!.seq}: pricing evidence for ${r.data!.recorded} item${r.data!.recorded === 1 ? "" : "s"}. No price changed; the Estimator sign-off (if any) was withdrawn.`);
      setNotes({}); await afterAction("rebase");
    });
  }
  async function off() {
    if (unsavedCount > 0) { setErrors([unsavedMsg(unsavedCount)]); return; } // switching off replaces the draft: never while typed values would be lost
    await guarded(async () => {
      const r = await disableEstimatorPricingAction(quoteId, reason, baseOff.current ? null : base);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not switch off."]); return; }
      setNote("Supplier pricing switched off: this quotation is priced from the POC workbook again."); setReason(""); await afterAction("replace");
    });
  }
  /** Throws the typed values away (the user asked): the draft and its base become the stored pricing again. */
  function discard() {
    const st = structuredClone(b!.current ?? blankDraft());
    baseRef.current = structuredClone(st); setBase(structuredClone(st)); draftRef.current = st; setDraft(st);
    setCostProblems({}); setConfirmReload(false); setSwitchedOff(false); setPicked([]); setEpoch((e) => e + 1); setErrors([]);
  }
  /** Resolves ONE conflict: keep my value (it becomes the base, so the save is a deliberate overwrite of what is stored) or use the stored value (replacing mine). */
  function resolve(c: PricingConflict, choice: "mine" | "stored") {
    const st: Draft = b!.current ?? emptySubmission(draft!.ruleVersionId);
    const nb = structuredClone(base!); copyUnit(nb, st, c.key); baseRef.current = nb; setBase(nb);
    if (choice === "stored") { const nd = structuredClone(draftRef.current!); copyUnit(nd, st, c.key); draftRef.current = nd; setDraft(nd); setEpoch((e) => e + 1); }
  }
  function saveFromBanner() {
    if (reason.trim().length < 3) { setErrors(["Say why the pricing is being changed (at least 3 characters) in the reason box below, then save."]); document.getElementById("pricing-reason")?.focus(); return; }
    void save();
  }

  const addSku = (sku: string) => { const s = sku.trim(); if (s) set((d) => { d.skus[s] = d.skus[s] ?? blankSku(); }); };

  return (
    <Panel className="space-y-4"><div className="space-y-4" data-testid="estimator-pricing-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle>Supplier pricing (Estimator)</PanelTitle>
        <Status tone={v.enabled ? (v.finality.final ? "success" : "warning") : "neutral"}>{v.enabled ? (v.finality.final ? `On · revision ${v.revision}` : `On · indicative only · revision ${v.revision}`) : "Off: priced from the POC workbook"}</Status>
      </div>
      {readError && <Alert tone="warning"><div className="flex flex-wrap items-center gap-2"><span data-testid="pricing-read-error">{readError}</span><Button variant="secondary" size="sm" onClick={() => void load("rebase")} data-testid="pricing-read-retry">Try again</Button></div></Alert>}
      {switchedOff && !v.enabled && <Alert tone="warning"><span data-testid="switched-off-elsewhere">Supplier pricing was switched off by someone else while you were editing. Your values are kept as a draft: Save will switch supplier pricing back on with your values, or Discard changes to leave it off.</span></Alert>}
      {unsavedCount > 0 && edit && (
        <div className="rounded-md border-2 border-amber-600 bg-amber-50 p-3" role="status" data-testid="unsaved-banner">
          <div className="flex flex-wrap items-center gap-2">
            <b data-testid="unsaved-count">{unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"}</b>
            <span className="text-sm text-slate-900">These values are only on this screen. They are not in the quotation until you save, and they are kept when you verify, attest or record evidence.</span>
            <Button size="sm" onClick={saveFromBanner} disabled={busy || unsaved || Object.keys(costProblems).length > 0} data-testid="unsaved-save">Save changes</Button>
            <Button size="sm" variant="secondary" onClick={discard} disabled={busy} data-testid="unsaved-discard">Discard changes</Button>
          </div>
        </div>
      )}
      {conflicts.length > 0 && (
        <Alert tone="warning"><div data-testid="changed-elsewhere">
          <p>The saved value of {conflicts.map((c) => c.label).join(", ")} changed elsewhere while you were editing {conflicts.length === 1 ? "it" : "them"}{conflicts[0].by ? ` (last change by ${conflicts[0].by}${conflicts[0].at ? `, ${formatSast(conflicts[0].at)}` : ""})` : ""}. Your typed {conflicts.length === 1 ? "value is" : "values are"} kept: review {conflicts.length === 1 ? "it" : "them"} before saving. A save is refused until each is resolved.</p>
          <ul className="mt-1 space-y-1">{conflicts.map((c) => <li key={c.key} className="flex flex-wrap items-center gap-2" data-testid="conflict-item" data-conflict={c.key}><span>{c.label}</span><Button size="sm" variant="secondary" onClick={() => resolve(c, "mine")} data-testid="conflict-keep">Keep my value</Button><Button size="sm" variant="secondary" onClick={() => resolve(c, "stored")} data-testid="conflict-use-stored">Use the stored value</Button></li>)}</ul>
          {!confirmReload ? <Button size="sm" variant="secondary" className="mt-2" onClick={() => setConfirmReload(true)} data-testid="reload-stored">Reload stored values</Button>
            : <div className="mt-2 space-x-2" data-testid="reload-confirm"><span>This replaces your {unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"} with the stored values.</span><Button size="sm" onClick={discard} data-testid="reload-confirm-yes">Replace with stored values</Button><Button size="sm" variant="secondary" onClick={() => setConfirmReload(false)}>Keep editing</Button></div>}
        </div></Alert>
      )}
      {unsaved && <Alert tone="warning">This workspace reflects the SAVED quotation. Save or discard your unsaved edits first.</Alert>}
      {!v.available && <Alert tone="info">Supplier pricing applies to project quotations only.</Alert>}
      {!v.enabled && v.available && <Alert tone="info">Supplier pricing is off, so this quotation uses its existing POC prices and nothing changes. Enter the supplier costs below and save to switch it on: the quotation is then priced from supplier cost × exchange rate × freight, plus the project markup.</Alert>}
      {b.state === "MANAGER_APPROVED_FINAL" && <Alert tone="info">Approved: the pricing is frozen with the baseline and cannot be changed.</Alert>}

      <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="pricing-summary">
        <div><dt className="text-xs text-slate-700">Rep-confirmed indicative total</dt><dd className="tabular-nums font-semibold" data-testid="sum-original">{v.indicative.originalTotalCents == null ? "No handoff yet" : fmtCents(v.indicative.originalTotalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Current total</dt><dd className="tabular-nums font-semibold" data-testid="sum-current">{v.indicative.currentTotalCents == null ? "Not priced yet" : fmtCents(v.indicative.currentTotalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Difference</dt><dd className="tabular-nums font-semibold" data-testid="sum-delta">{v.indicative.deltaCents == null ? "n/a" : signed(v.indicative.deltaCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Project markup</dt><dd className="tabular-nums font-semibold" data-testid="sum-markup-rule">{v.markup.bps == null ? "Rule version default" : `${v.markup.bps / 100}% (changed)`}</dd></div>
        <div><dt className="text-xs text-slate-700">Gross margin (costed lines)</dt><dd className="tabular-nums font-semibold" data-testid="sum-margin">{pct(v.totals.margin?.marginPct)}</dd></div>
        <div><dt className="text-xs text-slate-700">Markup on cost (costed lines)</dt><dd className="tabular-nums font-semibold" data-testid="sum-markup">{pct(v.totals.margin?.markupPct)}</dd></div>
        <div><dt className="text-xs text-slate-700">Supplier costs independently verified</dt><dd className="tabular-nums font-semibold" data-testid="sum-verified">{v.costs.verified} of {v.costs.required}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-slate-700">Price completeness</dt><dd data-testid="sum-complete">{v.totals.priceComplete ? "Every line has a price" : "Some lines are NOT priced: there is no project total yet"}</dd></div>
      </dl>
      <p className="text-xs text-slate-700">Margin is a share of the selling price; markup is a share of the cost. They are different numbers. Lines the Estimator prices by design (M75, penning, manual prices) carry no cost and are outside both.</p>

      {v.attention.length > 0 && (
        <Alert tone="warning"><div data-testid="pricing-attention"><b>Needs attention before this can be final.</b><ul className="mt-1 list-disc pl-5">{v.attention.slice(0, 12).map((t) => <li key={t}>{t}</li>)}</ul>{v.attention.length > 12 && <p>…and {v.attention.length - 12} more.</p>}<p className="mt-1">Unverified supplier costs support an indicative price only: they allow the Rep&apos;s handoff but block Estimator sign-off and Manager approval. The incomplete-costing exception does not cover them.</p></div></Alert>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm" data-testid="pricing-table">
          <thead><tr className="text-xs text-slate-700">{["SKU / used by", "Qty", "Supplier", "Cur", "Supplier cost", "Source", "Cost verification", "Rate used", "Freight ×", "Landed / unit", "Unit price", "Line total", "Margin / markup"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rowsToShow.map((r) => <Row key={`${r.sku}:${clears[r.sku] ?? 0}:${epoch}:${JSON.stringify(base.skus[r.sku] ?? null)}:${JSON.stringify(base.skuPriceOverrides[r.sku] ?? null)}`} costError={costProblems[r.sku] ?? null} onCostError={flagCost} r={r} edit={editInputs} input={draft.skus[r.sku]} baseInput={base.skus[r.sku]} override={draft.skuPriceOverrides[r.sku]} baseOverride={base.skuPriceOverrides[r.sku]} set={set}
              canPick={verifiable.has(r.sku) && b.state !== "MANAGER_APPROVED_FINAL"} picked={picked.includes(r.sku)} onPick={(on) => setPicked((p) => (on ? [...new Set([...p, r.sku])] : p.filter((x) => x !== r.sku)))}
              onClear={() => { flagCost(r.sku, null); set((d) => { delete d.skus[r.sku]; }); setClears((c) => ({ ...c, [r.sku]: (c[r.sku] ?? 0) + 1 })); setPicked((p) => p.filter((x) => x !== r.sku)); }} />)}
          </tbody>
        </table>
      </div>
      {editInputs && <AddSku onAdd={addSku} />}

      {foreign.length > 0 && (
        <div data-testid="pricing-fx">
          <h4 className="text-sm font-semibold text-slate-900">Exchange rates (rand per 1 unit) and forward cover</h4>
          <p className="text-xs text-slate-700">A spot rate older than {v.rates[0]?.maxAgeHours ?? 24} hours is expired: the lines using it are not priced, and sign-off and approval are blocked until a current rate is saved. Nothing is repriced until you save. A forward-cover rate needs its contract reference and validity dates and is used only inside them.</p>
          <ul className="mt-1 space-y-2">
            {foreign.map((cur) => {
              const c = v.currencies.find((x) => x.currency === cur); const rt = rateOf(cur);
              const spot = draft.fxQuotes[cur]; const fc = draft.forwardCover[cur];
              return (
                <li key={`${cur}:${epoch}:${JSON.stringify(base.fxQuotes[cur] ?? null)}:${JSON.stringify(base.forwardCover[cur] ?? null)}`} className={`rounded-md border p-2 ${isUnsaved(`fx:${cur}`) || isUnsaved(`fwd:${cur}`) ? "border-2 border-amber-600 bg-amber-50" : "border-slate-200"}`} data-testid={`fx-${cur}`} data-unsaved={isUnsaved(`fx:${cur}`) || isUnsaved(`fwd:${cur}`) ? "true" : undefined}>
                  <div className="flex flex-wrap items-end gap-2">
                    <b className="w-10">{cur}</b>
                    {(isUnsaved(`fx:${cur}`) || isUnsaved(`fwd:${cur}`)) && <span className="rounded border border-amber-700 bg-amber-100 px-1 text-xs font-semibold text-amber-900" data-testid={`unsaved-fx-${cur}`}>Unsaved</span>}
                    <Input label={`${cur} spot rate`} disabled={!editInputs} defaultValue={dec(spot?.rateMicro)} onBlur={(e) => { const m = toMicro(e.target.value); if (m === null) return; set((d) => { if (d.fxQuotes[cur]?.rateMicro === m) return; d.fxQuotes[cur] = { rateMicro: m, source: d.fxQuotes[cur]?.source ?? "", asOf: new Date().toISOString() }; }); }} />
                    <Input label={`${cur} rate source`} disabled={!editInputs} defaultValue={spot?.source ?? ""} onBlur={(e) => set((d) => { if (d.fxQuotes[cur]) d.fxQuotes[cur]!.source = e.target.value; })} />
                    <Input label={`${cur} forward-cover rate`} disabled={!editInputs} defaultValue={dec(fc?.rateMicro)} placeholder="none" onBlur={(e) => { const m = toMicro(e.target.value); set((d) => { if (e.target.value.trim() === "") delete d.forwardCover[cur]; else if (m !== null) d.forwardCover[cur] = { rateMicro: m, coverDays: d.forwardCover[cur]?.coverDays ?? 90, reason: d.forwardCover[cur]?.reason ?? "", reference: d.forwardCover[cur]?.reference, validFrom: d.forwardCover[cur]?.validFrom, validUntil: d.forwardCover[cur]?.validUntil }; }); }} />
                    {fc && <>
                      <Input label={`${cur} cover days`} disabled={!editInputs} className="w-20" defaultValue={String(fc.coverDays)} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.coverDays = Math.round(Number(e.target.value)) || 0; })} />
                      <Input label={`${cur} contract reference`} disabled={!editInputs} defaultValue={fc.reference ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.reference = e.target.value; })} />
                      <Input label={`${cur} forward-cover valid from`} placeholder="YYYY-MM-DD" disabled={!editInputs} className="w-32" defaultValue={fc.validFrom ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.validFrom = e.target.value.trim() || undefined; })} />
                      <Input label={`${cur} forward-cover valid until`} placeholder="YYYY-MM-DD" disabled={!editInputs} className="w-32" defaultValue={fc.validUntil ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.validUntil = e.target.value.trim() || undefined; })} />
                      <Input label={`${cur} forward-cover reason`} disabled={!editInputs} defaultValue={fc.reason} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.reason = e.target.value; })} />
                    </>}
                  </div>
                  {c?.spot && (() => { const pt = providerTimestampOf(c.spot.source); return (
                    <p className="mt-1 text-xs text-slate-800" data-testid={`fx-times-${cur}`}>
                      <span data-testid={`fx-provider-ts-${cur}`}><b>Provider timestamp:</b> {pt ? formatSast(pt) : "not stated in the rate source"}</span>{" · "}
                      <span data-testid={`fx-recorded-ts-${cur}`}><b>Recorded:</b> {formatSast(c.spot.asOf)}</span>
                    </p>
                  ); })()}
                  <p className="mt-1 text-xs text-slate-700" data-testid={`fx-note-${cur}`}>
                    {c?.spot ? `Spot recorded ${formatSast(c.spot.asOf)}${rt?.spotAgeHours != null ? ` (${rt.spotAgeHours} h ago)` : ""}.` : "No spot rate recorded yet: lines in this currency are not priced."}
                    {rt?.spotExpired ? " EXPIRED: record a current rate." : ""}
                    {c?.forwardCover ? ` Forward cover in force: ${c.forwardCover.coverDays} days${c.forwardCover.reference ? `, contract ${c.forwardCover.reference}` : ""}${c.forwardCover.validUntil ? `, valid until ${c.forwardCover.validUntil}` : ""}; set by ${c.forwardCover.by}, ${formatSast(c.forwardCover.at)}.` : ""}
                    {rt?.forwardExpired ? " The forward-cover rate has EXPIRED." : ""}
                  </p>
                  {c?.forwardCover && (
                    <p className="mt-1 text-xs text-slate-800" data-testid={`rate-state-${cur}`} data-rate-state={c.forwardCover.state}>
                      <Status tone={c.forwardCover.state === "attested" ? "success" : "warning"}>{c.forwardCover.state === "attested" ? "Attested" : c.forwardCover.state === "attestation_outdated" ? "Changed since attested" : c.forwardCover.state === "self_attested" ? "Not independent" : c.forwardCover.state === "undocumented" ? "Needs reference / dates" : "Not attested"}</Status>{" "}
                      {c.forwardCover.state === "attested" && c.forwardCover.review ? `Independently attested by ${c.forwardCover.review.by}, ${formatSast(c.forwardCover.review.at)}: ${c.forwardCover.review.evidence}` : `Not final: ${c.forwardCover.stateText}.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2" data-testid="pricing-project">
        <div key={`m:${epoch}:${JSON.stringify(base.projectMarkup)}`} className={`rounded-md border p-2 ${isUnsaved("markup") ? "border-2 border-amber-600 bg-amber-50" : "border-slate-200"}`} data-unsaved={isUnsaved("markup") ? "true" : undefined}>
          <h4 className="text-sm font-semibold text-slate-900">Project markup on landed cost{isUnsaved("markup") && <span className="ml-2 rounded border border-amber-700 bg-amber-100 px-1 text-xs font-semibold text-amber-900" data-testid="unsaved-markup">Unsaved</span>}</h4>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <Input label="Project markup percent" disabled={!editInputs} className="w-24" defaultValue={draft.projectMarkup ? String(draft.projectMarkup.markupBps / 100) : ""} placeholder="rule default" onBlur={(e) => set((d) => { const n = Number(e.target.value); if (e.target.value.trim() === "") d.projectMarkup = null; else d.projectMarkup = { markupBps: Math.round(n * 100), reason: d.projectMarkup?.reason ?? "" }; })} />
            <Input label="Project markup reason" disabled={!editInputs} defaultValue={draft.projectMarkup?.reason ?? ""} onBlur={(e) => set((d) => { if (d.projectMarkup) d.projectMarkup.reason = e.target.value; })} />
          </div>
          <p className="mt-1 text-xs text-slate-700">Changes every line&apos;s price (it is pricing). Leave blank to use the rule version&apos;s markup.</p>
        </div>
        <div key={`t:${epoch}:${JSON.stringify(base.targetAdjustment)}`} className={`rounded-md border p-2 ${isUnsaved("target") ? "border-2 border-amber-600 bg-amber-50" : "border-slate-200"}`} data-unsaved={isUnsaved("target") ? "true" : undefined}>
          <h4 className="text-sm font-semibold text-slate-900">Target project price (internal only){isUnsaved("target") && <span className="ml-2 rounded border border-amber-700 bg-amber-100 px-1 text-xs font-semibold text-amber-900" data-testid="unsaved-target">Unsaved</span>}</h4>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <Input label="Target project price" disabled={!editInputs} className="w-36" defaultValue={draft.targetAdjustment ? String(draft.targetAdjustment.targetTotalCents / 100) : ""} onBlur={(e) => set((d) => { const c = toCents(e.target.value); if (e.target.value.trim() === "") d.targetAdjustment = null; else d.targetAdjustment = { targetTotalCents: c ?? 0, reason: d.targetAdjustment?.reason ?? "" }; })} />
            <Input label="Target price reason" disabled={!editInputs} defaultValue={draft.targetAdjustment?.reason ?? ""} onBlur={(e) => set((d) => { if (d.targetAdjustment) d.targetAdjustment.reason = e.target.value; })} />
          </div>
          {v.adjustment ? (
            <p className="mt-1 text-sm" data-testid="adjustment-view">Would adjust the quotation by <b>{signed(v.adjustment.wouldAdjustByCents)}</b> (from {fmtCents(v.adjustment.currentTotalCents)} to {fmtCents(v.adjustment.targetTotalCents)}); margin at the target {pct(v.adjustment.atTarget?.marginPct)}, markup {pct(v.adjustment.atTarget?.markupPct)}. <b>Not applied to the customer quotation</b>: how it would appear to the customer is undecided.</p>
          ) : <p className="mt-1 text-xs text-slate-700">Never applied to the customer quotation: how a project-level adjustment appears to the customer is not yet decided by NewQuip.</p>}
        </div>
      </div>

      {v.enabled && v.manualEvidence.length > 0 && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="evidence-block">
          <h4 className="text-sm font-semibold text-slate-900">Pricing evidence for manual items</h4>
          <p className="text-xs text-slate-700">These items are priced by the Estimator and have no SKU behind them (for example the M75 system, LED lighting, penning). Record what each price is based on: a note is required before final approval, and it stops applying if the price changes. Recording evidence changes no price.</p>
          <ul className="space-y-2">
            {v.manualEvidence.map((m) => (
              <li key={m.itemKey} className="rounded-md border border-slate-200 p-2" data-testid="evidence-item" data-item={m.itemKey} data-evidence-state={m.state}>
                <div className="flex flex-wrap items-baseline gap-2"><b>{m.label}</b><Status tone={m.state === "recorded" ? "success" : "warning"}>{m.state === "recorded" ? "Evidence recorded" : m.state === "outdated" ? "Price changed since" : "No evidence"}</Status></div>
                {m.note && <p className="mt-1 text-xs text-slate-800" data-testid="evidence-text">{m.note}{m.reference ? ` (ref ${m.reference})` : ""} — {m.by}, {m.at ? formatSast(m.at) : ""}</p>}
                {m.state === "outdated" && <p className="mt-1 text-xs text-slate-900">{m.stateText}.</p>}
                {edit && b.state !== "MANAGER_APPROVED_FINAL" && (
                  <div className="mt-1 flex flex-wrap items-end gap-2">
                    <Input label={`${m.label} evidence note`} className="w-full sm:w-[24rem]" value={notes[m.itemKey]?.note ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [m.itemKey]: { note: e.target.value, reference: n[m.itemKey]?.reference ?? "" } }))} />
                    <Input label={`${m.label} evidence reference (optional)`} className="w-48" value={notes[m.itemKey]?.reference ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [m.itemKey]: { note: n[m.itemKey]?.note ?? "", reference: e.target.value } }))} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {edit && b.state !== "MANAGER_APPROVED_FINAL" && <Button size="sm" onClick={saveEvidence} disabled={busy || unsaved || !Object.values(notes).some((n) => n.note.trim().length >= 10)} data-testid="evidence-save">Record pricing evidence</Button>}
        </div>
      )}

      {b.rateAttestation.canReview && b.state !== "MANAGER_APPROVED_FINAL" && v.currencies.some((c) => c.forwardCover) && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="attest-block">
          <h4 className="text-sm font-semibold text-slate-900">Independent forward-cover rate attestation</h4>
          <p className="text-xs text-slate-700">You may attest a forward-cover rate you did not enter ({b.rateAttestation.reviewerRoles.join(" or ")}; provisional). Check its contract reference, validity dates and the contract itself, then tick it. Attesting changes no price. Any later change to the rate, contract or dates makes the attestation stop applying.</p>
          <ul className="flex flex-wrap gap-3">{b.rateAttestation.attestableCurrencies.map((cur) => <li key={cur}><label className="flex items-center gap-1"><input type="checkbox" checked={pickedRates.includes(cur)} onChange={(e) => setPickedRates((p) => (e.target.checked ? [...new Set([...p, cur])] : p.filter((x) => x !== cur)))} aria-label={`Attest ${cur} forward-cover rate`} />Attest the {cur} rate</label></li>)}</ul>
          {b.rateAttestation.attestableCurrencies.length === 0 && <p className="text-xs text-slate-800" data-testid="attest-none">There is no forward-cover rate you may attest now (rates you entered yourself need another reviewer).</p>}
          <Input label="Evidence checked (for example the forward-exchange contract number)" value={rateEvidence} onChange={(e) => setRateEvidence(e.target.value)} className="w-full sm:w-[28rem]" />
          <Button size="sm" onClick={attest} disabled={busy || pickedRates.length === 0 || rateEvidence.trim().length < 3} data-testid="attest-save">Attest {pickedRates.length} selected rate{pickedRates.length === 1 ? "" : "s"}</Button>
        </div>
      )}

      {b.verification.canReview && b.state !== "MANAGER_APPROVED_FINAL" && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="verify-block">
          <h4 className="text-sm font-semibold text-slate-900">Independent cost verification</h4>
          <p className="text-xs text-slate-700">You may verify a supplier cost you did not enter ({b.verification.reviewerRoles.join(" or ")}; provisional). Tick the costs you have checked against the evidence. Verifying changes no price and does not touch the customer total. Any later change to a cost makes its verification stop applying.</p>
          {unsavedCount > 0 && <p className="text-xs text-slate-900" data-testid="verify-unsaved-note">Verification applies to the SAVED costs shown in the table. Your {unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"} {unsavedCount === 1 ? "is" : "are"} kept and {unsavedCount === 1 ? "is" : "are"} not verified.</p>}
          <Input label="Evidence checked (for example the supplier quote reference)" value={evidence} onChange={(e) => setEvidence(e.target.value)} className="w-full sm:w-[28rem]" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={verify} disabled={busy || picked.length === 0 || evidence.trim().length < 3} data-testid="verify-save">Verify {picked.length} selected cost{picked.length === 1 ? "" : "s"}</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicked([...verifiable])} disabled={busy || verifiable.size === 0} data-testid="verify-all">Select all I may verify ({verifiable.size})</Button>
          </div>
        </div>
      )}

      {/* The outcome of an action is shown to WHOEVER ran it: a verify-only viewer (a Manager) has no editing block, but must still see that a verification succeeded or why it was refused. */}
      {(errors.length > 0 || note) && (
        <div className="space-y-2">
          {errors.length > 0 && <Alert tone="danger"><ul data-testid="pricing-errors" className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
          {note && <Alert tone="info"><span data-testid="pricing-note">{note}</span></Alert>}
        </div>
      )}

      {edit && (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <Input id="pricing-reason" label="Reason for this pricing revision" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full sm:w-[28rem]" />
          {Object.keys(costProblems).length > 0 && (
            <Alert tone="warning"><span data-testid="pricing-invalid-cost-block">Saving is blocked: {Object.keys(costProblems).length === 1 ? "1 supplier cost value has" : `${Object.keys(costProblems).length} supplier cost values have`} NOT been saved because {Object.keys(costProblems).length === 1 ? "it is" : "they are"} not valid ({Object.keys(costProblems).sort().join(", ")}). Correct {Object.keys(costProblems).length === 1 ? "it" : "them"} (or use &quot;Clear supplier cost&quot; to remove the cost), then save.</span></Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || unsaved || reason.trim().length < 3 || Object.keys(costProblems).length > 0 || conflicts.length > 0} loading={busy} data-testid="pricing-save">{v.enabled ? "Save pricing revision" : "Switch on supplier pricing"}</Button>
            {v.enabled && <Button size="sm" variant="secondary" onClick={off} disabled={busy || unsaved || unsavedCount > 0 || reason.trim().length < 3} data-testid="pricing-off">Switch off (back to POC prices)</Button>}
            {v.enabled && unsavedCount > 0 && <span className="self-center text-xs text-slate-900" data-testid="off-blocked">{unsavedMsg(unsavedCount)}</span>}
          </div>
          <p className="text-xs text-slate-700">Saving withdraws any Estimator sign-off. If the customer-facing total changes, the Rep&apos;s confirmation is withdrawn and the quotation returns to the Rep to reconfirm; the amount the Rep confirmed at handoff is kept as it was.</p>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-slate-900" data-testid="pricing-history-summary">Revision history ({b.revisions.length})</summary>
        <ol className="mt-2 space-y-2" data-testid="pricing-history">
          {b.revisions.length === 0 && <li className="text-sm text-slate-700">No revisions yet.</li>}
          {[...b.revisions].reverse().map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 p-2 text-sm">
              <div><b>Revision {r.seq}</b> · {r.kind.toLowerCase()} · rules {r.ruleVersion} · {r.changedBy}, {formatSast(r.at)}</div>
              <div>Why: {r.reason}</div>
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-800">{r.changes.slice(0, 8).map((c) => <li key={c.path}>{c.path}: {JSON.stringify(c.previous)} → {JSON.stringify(c.new)}</li>)}{r.changes.length > 8 && <li>…and {r.changes.length - 8} more</li>}</ul>
            </li>
          ))}
        </ol>
      </details>
    </div></Panel>
  );
}

function AddSku({ onAdd }: { onAdd: (sku: string) => void }) {
  const [sku, setSku] = useState("");
  return (
    <div className="flex items-end gap-2">
      <Input label="SKU to add" value={sku} onChange={(e) => setSku(e.target.value)} className="w-56" />
      <Button size="sm" variant="secondary" onClick={() => { onAdd(sku); setSku(""); }} disabled={!sku.trim()}>Add</Button>
    </div>
  );
}

function Row({ r, edit, input, baseInput, override, baseOverride, set, canPick, picked, onPick, onClear, costError, onCostError }: { costError: string | null; onCostError: (sku: string, message: string | null) => void; r: SkuRow; edit: boolean; input: Draft["skus"][string] | undefined; baseInput: Draft["skus"][string] | undefined; baseOverride: Draft["skuPriceOverrides"][string] | undefined; override: Draft["skuPriceOverrides"][string] | undefined; set: (f: (d: Draft) => void) => void; canPick: boolean; picked: boolean; onPick: (on: boolean) => void; onClear: () => void }) {
  const tone = r.status === "priced" ? "success" : "danger";
  // A blur that changes nothing is not an edit: it must not create a blank entry (and so must not mark the row unsaved).
  const upd = (f: (s: Draft["skus"][string]) => void) => set((d) => { const had = d.skus[r.sku]; const s = had ?? blankSku(); f(s); if (!had && samePricingValue(s, blankSku())) return; d.skus[r.sku] = s; });
  // Unsaved = differs from the stored value the edit started from (per field), so reverting a value clears the mark.
  const diff = (f: keyof Draft["skus"][string]) => !samePricingValue(input?.[f], baseInput?.[f]);
  const un = (on: boolean, cls: string) => (on ? { className: `${cls} ring-2 ring-amber-600 bg-amber-50`, "data-unsaved": "true", helperText: "Unsaved" } : { className: cls });
  const rowUnsaved = !samePricingValue(input, baseInput) || !samePricingValue(override, baseOverride);
  return (
    <>
      <tr className={`border-t border-slate-200 align-top ${rowUnsaved ? "bg-amber-50" : ""}`} data-testid="pricing-row" data-sku={r.sku} data-status={r.status} data-unsaved={rowUnsaved ? "true" : undefined}>
        <td className="px-2 py-1"><b>{r.sku}</b>{rowUnsaved && <span className="ml-1 rounded border border-amber-700 bg-amber-100 px-1 text-xs font-semibold text-amber-900" data-testid="row-unsaved">Unsaved</span>}<div className="text-xs text-slate-700">{r.usedBy.join("; ")}</div><Status tone={tone}>{r.status === "priced" ? "Priced" : r.status === "no_input" ? "No supplier cost: NOT priced" : "NOT priced"}</Status></td>
        <td className="px-2 py-1 tabular-nums">{r.quantity}</td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier`} disabled={!edit} defaultValue={input?.supplierName ?? ""} {...un(diff("supplierName"), "w-32")} onBlur={(e) => upd((s) => { s.supplierName = e.target.value; })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} currency`} disabled={!edit} defaultValue={input?.currency ?? "ZAR"} {...un(diff("currency"), "w-16")} onBlur={(e) => upd((s) => { s.currency = e.target.value.trim().toUpperCase(); })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier cost`} disabled={!edit} defaultValue={input?.nativeUnitCostE7 == null ? "" : formatCost7(input.nativeUnitCostE7)} error={costError ?? undefined} {...un(diff("nativeUnitCostE7"), "w-24")} onBlur={(e) => { const c = parseCost(e.target.value); if (c.kind === "bad") { onCostError(r.sku, c.message); return; } if (c.kind === "empty" && costError) e.target.value = input?.nativeUnitCostE7 == null ? "" : formatCost7(input.nativeUnitCostE7); /* an emptied invalid field shows the kept value again */ onCostError(r.sku, null); if (c.kind === "ok") upd((s) => { s.nativeUnitCostE7 = c.value; }); }} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} cost source`} disabled={!edit} defaultValue={input?.source ?? ""} {...un(diff("source"), "w-32")} onBlur={(e) => upd((s) => { s.source = e.target.value; })} /></td>
        <td className="px-2 py-1 text-xs" data-testid="cost-state" data-cost-state={r.costState}>
          <Status tone={r.costState === "verified" ? "success" : r.costState === "missing" ? "danger" : "warning"}>{r.costState === "verified" ? "Verified" : r.costState === "missing" ? "No cost" : r.costState === "review_outdated" ? "Changed since verified" : r.costState === "self_reviewed" ? "Not independent" : "Unverified"}</Status>
          {r.review && <div>by {r.review.by}, {formatSast(r.review.at)}<br />{r.review.evidence}</div>}
          {r.enteredBy && <div className="text-slate-600">entered by {r.enteredBy}</div>}
          {r.priceBasis === "manual_price" && <div className="text-slate-900">Price is a MANUAL price; its supplier cost still has to be recorded and verified.</div>}
        </td>
        <td className="px-2 py-1 text-xs">{r.rate ? `${r.rate.kind === "forward_cover" ? `Forward cover (${r.rate.coverDays} d)` : r.rate.kind === "spot" ? "Spot" : "Rand"} ${fromMicro(r.rate.rateMicro)}` : "n/a"}</td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} freight factor`} disabled={!edit} defaultValue={dec(input?.freight?.factorMicro)} {...un(diff("freight"), "w-16")} onBlur={(e) => { if (e.target.value === dec(input?.freight?.factorMicro)) return; upd((s) => { s.freight = { factorMicro: toMicro(e.target.value) ?? 1_000_000, addOnCents: s.freight?.addOnCents, source: s.freight?.source || "Estimator" }; }); }} /></td>
        <td className="px-2 py-1 tabular-nums">{rand(r.unitLandedCostCents)}</td>
        <td className="px-2 py-1 tabular-nums">{rand(r.unitPriceCents)}{r.priceOrigin === "item_override" && <div className="text-xs text-slate-700">override</div>}</td>
        <td className="px-2 py-1 tabular-nums">{rand(r.lineRevenueCents)}</td>
        <td className="px-2 py-1 text-xs tabular-nums">{r.margin ? `${pct(r.margin.marginPct)} / ${pct(r.margin.markupPct)}` : "n/a"}</td>
      </tr>
      <tr className="text-xs" data-testid="pricing-row-extra">
        <td colSpan={13} className="px-2 pb-2">
          <div className="flex flex-wrap items-end gap-2">
            <Input label={`${r.sku} price override per unit (R)`} disabled={!edit} {...un(!samePricingValue(override, baseOverride), "w-28")} defaultValue={override ? String(override.unitPriceCents / 100) : ""} placeholder="none" onBlur={(e) => set((d) => { if (e.target.value.trim() === "") delete d.skuPriceOverrides[r.sku]; else d.skuPriceOverrides[r.sku] = { unitPriceCents: toCents(e.target.value) ?? 0, reason: d.skuPriceOverrides[r.sku]?.reason ?? "" }; })} />
            {override && <Input label={`${r.sku} override reason (required)`} disabled={!edit} {...un(!samePricingValue(override, baseOverride), "w-64")} defaultValue={override.reason} onBlur={(e) => set((d) => { if (d.skuPriceOverrides[r.sku]) d.skuPriceOverrides[r.sku]!.reason = e.target.value; })} />}
            {r.priceOverride && <span>Override set by {r.priceOverride.by}, {formatSast(r.priceOverride.at)}</span>}
            {edit && input && <Button size="sm" variant="secondary" onClick={onClear} data-testid="clear-cost">Clear supplier cost</Button>}
            {canPick && <label className="flex items-center gap-1"><input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Verify ${r.sku} cost`} />Verify this cost</label>}
            {r.issues.length > 0 && <span className="text-slate-900" data-testid="row-issues">{r.issues.join(" · ")}</span>}
            <span className="text-slate-700">Quantity changes are made in the quantity overrides, with their own reasons.</span>
          </div>
        </td>
      </tr>
    </>
  );
}
