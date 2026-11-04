"use client";

import { pageContainerClass } from "@/app/PageContainer";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useId } from "react";
import { ActionFeedback, useKeyedActions } from "@/components/ui/action-feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SOLUTION_BUILDER_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { CCM_FEEDER_CAPACITY_PIGS } from "@/newquip/grower/rules";
import { buildCustomerSummary } from "@/newquip/grower/customer-summary";
import { READINESS_LABEL, type ReadinessCategory, type ReadinessState } from "@/newquip/grower/readiness";
import { expectedSkuFor } from "@/newquip/grower/quote-bridge";
import { packageFor, manualSelectionSkusFor } from "@/newquip/grower/commercial";
import { ROOMS_HELP, VENTILATION_SCOPE_STATUS } from "@/newquip/grower/open-items";
import { QUOTE_TYPE_LABEL, QUOTE_TYPE_NEUTRAL, neutralPriceText, type QuoteType } from "@/newquip/grower/pricing-source";
import { DEMO_DEFAULTS_SOURCE, RECOMMENDED_CONFIG_FILLS, SAMPLE_MEASUREMENTS_FILLS, applyDemoDefaults, applyMeasurementsSample, applyRecommendedConfiguration, hasEntries, hasEquipmentEntries, hasMeasurementEntries } from "@/newquip/grower/demo-defaults";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { GrowerItemKey, OptionalItemKey, PenningPigSize } from "@/newquip/grower/types";
import {
  approveGrowerQuoteAction, createProjectFromGrowerQuoteAction, getGrowerQuoteAction, previewGrowerDraftAction, returnGrowerQuoteToEstimatorAction, returnGrowerQuoteToRepAction,
  saveGrowerDraftAction, sendGrowerQuoteToEstimatorAction, signOffGrowerQuoteAction, type QuoteView,
} from "../actions";
import { formatSast } from "@/lib/approvals/time";
import { isOptionalItemKey } from "@/newquip/grower/types";
import { blankExclusions, createRecalcLoop } from "@/newquip/grower/preview-draft";
import { buildMarginSheet, previewCostOverrides } from "@/newquip/quote/margin";
import { fmtCents, fmtZar, NumField, TextField } from "../fields";
import { ChargesSection, CollapsibleSection, ExclusionsSection, LineDecisionsTable } from "./RepConfigSections";
import { formatZar } from "@/lib/format-money";
import { MarginPanel } from "./MarginPanel";
import { BuildStamp } from "@/components/BuildStamp";
import { ScheduleChooser } from "./ScheduleChooser";
import { CostPanel } from "./CostPanel";
import { BaselineExceptionBlock, BaselineExceptionNote, BaselineExceptionsSummary, UnmappedTypedPriceNote } from "./BaselineExceptionBlock";
import { CustomerPanel } from "./CustomerPanel";
import { Stage1Review } from "./Stage1Review";
import { StepRail, StepPanel } from "@/components/ui/StepRail";
import { useShowAllSteps } from "@/components/ui/use-show-all-steps";
import { nextIncompleteStepId, parseStepParam } from "@/components/ui/step-rail-model";
import { ESTIMATOR_LINE_STATUSES, customerFactsSettled, deriveStage1Steps, fieldErrors, ownedWork, STEP_FIELD_KEYS, NO_CUSTOMER_FACTS, STAGE1_STEP_IDS, STAGE1_STEP_LABEL, type Stage1CustomerFacts, type Stage1StepId } from "@/newquip/quote/stage1-steps";
import { currentStepId, deriveWizard, isPermitted, resolveEntryStep, toRailSteps } from "@/newquip/quote/wizard-contract";
import { costAckKey, deriveStage2Steps, type Stage2Input } from "@/newquip/quote/stage2-steps";
import { commercialReadiness, confirmedAmountChange, deriveFinalReviewChecklist, deriveStage2Wizard, deriveStage3Wizard, estimatorWork, finalReviewBlockText, STAGE2_WIZARD_IDS, STAGE2_WIZARD_LABEL, type Stage2WizardId } from "@/newquip/quote/stage23-wizard";
import { Disclosure, EstimatorResult, FinalReviewChecklist, OwnerTag, RepSubmittedSummary } from "./Stage23Panels";
import { EstimatorReturnNotice, returnNoticeText } from "./ReturnNotice";
import { ConfirmationPanel } from "./ConfirmationPanel";
import { DeliveryPanel, type DeliveryGate } from "./DeliveryPanel";
import { ApprovalChecklist, AcceptanceStatusBanner, HandoverChecklist } from "./Stage36Guidance";
import { costingAcceptedIncompleteText, deriveApprovalChecklist } from "@/newquip/quote/stage3-approval";
import { deriveStage4Steps, STAGE4_STEP_IDS, type Stage4StepId } from "@/newquip/quote/stage4-steps";
import { deriveAcceptanceBanner } from "@/newquip/quote/stage5-banner";
import { deriveHandoverReadiness } from "@/newquip/quote/stage6-handover";
import { StageNav } from "./StageNav";
import { AcceptancePanel } from "./AcceptancePanel";
import { computeStages, currentStage, parseStage, type CommercialState, type StageId } from "@/newquip/quote/stages";
import { getQuoteDeliveryAction } from "../delivery-actions";
import { ScopePanel } from "./ScopePanel";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { getDocumentApprovalAction } from "@/app/approvals/actions";
import { DisabledReason } from "@/components/ApprovalDisabledReason";
import { resolveScheduleChoice, type ScheduleChoice } from "@/newquip/quote/billing-schedule";

// NewQuip Grower quote editor, in six stages: 1 Configuration → 2 Costing & Estimator Review → 3 Manager Approval → 4 Customer Quotation → 5 Customer Acceptance → 6 Project Handover.
// The stage is a PRESENTATION derived from the quotation's existing state and immutable records (see src/newquip/quote/stages.ts); every action is still authorised on the server.
// (Original note:) The browser holds only the
// editable DRAFT; every number shown comes from the server's evaluateDraft(), and approval re-evaluates on the server again.

const READY_TONE: Record<ReadinessState, BadgeTone> = { DRAFT: "neutral", BLOCKED: "danger", READY: "success" };
const CAT_LABEL: Record<ReadinessCategory, string> = {
  autoCalculated: "Auto-calculated", suggestedDefault: "Suggested / default", estimatorInputs: "Estimator inputs", overrides: "Overrides",
  warnings: "Warnings", missingMappings: "Missing product mappings", supplierQuoteRequired: "Supplier quote required", pricingExceptions: "Pricing exceptions",
};
const CAT_TONE: Record<ReadinessCategory, BadgeTone> = {
  autoCalculated: "success", suggestedDefault: "info", estimatorInputs: "neutral", overrides: "warning", warnings: "warning",
  missingMappings: "danger", supplierQuoteRequired: "danger", pricingExceptions: "warning",
};
const PIG_SIZE_LABEL: Record<PenningPigSize, string> = { SMALL: `Small — ${formatZar(1300)} / rm`, MEDIUM: `Medium — ${formatZar(1500)} / rm`, LARGE: `Large — ${formatZar(2200)} / rm` };
const OPTIONAL_LABELS: Record<OptionalItemKey, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows",
  pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};
const PRODUCT_CHANGE_REFUSED = "This change needs an Estimator to confirm the new product. Ask the Estimator to open this quotation (Stage 2, step 1) - they can confirm it for you - or undo the change.";
// The full message is shown ONCE (at the control); everywhere else only this short reference, so the screen never repeats it.
/** JSON with sorted keys, so two drafts that differ only in key order compare equal. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const PRODUCT_CHANGE_SHORT = "1 change needs an Estimator - see Equipment (step 3).";
const PRODUCT_CHANGE_NOTE = "Changing this needs an Estimator to confirm the product afterwards.";

/** The existing replace-confirmation pattern for the contextual samples: says what is replaced and that nothing is saved. */
function SampleConfirm({ what, onYes, onNo }: { what: string; onYes: () => void; onNo: () => void }) {
  return (
    <div role="alert" className="mt-3 flex max-w-4xl flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="sample-confirm">
      <span>This replaces {what} you have already entered in this draft. Nothing is saved until you press Save draft.</span>
      <Button size="sm" className="min-h-11" onClick={onYes}>Replace values</Button>
      <Button size="sm" variant="secondary" className="min-h-11" onClick={onNo}>Cancel</Button>
    </div>
  );
}

export default function QuoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<QuoteView | null>(null);
  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [ev, setEv] = useState<QuoteEvaluation | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty); // the editor already tracks unsaved edits; saving or reloading from the server clears it
  // The draft the displayed figures were last calculated for, and the draft a failed recalculation belongs to: no synchronous state juggling in the effect.
  const [previewedFor, setPreviewedFor] = useState<QuoteDraft | null>(null);
  const [failedFor, setFailedFor] = useState<{ draft: QuoteDraft; message: string } | null>(null);
  const recalculating = dirty && !!draft && previewedFor !== draft && failedFor?.draft !== draft;
  const previewFailure = dirty && failedFor && failedFor.draft === draft ? failedFor.message : null;
  const blankExclusionKeys = draft ? blankExclusions(draft) : [];
  const incompleteOverrides = draft ? Object.keys(previewCostOverrides(draft.estimator.costOverrides).errors).length > 0 : false;
  const [scheduleChoice, setScheduleChoice] = useState<ScheduleChoice | undefined>(undefined);
  const [gate, setGate] = useState<DeliveryGate>({ requires: false, accepted: false, status: null, hasDocument: false });
  const search = useSearchParams();
  const uid = useId();
  // The commercial status is read in a second request. Until it has been read once the stages that depend on it show "Loading" (never a guess from the empty defaults above).
  const [gateReady, setGateReady] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateTry, setGateTry] = useState(0);
  const [picked, setPicked] = useState<StageId | null>(() => parseStage(search.get("stage")));
  // Where the user landed. The viewed stage is `picked ?? landing ?? here`: once the quote has loaded the view stays where the user is, so recalculating readiness (Load Demo
  // Defaults, any edit that makes the quote READY) can never move it. Only an authoritative workflow change (state, revision, project link, delivery status) clears it.
  const [landing, setLanding] = useState<StageId | null>(null);
  const gateSig = useRef<string | null>(null);
  // The commercial status as the panels and the delivery read report it. A CHANGED signature (issued / sent / answered / verified) is a real workflow transition: the view follows
  // the quotation to its new current stage. The first read never moves it. Stable identity: the panels list `onGate` in their effect dependencies.
  const noteGateSig = useCallback((sig: string) => {
    if (gateSig.current !== null && gateSig.current !== sig) { setPicked(null); setLanding(null); }
    gateSig.current = sig;
  }, []);
  const applyGate = useCallback((g: DeliveryGate) => { noteGateSig(`${g.status}|${g.hasDocument}|${g.linkState}`); setGate(g); }, [noteGateSig]);
  // Stage 1 steps: navigation and guidance only (completion is derived from data, never from a visit). The customer facts are lifted from the CustomerPanel that already loads them.
  // The wizard (wizard-contract.ts) decides which Stage 1 step is open. `reqStep` is what the viewer asked for (the address bar's ?step= at load, then their own navigation); the ENTRY step is resolved ONCE,
  // after the customer facts have settled, and latched (`entry`) so nothing moves the viewer afterwards. A requested step that is not permitted (locked) is clamped.
  const [reqStep, setReqStep] = useState<Stage1StepId | null>(() => { const st = parseStage(search.get("stage")); const raw = search.get("step"); return st === 2 || st === 4 || raw == null ? null : STAGE1_STEP_IDS[parseStepParam(raw, STAGE1_STEP_IDS.length) - 1]; });
  const [entry, setEntry] = useState<Stage1StepId | null>(null);
  const [urlSync, setUrlSync] = useState<Stage1StepId | null>(null);
  // Safety net: if the customer details never report (a hung request), the wizard stops waiting after 10 s instead of showing its loading shell forever.
  const [factsGiveUp, setFactsGiveUp] = useState(false);
  useEffect(() => { const t = setTimeout(() => setFactsGiveUp(true), 10000); return () => clearTimeout(t); }, []);
  // Keyboard: when the wizard has opened (entry resolved) and nothing has focus yet (e.g. arriving from "New quote"), move focus to the step heading instead of leaving it on <body>.
  useEffect(() => { if (!entry) return; if (document.activeElement && document.activeElement !== document.body) return; document.querySelector<HTMLElement>("[data-step-panel]:not([hidden]) h2")?.focus(); }, [entry]);
  useEffect(() => { if (!urlSync) return; try { const u = new URL(window.location.href); u.searchParams.set("step", String(STAGE1_STEP_IDS.indexOf(urlSync) + 1)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ } }, [urlSync]);
  // A RETURNED quotation (Rep draft, revision > 1): read the existing approval history ONCE, lazily and without blocking anything, to show the latest return reason inline. Unavailable or slow = the
  // banner keeps its fixed text. (No new action; the same read the Approval history disclosure makes.)
  const [returnInfo, setReturnInfo] = useState<{ by: string; at: string; reason: string } | null>(null);
  // "none" = the history was read and holds no RETURN with a reason (the request was withdrawn / superseded instead, e.g. an Estimator price edit changed the total); "unavailable" = it could not be read.
  const [returnRead, setReturnRead] = useState<"pending" | "none" | "unavailable">("pending");
  const returnedLoaded = view?.quote.state === "REP_DRAFT" && (view?.quote.revision ?? 1) > 1;
  // Server QuoteView.returnInfo (D5), a return TO THE REP: shown directly and the lazy history read below is skipped. A return to the Estimator is not the Rep's banner.
  const serverReturn = view?.returnInfo && view.returnInfo.destination === "REP" ? view.returnInfo : null;
  const persistedReturn = serverReturn ? { by: serverReturn.byEmail ?? "the Estimator/Manager", at: serverReturn.at, reason: serverReturn.reason } : null;
  useEffect(() => {
    if (!returnedLoaded || persistedReturn) return;
    let live = true;
    void getDocumentApprovalAction("QUOTE", id).then((r) => {
      if (!live) return;
      if (!r.ok || !r.data?.available) { setReturnRead("unavailable"); return; }
      const ev1 = [...r.data.history].reverse().find((e) => (e.action === "RETURN" || e.to_status === "RETURNED") && !!e.reason?.trim());
      if (ev1) setReturnInfo({ by: ev1.actor_name ?? ev1.actor_email, at: ev1.created_at, reason: ev1.reason!.trim() }); else setReturnRead("none");
    }).catch(() => { if (live) setReturnRead("unavailable"); });
    return () => { live = false; };
  }, [id, returnedLoaded, persistedReturn]);
  // Stage 2 (the Estimator's wizard) SHARES the "Show all steps" preference (one setting for the builder, one storage key). `req2No` is what the viewer asked for: the address bar's ?step= at load (a 1-based
  // number among the steps THIS viewer has), then their own navigation. The entry step is resolved ONCE (`entry2`) and latched, as for Stage 1.
  const [req2No, setReq2No] = useState<number | null>(() => (parseStage(search.get("stage")) === 2 && search.get("step") != null ? parseStepParam(search.get("step"), 99) : null));
  const [entry2, setEntry2] = useState<Stage2WizardId | null>(null);
  // Stage 4 (Customer Quotation) has two steps, with the same shared preference.
  const [step4No, setStep4No] = useState<number>(() => (parseStage(search.get("stage")) === 4 ? parseStepParam(search.get("step"), STAGE4_STEP_IDS.length) : 1));
  // "Mark reviewed & continue" on Cost & margin: a CLIENT-LOCAL acknowledgement, never stored and never a sign-off. It holds a key built from the version it was given on; any change makes it stale.
  const [costAck, setCostAck] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null); // which acknowledgement may be announced; cleared after a few seconds and when the step changes
  useEffect(() => { if (!ackFor) return; const t = setTimeout(() => setAckFor(null), 6000); return () => clearTimeout(t); }, [ackFor]);
  const [showAllSteps, setShowAllSteps] = useShowAllSteps("nq-builder-show-all");
  // The sticky Stage 2 step bar must never hide the element a focus move scrolls to.
  useEffect(() => { const el = document.documentElement; const prev = el.style.scrollPaddingBottom; el.style.scrollPaddingBottom = "7rem"; return () => { el.style.scrollPaddingBottom = prev; }; }, []);
  const [customerFacts, setCustomerFacts] = useState<Stage1CustomerFacts>(NO_CUSTOMER_FACTS);
  const onCustomerFacts = (f: Stage1CustomerFacts) => setCustomerFacts((p) => (p.loaded === f.loaded && p.available === f.available && p.hasSnapshot === f.hasSnapshot && p.hasContact === f.hasContact && p.contactName === f.contactName && p.loadError === f.loadError ? p : f));
  const [error, setError] = useState<string | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [demoLoaded, setDemoLoaded] = useState<string[] | null>(null);
  // Contextual samples (UX-006i1): which sample is waiting for the viewer to confirm replacing values, and the last one loaded (announced once).
  const [confirmSample, setConfirmSample] = useState<"measurements" | "recommended" | null>(null);
  const [sampleNote, setSampleNote] = useState<string | null>(null);
  // Inline validation is shown only for a field the viewer has touched (blurred) or whose step they have left: a fresh blank form does not shout.
  const [effectInfo, setEffectInfo] = useState<QuoteView["confirmationEffect"] | null>(null); // what the last save did to the customer's confirmation (S1b), when the server reported it
  const [mapRefused, setMapRefused] = useState(false); // the last Save was refused because the Rep changed a product-affecting control
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (...keys: string[]) => setTouched((p) => (keys.every((k) => p.has(k)) ? p : new Set([...p, ...keys])));
  // UAT-025: every action reports beside its own control (never in a banner above a long page) and ignores a second click while it is in flight.
  const acts = useKeyedActions();
  const isWorking = acts.anyPending;
  const [returnReason, setReturnReason] = useState("");
  // ONE recalculation in flight at a time (server actions run serially and a round trip is slow): edits made meanwhile collapse into a single follow-up for the newest draft.
  const [loop] = useState(() => createRecalcLoop<QuoteDraft, Awaited<ReturnType<typeof previewGrowerDraftAction>>>((d) => previewGrowerDraftAction(d), {
    onResult: (d, r) => { if (r.ok && r.data) { setEv(r.data); setPreviewedFor(d); setFailedFor(null); } else setFailedFor({ draft: d, message: r.error ?? "The live recalculation failed." }); },
    onError: (d, e) => setFailedFor({ draft: d, message: e instanceof Error ? e.message : "The live recalculation failed." }),
  }));

  // A changed workflow state / revision / project link is a real transition: let the view follow the quotation to its new current stage. `workflow` = the result of a workflow
  // action (act()): a withdrawn Estimator sign-off (e.g. the Manager returning it to the Estimator, same state and revision) counts too. A draft or readiness change never does,
  // and neither does the user's own Save (workflow false).
  function followTransition(v: QuoteView, workflow: boolean) {
    if (!view) return;
    const signed = (x: QuoteView["quote"]) => !!x.estimator_signoff_hash && x.estimator_signoff_hash === x.draft_hash;
    if (v.quote.state !== view.quote.state || v.quote.revision !== view.quote.revision || v.quote.project_id !== view.quote.project_id || (workflow && signed(view.quote) && !signed(v.quote))) { setPicked(null); setLanding(null); }
  }
  function adopt(v: QuoteView, workflow = false) {
    followTransition(v, workflow);
    setEffectInfo(v.confirmationEffect ?? null);
    setView(v);
    setDraft(v.quote.draft);
    setEv(v.evaluation);
    setDirty(false);
    loop.cancel(); setPreviewedFor(null); setFailedFor(null); // the server's figures replace any preview still on its way
  }
  useEffect(() => {
    getGrowerQuoteAction(id).then((r) => (r.ok && r.data ? (adopt(r.data), setError(null)) : setError(r.error ?? "Unknown error")));
  }, [id]);

  // The commercial status (documents / sends / customer responses) feeds the stage navigation, wherever the user is looking.
  const finalNow = view?.quote.state === "MANAGER_APPROVED_FINAL";
  const gateKey = `${view?.quote.id ?? ""}:${view?.quote.updated_at ?? ""}:${view?.quote.project_id ?? ""}`;
  useEffect(() => {
    if (!finalNow) return;
    let live = true;
    void getQuoteDeliveryAction(id).then((r) => {
      if (!live) return;
      if (!r.ok) { setGateError(r.error ?? "The quotation's delivery status could not be loaded."); return; }
      setGateError(null);
      if (r.data?.available) applyGate({ requires: r.data.requiresAcceptance, accepted: r.data.accepted, status: r.data.status, hasDocument: r.data.latestDocumentId != null, linkState: r.data.links.state });
      else noteGateSig("unavailable");
      setGateReady(true); // read (an unavailable feature before migration 0115 is a legitimate, settled answer)
    }).catch(() => { if (live) setGateError("The quotation's delivery status could not be loaded."); });
    return () => { live = false; };
  }, [id, finalNow, gateKey, gateTry, applyGate, noteGateSig]);

  // Live recalculation (writes nothing): the same server engine as Save, on the unsaved draft, after a short pause in typing.
  useEffect(() => {
    if (!draft || !dirty) return;
    const t = setTimeout(() => loop.request(draft), 300);
    return () => clearTimeout(t);
  }, [draft, dirty, loop]);

  // A ?step= beyond this viewer's steps (a viewer without cost visibility has two) is shown as the entry step and dropped from the address bar once the viewer is known.
  const viewerCommercials = view?.viewer.canViewCommercials;
  useEffect(() => {
    if (viewerCommercials === undefined || req2No === null) return;
    const count = viewerCommercials ? STAGE2_WIZARD_IDS.length : 2;
    if (req2No >= 1 && req2No <= count) return;
    try { const u = new URL(window.location.href); if (u.searchParams.get("stage") === "2" && u.searchParams.has("step")) { u.search = new URLSearchParams([...u.searchParams].filter(([k]) => k !== "step")).toString(); window.history.replaceState(null, "", u.toString()); } } catch { /* the address bar is a convenience */ }
  }, [viewerCommercials, req2No]);

  if (!view || !draft || !ev) {
    return (
      <main className={pageContainerClass("data")}>
        <ModuleHeader variant="workspace" module={SOLUTION_BUILDER_MODULE}>Grower quote</ModuleHeader>
        {error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <div role="status" aria-live="polite" aria-busy="true" data-testid="quote-loading"><p className="mt-6 text-sm text-slate-600">Loading the quotation…</p><Skeleton className="mt-4 h-14 w-full max-w-4xl" /><Skeleton className="mt-4 h-96 w-full" /></div>}
      </main>
    );
  }

  const q = view.quote;
  const roles = new Set(view.viewer.roles);
  const final = q.state === "MANAGER_APPROVED_FINAL";
  const editable = !final && (roles.has("rep") || roles.has("estimator"));
  const budget = ev.budget;
  const rd = ev.readiness;
  // Why each important button is disabled, in words (presentation only; the server re-checks every action).
  const saveWhy = isWorking ? "Another action is in progress. Please wait."
    : !editable ? (final ? "The accepted quote is read-only." : "Only a Rep or Estimator can edit and save this quotation.")
    : blankExclusionKeys.length > 0 ? "Give every excluded item a reason or remove it before saving."
    : incompleteOverrides ? "Finish or remove the incomplete cost override before saving."
    : !dirty ? "Nothing to save: there are no unsaved changes." : undefined;
  const signoffWhy = isWorking ? "Another action is in progress. Please wait." : !roles.has("estimator") ? "Only an Estimator can sign off this quote." : rd.state !== "READY" ? "The quote must be READY (no outstanding readiness items) before it can be signed off." : undefined;
  // ONE margin story for a viewer with cost visibility, from data already held (the same sheet the Margin panel shows): when the project cost is incomplete the margin number is an INDICATIVE price-list-basis figure and says so.
  const marginInfo = (() => {
    if (!view.viewer.canViewCommercials || !budget) return null;
    try {
      const sheet = final ? q.accepted_baseline?.internalMargin : buildMarginSheet(budget, previewCostOverrides(draft.estimator.costOverrides).usable);
      if (!sheet) return null;
      // Lines the Estimator prices by design (M75, penning, a resolved manual price) have no supplier cost and are exempt from the costing gate: they keep the margin INDICATIVE but are not "missing cost".
      const byDesign = new Set(budget.lines.filter((b) => b.pricedBy === "estimator_input" || b.pricedBy === "penning_rate" || b.pricedBy === "estimator_resolution").map((b) => b.label));
      const gaps = sheet.project.missingCostLines;
      return { incomplete: sheet.project.incomplete, missing: gaps.filter((l) => !byDesign.has(l)).length, exempt: gaps.filter((l) => byDesign.has(l)) };
    } catch { return null; }
  })();
  const marginIncomplete = !!marginInfo?.incomplete;
  const marginLabel = marginIncomplete ? "Indicative margin (price-list basis)" : "Gross margin";
  // The SERVER's costing verdict (QuoteView.costing; cost-entitled callers only). Falls back to the margin sheet's count when the server did not send it.
  const costingSrv = view.costing ?? null;
  const costingIncomplete = costingSrv ? !costingSrv.complete : (marginInfo?.missing ?? 0) > 0;
  const costingReason = costingSrv?.reason ?? null;
  const marginNote = marginIncomplete ? (marginInfo!.missing > 0 ? `project margin not available: ${marginInfo!.missing} line${marginInfo!.missing === 1 ? " has" : "s have"} no cost` : marginInfo!.exempt.length > 0 ? `margin is indicative: ${marginInfo!.exempt.length} line${marginInfo!.exempt.length === 1 ? " is" : "s are"} Estimator-priced (no supplier cost by design)` : "margin is indicative (price-list basis)") : null;
  // "Manager: final approval" is described by whichever of the existing messages currently applies (each is already on the page, so nothing is duplicated). Role/process wording only.
  const approveSignoffMissing = q?.state === "ESTIMATOR_REVIEW" && !q.estimator_signoff_hash;
  const approveCostingOpen = q.state === "ESTIMATOR_REVIEW" && costingSrv != null && !costingSrv.complete;
  const approveNotReady = q.state === "ESTIMATOR_REVIEW" && (rd.state !== "READY" || approveCostingOpen);
  const approveSignoffStale = q?.state === "ESTIMATOR_REVIEW" && !!q.estimator_signoff_hash && q.estimator_signoff_hash !== q.draft_hash;
  const approveDescribedBy = [isWorking && `${uid}-approve-busy`, !roles.has("manager") && `${uid}-approve-role`, approveNotReady && `${uid}-approve-notready`, approveSignoffMissing && `${uid}-approve-signoff`, approveSignoffStale && `${uid}-approve-stale`, dirty && `${uid}-approve-dirty`].filter(Boolean).join(" ") || undefined;
  const bxRequired = !!view?.baselineException?.baselineExceptionRequired;
  const bxBlocking = view?.baselineException?.blocking ?? []; // D-19: unmapped products no exception can cover
  const returnWhy = isWorking ? "Another action is in progress. Please wait." : !returnReason.trim() ? "Enter the reason for returning it to enable this." : undefined;
  // The same rounding the server uses for the saved total (quote-store totalCents), so the Stage 3 checklist compares like with like; unsaved edits are covered by its own row.
  // UX-006 S1a: the amount the Rep confirms is the SERVER's indicative total (subtotalExTax, the same figure quote-store's indicativeTotalCents uses) even while Estimator-owned lines are still open.
  const totalCents = budget ? Math.round(budget.totals.subtotalExTax * 100) : null;
  // REP_CONFIGURATION_READY (readiness-concepts.ts, derived from the server's repReasons): everything only a Rep can supply is complete. Estimator-owned items never make the Rep wait.
  const repReady = rd.repReasons.length === 0;
  const awaitingLines = (budget?.lines ?? []).filter((b) => ESTIMATOR_LINE_STATUSES.has(b.status)).length;
  const awaitingPrices = (budget?.lines ?? []).filter((b) => b.status === "not_in_price_source" || b.status === "supplier_quote_required").length;
  const awaiting = { choices: awaitingLines - awaitingPrices, prices: awaitingPrices, lines: awaitingLines };
  const totalIndicative = awaitingLines > 0 || !!budget?.incomplete;

  // One-click demonstration quotation: replaces the inputs of THIS editable draft only (not saved, nothing created, approved or sent).
  function loadDemo() {
    const r = applyDemoDefaults(draft!);
    setDraft(r.draft); setDirty(true); setConfirmDemo(false); setDemoLoaded(r.replaced); setError(null);
  }
  // Contextual samples fill ONE step of this draft (unsaved) and never call a server action but the page's own live preview. The active step is untouched (nothing here changes `reqStep`).
  function runSample(kind: "measurements" | "recommended") {
    const r = kind === "measurements" ? applyMeasurementsSample(draft!) : applyRecommendedConfiguration(draft!);
    setDraft(r.draft); setDirty(true); setConfirmSample(null); setError(null);
    setSampleNote(kind === "measurements" ? (r.replaced ? "Sample measurements loaded into this draft." : "The measurements already matched the sample; nothing changed.") : (r.replaced ? "Recommended configuration loaded: selections, optional equipment, quantities and overrides were replaced and exclusions cleared; measurements, charges, product choices and prices were kept." : "The configuration already matched the recommendation; nothing changed."));
  }
  const askSample = (kind: "measurements" | "recommended") => ((kind === "measurements" ? hasMeasurementEntries(draft!) : hasEquipmentEntries(draft!)) ? setConfirmSample(kind) : runSample(kind));
  // The server already rewrote the customer name (and, from estimator review, returned the quotation to the Rep). Reload the quotation; unsaved local edits are kept.
  const onCustomerChanged = (name: string) => {
    void getGrowerQuoteAction(id).then((r) => {
      if (!r.ok || !r.data) return;
      if (dirty) { followTransition(r.data, false); setView(r.data); edit((d) => { d.customerName = name; }); } else adopt(r.data);
    });
  };
  const edit = (fn: (d: QuoteDraft) => void) => { setDraft((p) => { const n = structuredClone(p!); fn(n); return n; }); setDirty(true); };
  const num = (v: number | null) => v ?? 0;

  /**
   * Runs one quotation action (saving unsaved edits first) under `key`. `confirm` says, from a fresh read, whether the action took effect: after a lost
   * response the page checks that BEFORE suggesting a retry (and adopts the server's state if it did).
   */
  function act(fn: () => Promise<{ ok: boolean; error?: string; data?: QuoteView }>, done: string, key = "page", confirm?: (v: QuoteView) => boolean, pin?: StageId) {
    void acts.run(key, async () => {
      if (dirty && !final) {
        const s = await saveGrowerDraftAction(id, draft!);
        if (!s.ok) return { ok: false, error: s.error ?? "Could not save" } as { ok: boolean; error?: string; data?: QuoteView };
      }
      const r = await fn();
      if (r.ok && r.data) { adopt(r.data, true); if (pin) setPicked(pin); }
      return r;
    }, {
      pending: "Working… please wait",
      success: done,
      reconcile: async () => {
        const v = await getGrowerQuoteAction(id);
        if (!v.ok || !v.data || !confirm) return "unknown";
        if (confirm(v.data)) { adopt(v.data, true); if (pin) setPicked(pin); return "done"; }
        return "not_done";
      },
    });
  }
  function save() {
    const hadSignoff = !!view!.quote.estimator_signoff_hash; // only then did the save withdraw anything
    setSampleNote(null);
    void acts.run("save", async () => {
      const r = await saveGrowerDraftAction(id, draft!);
      if (!r.ok || !r.data) {
        // The server's rule stays (only an Estimator or Manager may change a product mapping). Say what it means for the Rep, at the control and here, instead of the raw line.
        if (/can map a product/i.test(r.error ?? "")) { setMapRefused(true); return { ok: false, error: PRODUCT_CHANGE_SHORT }; }
        return { ok: false, error: r.error ?? "Could not save" };
      }
      setError(null); setMapRefused(false);
      adopt(r.data);
      return r;
    }, { pending: "Saving the draft…", success: hadSignoff ? "Draft saved. The Estimator sign-off made on earlier content no longer applies." : "Draft saved." });
  }

  const cfg = draft.config;
  const lineByKey = new Map(ev.calc.lines.map((l) => [l.itemKey, l]));
  const summary = budget ? buildCustomerSummary(budget) : null;
  const stages = computeStages({
    state: q.state, revision: q.revision, ready: repReady, customerSelected: customerFacts.available && customerFacts.loaded ? customerFacts.hasSnapshot : !!draft.customerName.trim(), confirmed: q.customer_confirmed_cents != null,
    signedOff: !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash, commercial: final ? ((gate.status as CommercialState | null) ?? null) : "NOT_APPROVED",
    hasDocument: gate.hasDocument, linkState: gate.linkState, requiresAcceptance: q.requires_customer_acceptance === true, projectLinked: !!q.project_id, loading: final && !gateReady,
  });
  const loadingStages = final && !gateReady;
  // While the commercial status is unread, stages 4-5 (and 6 without a Project link) show a loading placeholder instead of their panels.
  const hold = (n: StageId) => loadingStages && (n === 4 || n === 5 || (n === 6 && !q.project_id));
  const staleCue = previewFailure ? "(out of date)" : recalculating ? "Recalculating…" : null;
  const handoffFacts = (
    <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
      {[
        ["Pre-approval amount confirmed", q.customer_confirmed_cents ? `${fmtCents(q.customer_confirmed_cents)} · ${q.customer_confirmed_by ?? ""}` : "—"],
        ["Sent to estimator by", q.handoff_by_email ?? "—"],
        ["Estimator sign-off", q.estimator_signoff_hash ? (q.estimator_signoff_hash === q.draft_hash ? `${q.estimator_signoff_by_email} · current` : "stale") : "—"],
        ["Manager approval", q.approved_by_email ? `${q.approved_by_email}` : "—"],
      ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-700">{k}</dt><dd className="mt-0.5 font-medium text-slate-900">{v}</dd></div>)}
    </dl>
  );
  // computeStages marks Stage 1 COMPLETE once the quote is READY, but for the REP the next action is still Stage 1 step 5 (Submit). So the LANDING stage is role-aware (presentation only; computeStages
  // is untouched): a Rep on a Rep draft lands on Stage 1; an Estimator-only viewer lands on Stage 2 when the Rep's draft is waiting on Estimator-owned mapping; everyone else as before.
  const workFacts = { lines: ev.calc.lines, budgetLines: budget?.lines ?? null, charges: budget?.charges ?? null, blankExclusionCount: blankExclusionKeys.length, blankPriceReasonCount: Object.values(draft.estimator.priceResolutions).filter((r) => r && !r.reason.trim()).length };
  const owned = ownedWork(workFacts);
  const stageNow = currentStage(stages);
  const here: StageId = q.state === "REP_DRAFT" && roles.has("rep") ? 1 : q.state === "REP_DRAFT" && roles.has("estimator") && !roles.has("rep") && owned.estimator.length > 0 ? 2 : stageNow;
  if (landing === null && !loadingStages) setLanding(here); // once, when the current stage is first known (React's render-phase initialisation)
  const stage: StageId = picked ?? landing ?? here;
  const goStage = (n: StageId) => { setPicked(n); try { const u = new URL(window.location.href); const at = n === 1 ? stepNo : n === 2 ? step2Cur : n === 4 ? step4No : 1; const sp = new URLSearchParams([...u.searchParams].filter(([k]) => k !== "step" && k !== "stage")); sp.set("stage", String(n)); if (at > 1) sp.set("step", String(at)); u.search = sp.toString(); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ } };

  // ── Stage 1: the Rep's wizard. The page only feeds data in; wizard-contract.ts decides statuses, locks, who owns what and where the wizard opens. ──
  // A Rep who changes the feeder variant drops the saved feeder mapping, which only an Estimator/Manager may change: the Save would be refused (server rule, held decision D1). Say so up front.
  const canMap = roles.has("estimator") || roles.has("manager");
  const savedCfg = q.draft.config;
  const productChangePending = !canMap && roles.has("rep") && q.state === "REP_DRAFT" && !!q.draft.estimator.confirmedMappings.feeder && draft.config.feederVariant !== savedCfg.feederVariant;
  const undoProductChange = () => {
    // Restore the saved values of the control (client-side only), clear the refusal, and recompute "unsaved" against the saved draft: if nothing else differs the draft is clean again.
    setMapRefused(false); acts.clear("save");
    const next = structuredClone(draft!);
    next.config.feederVariant = savedCfg.feederVariant;
    if (q.draft.estimator.confirmedMappings.feeder) next.estimator.confirmedMappings.feeder = q.draft.estimator.confirmedMappings.feeder;
    setDraft(next); setDirty(stable(next) !== stable(q.draft));
  };
  const stage1 = deriveStage1Steps({ customerName: draft.customerName, siteName: draft.siteName, penningPigSize: cfg.penningPigSize, calcIssues: ev.calc.issues, readinessReasons: rd.reasons, customer: customerFacts, roomValues: { lengthM: cfg.lengthM, widthM: cfg.widthM, rooms: cfg.rooms, totalPens: cfg.totalPens, pigsPerRoom: cfg.pigsPerRoom },
    work: workFacts, productChangePending });
  // The Rep's Stage 1 card and next-action line say what the REP does next (never "Complete" before the submission). Presentation only: computeStages and every gate are unchanged.
  const repWaiting = q.state === "REP_DRAFT" && roles.has("rep");
  const repItems = stage1.open.filter((o) => o.owner === "Rep");
  const estItems = stage1.open.filter((o) => o.owner === "Estimator");
  const stagesView = stages.map((x) => {
    if (!repWaiting || x.id !== 1 || x.status === "RETURNED" || x.status === "LOADING") return x;
    if (productChangePending) return { ...x, statusLabel: "Waiting on the Estimator", summary: "Waiting on the Estimator for 1 product choice. Ask the Estimator to confirm the new product (Stage 2, step 1), or undo the change in step 3.", next: null };
    if (repItems.length > 0) return { ...x, summary: `Still to do: ${repItems.slice(0, 3).map((o) => o.message).join("; ")}${repItems.length > 3 ? ` (+${repItems.length - 3} more - see Review, step 4)` : ""}.`, next: null };
    if (repReady) return { ...x, ...(estItems.length > 0 ? { statusLabel: "Ready to submit" } : {}), summary: `Everything you can do is complete.${estItems.length > 0 ? ` ${awaitingLines || estItems.length} item${(awaitingLines || estItems.length) === 1 ? "" : "s"} will be resolved by the Estimator after you submit.` : ""}`, next: "Rep: submit to the Estimator (Stage 1, step 5)." };
    return x;
  });
  // The up-front Estimator note stays until the Estimator-owned work is known to be done: hidden only once the quotation has been calculated and nothing is waiting on the Estimator.
  const estimatorWorkOpen = !(ev.calc.valid && budget && estItems.length === 0);
  // One-line status chips for the collapsible sections of step 3 (counts from the same facts as the step status).
  const qtyOpen = (budget?.lines ?? []).filter((b) => b.status === "no_quantity").length + ev.calc.lines.filter((l) => l.basis !== "not_selected" && l.overrideState === "manual_override" && !l.overrideReason).length;
  const chargeOpen = (budget?.charges ?? []).filter((c) => c.status === "required").length + (budget?.lines ?? []).filter((b) => b.status === "estimator_price_required").length;
  const estChoices = estItems.filter((o) => o.message.startsWith("Estimator product choice needed:")).length;
  const qtyChip = `${qtyOpen > 0 ? `${qtyOpen} to enter - needs attention` : "Complete"}${estChoices > 0 ? ` · Waiting on the Estimator: ${estChoices}` : ""}`;
  const chargeChip = chargeOpen > 0 ? `${chargeOpen} to enter - needs attention` : "Complete";
  const exclCount = Object.keys(cfg.exclusions ?? {}).length;
  const exclChip = blankExclusionKeys.length > 0 ? "a reason is needed - needs attention" : exclCount > 0 ? `${exclCount} excluded - complete` : "None excluded";
  const fe = fieldErrors({ siteName: draft.siteName, penningPigSize: cfg.penningPigSize, calcIssues: ev.calc.issues });
  const err = (k: string) => (touched.has(k) ? fe[k] : undefined);
  const wizard = deriveWizard({ state: q.state as "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL", revision: q.revision, stage1Status: stages[0].status, roles: { rep: roles.has("rep"), estimator: roles.has("estimator"), manager: roles.has("manager") }, canViewCommercials: view.viewer.canViewCommercials, stage1, customer: customerFacts, repReady, estimatorOpen: estItems.length, totalAvailable: totalCents != null && totalCents > 0 });
  // Resolve the entry step ONCE, after the customer facts have settled (read, failed or unavailable), and latch it: no later change of the facts can move the viewer (React's render-phase initialisation, as for `landing`).
  const factsSettled = customerFactsSettled(customerFacts) || factsGiveUp;
  if (stage === 1 && factsSettled && entry === null) setEntry(resolveEntryStep(wizard, reqStep));
  const stepId = currentStepId(wizard.steps, (reqStep ?? entry ?? wizard.entryStepId));
  const stepNo = STAGE1_STEP_IDS.indexOf(stepId) + 1;
  const stage1Edit = wizard.steps.find((x) => x.id === stepId)?.access === "edit" || (q.state === "REP_DRAFT" && roles.has("rep"));
  const stepAccess = (id: Stage1StepId) => wizard.steps.find((x) => x.id === id)!;
  const lockedFor = (id: Stage1StepId): string[] | undefined => (stepAccess(id).access === "locked" ? stepAccess(id).blockedBy : undefined);
  const writeStepParam = (id: Stage1StepId) => { try { const u = new URL(window.location.href); u.searchParams.set("step", String(STAGE1_STEP_IDS.indexOf(id) + 1)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ } };
  // A requested step that is not permitted (a locked step in ?step=, or one that locked after an edit upstream) is clamped to the permitted step; the address bar follows (see urlSync). The viewer
  // is never moved to a LATER step by this: the request is replaced by where they actually are.
  if (stage === 1 && entry !== null && reqStep !== null && reqStep !== stepId) { setReqStep(stepId); setUrlSync(stepId); }
  const goStepId = (id: Stage1StepId) => {
    if (!isPermitted(stepAccess(id))) return; // a locked step is not selectable (the rail also refuses it)
    setSampleNote(null);
    if (id !== stepId && (stepId === "site" || stepId === "equipment")) touch(...STEP_FIELD_KEYS[stepId]); // leaving a step is "trying to proceed": its problems now show at the field
    setReqStep(id); writeStepParam(id);
  };
  const goStep = (id: string) => goStepId(id as Stage1StepId);
  const railSteps1 = toRailSteps(wizard.steps);
  const nextOpen = nextIncompleteStepId(railSteps1, stepId, (x) => stepAccess(x.id as Stage1StepId).access === "edit");
  const nextStep1 = STAGE1_STEP_IDS[stepNo] ?? null; // the step after this one (null on the last)
  const nextStep1Locked = nextStep1 ? stepAccess(nextStep1) : null;
  const stepPanelCls = "col-span-full grid min-w-0 items-start gap-3 [&>*]:min-w-0";
  const gated1 = stage === 1 && !factsSettled; // the small loading shell shows meanwhile; the panels stay mounted (hidden) so the customer facts can load

  // ── Stage 2: the Estimator's wizard. Statuses come from data already loaded here (the readiness result, the budget, the draft's own validation and the quotation's own records); stage23-wizard.ts decides
  // the owner, access, locks and entry step. The Rep's submitted information is a read-only summary above the steps. ──
  const canCommercials = view.viewer.canViewCommercials;
  const isEstimator = roles.has("estimator");
  const s2Edit = isEstimator && !final; // the ONLY Stage 2 editor (the server re-checks every action)
  // The key names the exact version and costing it was given on (quote, revision, content hash, last update and the live cost and margin). It is never rendered or put in an attribute.
  const costKey = budget ? costAckKey({ quoteId: q.id, revision: q.revision, draftHash: q.draft_hash, updatedAt: q.updated_at, estimatedCost: budget.totals.estimatedCost, marginPct: budget.totals.overallMarginPct }) : null;
  const s2Base: Omit<Stage2Input, "costAcknowledged"> = {
    canViewCommercials: canCommercials, editable, roles: { rep: roles.has("rep"), estimator: roles.has("estimator"), manager: roles.has("manager") }, revision: q.revision, state: q.state as "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL", calcValid: ev.calc.valid, lines: ev.calc.lines,
    readiness: { state: rd.state, reasons: rd.reasons, missingMappings: rd.counts.missingMappings },
    budget: budget ? { incomplete: budget.incomplete, estimatedCost: budget.totals.estimatedCost, marginPct: budget.totals.overallMarginPct, lines: budget.lines, charges: budget.charges } : null,
    blankExclusionCount: blankExclusionKeys.length, incompleteCostOverrideCount: Object.keys(previewCostOverrides(draft.estimator.costOverrides).errors).length,
    blankPriceReasonCount: Object.values(draft.estimator.priceResolutions).filter((r) => r && !r.reason.trim()).length,
    totalAvailable: totalCents != null, confirmedRecorded: q.customer_confirmed_cents != null,
    dirty, signoff: !q.estimator_signoff_hash ? "none" : q.estimator_signoff_hash === q.draft_hash ? "current" : "stale",
  };
  // The data-derived costing status (no acknowledgement). "Review needed" = the figures are complete and can be reviewed; the Cin7 cost-capture state lives in the Cost panel and is not read here.
  const costBase = canCommercials ? deriveStage2Steps({ ...s2Base, costAcknowledged: false }).steps.find((x) => x.id === "cost") : undefined;
  // Any unsaved edit clears the acknowledgement (reverting does not restore it: safe), and so does a save or any change to the costing. The cost and margin in the key are belt-and-braces
  // beside the revision, content hash and update time. It is offered only to the Estimator, only in Estimator review, and only while the costing is genuinely in the "Review needed" state.
  const canAckCost = canCommercials && q.state === "ESTIMATOR_REVIEW" && isEstimator && costKey != null && costBase?.status === "review";
  const costAcknowledged = canAckCost && costAck === costKey && !dirty;
  const costNeedsMark = canAckCost && !dirty && !costAcknowledged; // the one action is offered only when it can actually take effect
  const ACK_EXPLAIN = "This records that you have looked at the costing and margin for this version. It is not the Estimator sign-off.";
  const work2 = estimatorWork(budget?.lines ?? null, workFacts.blankPriceReasonCount);
  const commercial = view.viewer.canViewCommercials && budget ? commercialReadiness({ lines: budget.lines, blankPriceReasonCount: workFacts.blankPriceReasonCount, costMissingLines: marginInfo?.missing ?? 0, costingIncomplete, costingReason }) : null;
  const amountChange = confirmedAmountChange(q.customer_confirmed_cents, totalCents);
  const mappingOpen = work2.all; // the CURRENT open Estimator items by kind (never stale after the mappings are confirmed)
  // UX policy (no server change): while the review CAN be marked (commercial Estimator, in review, costing in "Review needed", no unsaved edits), signing off waits for the session mark. Returning to the Rep never does.
  const signoffNeedsReview = canAckCost && !costAcknowledged;
  // Every reason the server (or the review policy) would refuse the sign-off for, up front, in the server's own order: READY, costing complete, confirmed amount = total, then the review mark.
  const signoffBlockers = [
    signoffWhy,
    !signoffWhy && costingIncomplete ? `Costing is incomplete: ${costingReason ?? "supplier costs are unresolved"}. Complete it (or record an authorised incomplete-cost exception) before signing off.` : undefined,
    !signoffWhy && amountChange.changed ? amountChange.text ?? undefined : undefined,
    signoffNeedsReview ? "Mark the costing reviewed first (Final review)." : undefined,
  ].filter((x): x is string => !!x);
  const wizard2 = deriveStage2Wizard({ state: q.state as "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL", revision: q.revision, roles: { rep: roles.has("rep"), estimator: isEstimator, manager: roles.has("manager") }, canViewCommercials: canCommercials, signoff: s2Base.signoff,
    dirty, calcValid: ev.calc.valid, readiness: { state: rd.state, reasons: rd.reasons }, mappingOpen, repOpenCount: stage1.open.filter((o) => o.owner === "Rep").length, cost: costBase ? { status: costBase.status, note: costBase.note } : null,
    costAcknowledged, confirmedCents: q.customer_confirmed_cents, totalCents, costMissingLines: marginInfo?.missing ?? 0, costingIncomplete, costingReason,
    mappingSummary: [work2.map.length > 0 && `${work2.map.length} line${work2.map.length === 1 ? "" : "s"} unmapped`, work2.price.length > 0 && `${work2.price.length} supplier quote${work2.price.length === 1 ? "" : "s"} required`, work2.reason.length > 0 && work2.reason[0]].filter(Boolean).join(" · ") || undefined });
  const railSteps2 = toRailSteps(wizard2.steps); // steps hidden from this viewer (the cost steps without cost visibility) are not on the rail
  const visible2 = railSteps2.map((x) => x.id);
  const railSteps2View = railSteps2.map((x) => (x.id === "signoff" && signoffNeedsReview && !x.locked ? { ...x, note: "Sign-off waits for the final review mark; Return is open" } : x));
  const req2Id = req2No !== null ? visible2[req2No - 1] ?? null : null;
  // Resolve the entry step ONCE (the quotation and its evaluation are loaded by now) and latch it: no later save, recalculation or edit moves the viewer.
  if (stage === 2 && entry2 === null) setEntry2(resolveEntryStep(wizard2, req2Id));
  const step2Id = currentStepId(wizard2.steps, req2Id ?? entry2 ?? wizard2.entryStepId);
  const step2Cur = visible2.indexOf(step2Id) + 1;
  const step2Access = (id: Stage2WizardId) => wizard2.steps.find((x) => x.id === id)!;
  const lockedFor2 = (id: Stage2WizardId): string[] | undefined => (step2Access(id).access === "locked" ? step2Access(id).blockedBy : undefined);
  const write2Step = (n: number) => { try { const u = new URL(window.location.href); u.searchParams.set("stage", "2"); u.searchParams.set("step", String(n)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ } };
  // A request for a step that is not permitted (locked, or one that locked after a change) is replaced by where the viewer actually is; the viewer is never moved to a LATER step by this.
  if (stage === 2 && entry2 !== null && req2No !== null && req2No <= visible2.length && req2Id !== step2Id) { setReq2No(step2Cur); write2Step(step2Cur); }
  const goStep2Id = (id: Stage2WizardId) => {
    if (!isPermitted(step2Access(id))) return; // a locked step is not selectable (the rail also refuses it)
    setAckFor(null);
    const n = visible2.indexOf(id) + 1;
    setReq2No(n); write2Step(n);
  };
  const goStep2 = (id: string) => goStep2Id(id as Stage2WizardId);
  const next2Open = nextIncompleteStepId(railSteps2, step2Id, (x) => step2Access(x.id as Stage2WizardId).access === "edit" && x.status !== "review"); // only this viewer's own work, never another role's; the costing is looked at, and acknowledged in Final review
  const finalChecklist = deriveFinalReviewChecklist({ mappingOpen, readiness: { state: rd.state, reasons: rd.reasons }, cost: costBase ? { status: costBase.status, note: costBase.note } : null, confirmedCents: q.customer_confirmed_cents, totalCents, dirty, calcValid: ev.calc.valid, costMissingLines: marginInfo?.missing ?? 0, costingIncomplete, costingReason });
  const finalBlockText = finalReviewBlockText({ state: q.state as "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL", isEstimator, canViewCommercials: canCommercials, costStatus: costBase?.status ?? null, costNote: costBase?.note, dirty });
  const finalStepDone = final || step2Access("final").status === "complete" || step2Access("final").counted === true;
  const finalBlocked = canCommercials && !costNeedsMark && !costAcknowledged && !finalStepDone && finalBlockText != null; // nothing can be recorded: say why instead of offering an ineffective action
  const markReviewed = () => {
    setCostAck(costKey);
    if (showAllSteps) setTimeout(() => document.getElementById("cost-ack-done")?.focus(), 0); else goStep2Id("signoff"); // step mode: the Sign-off heading takes focus; show-all: the "marked reviewed" text does
    setAckFor(costKey);
  };
  // The announcement is derived from the resulting state, never from the click: it is spoken only while the acknowledgement actually holds.
  const ackMsg = costAcknowledged && ackFor === costKey ? "Final review marked as reviewed for this session. This is not a sign-off." : "";
  const signedNow = q.state === "ESTIMATOR_REVIEW" && s2Base.signoff === "current";
  // Editing an earlier step during Estimator review is allowed by the server and withdraws a current sign-off: say so where the Estimator edits.
  const editWarning = s2Edit && q.state === "ESTIMATOR_REVIEW" && (signedNow || costAcknowledged)
    ? (signedNow ? (dirty ? "Unsaved edits: saving them withdraws your sign-off. You will have to mark the final review and sign off again." : "Your sign-off is current. Changing anything in this step and saving withdraws it; you would then mark the final review and sign off again.")
      : "Changing anything in this step clears your 'marked reviewed': you review the final step again.") : null;
  const repQuantities = ev.calc.lines.filter((l) => l.basis !== "not_selected" && !l.exclusionReason && l.projectQuantity != null).map((l) => ({ label: l.label.split(" (")[0], qty: l.projectQuantity as number }));
  const priceExceptions = (budget?.lines ?? []).filter((b) => b.pricedBy === "estimator_resolution").map((b) => { const r = draft.estimator.priceResolutions[b.itemKey as GrowerItemKey]; return { label: b.label, unitPrice: r?.unitPriceExVat ?? 0, reason: r?.reason ?? "", by: r?.by, at: r?.at }; });
  const costOverrideRows = canCommercials ? Object.entries(draft.estimator.costOverrides ?? {}).map(([k, o]) => ({ label: lineByKey.get(k as GrowerItemKey)?.label ?? k, costCents: o.lineCostCents, reason: o.reason, by: o.by })) : null;
  // The three biggest lines by selling value, so an implausible line is noticeable (display only, no check). Only for a viewer with cost visibility.
  const largestLines = (budget?.lines ?? []).filter((b) => b.revenueExTax != null && b.revenueExTax > 0).sort((a, b) => (b.revenueExTax ?? 0) - (a.revenueExTax ?? 0)).slice(0, 3).map((b) => ({ label: b.label, amount: b.revenueExTax as number }));
  const confirmSourceBacked = () => edit((d) => {
    for (const l of ev.calc.lines) {
      if (l.basis === "not_selected") continue;
      const sku = expectedSkuFor(l.itemKey, d.config.feederVariant);
      if (sku && l.itemKey !== "pvc_door") d.estimator.confirmedMappings[l.itemKey] = sku;
      if (packageFor(l.itemKey) && !packageFor(l.itemKey)!.estimatorPriced && !d.estimator.confirmedPackages.includes(l.itemKey)) d.estimator.confirmedPackages.push(l.itemKey);
    }
  });
  const repSummary = (
    <RepSubmittedSummary draft={draft} submitted={q.state !== "REP_DRAFT"} revision={q.revision} floorAreaM2={ev.calc.derived.floorAreaM2} totalCents={q.state === "REP_DRAFT" ? totalCents : (q.customer_confirmed_cents ?? totalCents)} quantities={repQuantities}
      confirmed={{ cents: q.customer_confirmed_cents, by: q.customer_confirmed_by, at: q.customer_confirmed_at }} />
  );
  const wizard3 = deriveStage3Wizard({ state: q.state as "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL", revision: q.revision, roles: { rep: roles.has("rep"), estimator: isEstimator, manager: roles.has("manager") }, signoff: s2Base.signoff, dirty });

  // Stage 4 steps: guidance only. Statuses come from the issued-document and sent records the page already reads (never from a visit); the Issue and Send actions keep their own gates.
  const stage4 = deriveStage4Steps({ hasDocument: gate.hasDocument, commercial: gate.status });
  const step4Id: Stage4StepId = STAGE4_STEP_IDS[step4No - 1] ?? "issue";
  const goStep4No = (n: number) => {
    const next = Math.min(Math.max(n, 1), STAGE4_STEP_IDS.length);
    setStep4No(next);
    // `stage` goes with `step`: with no ?stage= the page lands on the current stage after a reload and would ignore the step.
    try { const u = new URL(window.location.href); u.searchParams.set("stage", "4"); u.searchParams.set("step", String(next)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ }
  };
  const next4Open = nextIncompleteStepId(stage4, step4Id);
  // Stage 3 / 5 / 6 guidance, derived from state already held here (the predicates are checkApproval, the stage-5 status and resolveScheduleChoice).
  const approvalChecklist = deriveApprovalChecklist({ readinessState: rd.state, readinessReasons: rd.reasons, totalExVatCents: totalCents, customerConfirmedCents: q.customer_confirmed_cents, signoffHash: q.estimator_signoff_hash, currentDraftHash: q.draft_hash, dirty, isManager: roles.has("manager"), costing: costingSrv, baselineException: view.baselineException ?? null, signoffExplainedBelow: approveSignoffMissing || approveSignoffStale });
  const acceptanceBanner = deriveAcceptanceBanner(stages[4], final ? gate.status : null);
  const handoverReadiness = deriveHandoverReadiness({ approved: final, acceptanceRequired: gate.requires, accepted: gate.accepted, scheduleOk: resolveScheduleChoice(scheduleChoice).ok, isManager: roles.has("manager") });
  // A stage that is not yet available can be "Preview only" where the page genuinely shows something read-only: Stage 4's customer summary once the quote is READY.
  const previewable: StageId[] = !final && summary ? [4] : [];

  const totalsPanel = budget && (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <PanelTitle>Totals</PanelTitle>
        {dirty && <Status tone="warning">{recalculating ? "Recalculating - figures below are not yet current" : "Unsaved - live preview"}</Status>}
      </div>
      <dl className="mt-3 grid max-w-xl grid-cols-2 gap-y-1 text-sm" aria-busy={recalculating}>
        <dt className="text-slate-600">Subtotal (ex VAT)</dt><dd className="whitespace-nowrap text-right tabular-nums">{fmtZar(budget.totals.subtotalExTax)}</dd>
        <dt className="text-slate-600">VAT 15%</dt><dd className="whitespace-nowrap text-right tabular-nums">{fmtZar(budget.totals.taxTotal)}</dd>
        <dt className="font-semibold text-slate-900">Total</dt><dd className="whitespace-nowrap text-right font-semibold tabular-nums">{fmtZar(budget.totals.totalIncTax)}</dd>
        {view.viewer.canViewCommercials && <><dt className="text-slate-600">{marginIncomplete ? "Estimated cost · indicative margin (price-list basis)" : "Estimated cost · GP (managers)"}</dt><dd className="text-right tabular-nums">{fmtZar(budget.totals.estimatedCost)} · {budget.totals.overallMarginPct == null ? "N/A" : `${budget.totals.overallMarginPct.toFixed(1)}%`}{marginNote && <span className="block text-xs font-normal text-amber-800" data-testid="totals-margin-note">{marginNote}</span>}</dd></>}
      </dl>
      <p className="mt-2 text-xs text-slate-600">{view.viewer.canViewCommercials ? budget.pricingBasis : QUOTE_TYPE_NEUTRAL[draft.quoteType]}. {budget.state === "complete" ? "Every required line is priced." : "Incomplete: the total is partial until every blocker is resolved."}</p>
    </Panel>
  );
  // The physical scope (read-only evidence). A viewer who may not see commercials has no Cost & margin step, so their scope sits under the line decisions and their totals under the charges.
  const scopePanel = <ScopePanel quoteId={id} draft={dirty ? (previewedFor ?? q.draft) : draft} />;

  const nr = (t: string) => (view.viewer.canViewCommercials ? t : neutralPriceText(t)); // a viewer without cost visibility reads price text without the cost basis
  const saveRow = (cls: string) => (
    <div className={`flex flex-wrap items-center gap-3 ${cls}`}>
            <Button className="min-h-11" onClick={save} loading={acts.isPending("save")} aria-describedby={saveWhy ? "save-why" : undefined} disabled={isWorking || !editable || !dirty || incompleteOverrides || blankExclusionKeys.length > 0}>Save draft</Button>
            <span role="status" aria-live="polite" data-testid="save-state">{dirty ? <Status tone="warning">Unsaved changes</Status> : editable ? <Status tone="success">All changes saved</Status> : null}</span>
            {!editable && <span id="save-why" className="text-sm text-slate-700">{final ? "Read-only: accepted quote." : "You do not have permission to edit: only a Rep or Estimator can edit and save this quotation."}</span>}
          </div>
  );

  return (
    <main className={pageContainerClass("data")}>
      {/* One compact line instead of the large page header: the title stays (the page's h1), then the way back and the quotation reference. */}
      <div className="-mt-2 flex flex-wrap items-center gap-x-3 border-b border-slate-200" data-testid="quote-header">
        <h1 className="text-base font-semibold tracking-tight text-slate-900 max-sm:sr-only">{SOLUTION_BUILDER_MODULE.label}</h1>
        <Link href="/newquip-grower" className="inline-flex min-h-11 items-center text-indigo-700 hover:underline">← Solution Builder quotes</Link><span className="text-sm text-slate-700">· {q.quote_ref} <span className="text-slate-600">rev {q.revision}</span></span>
      </div>

      {/* The price and margin summary stays in view while the form scrolls. It always shows the same figures as the Totals below (the live preview of unsaved edits). */}
      <div className="top-0 z-10 mt-3 rounded-lg border border-slate-200 bg-white px-4 py-2 shadow-sm md:sticky" data-testid="quote-summary-bar" aria-busy={recalculating}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 max-sm:flex-nowrap max-sm:gap-x-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-700 max-sm:sr-only">Calculation</span>
            <Status tone={commercial && !commercial.complete && rd.state === "READY" ? "warning" : stage === 1 ? (repReady ? "success" : "neutral") : READY_TONE[rd.state]}>{commercial && !commercial.complete && rd.state === "READY" ? "Indicative: not commercially ready" : stage === 1 ? (repReady ? "Complete" : "In progress") : READINESS_LABEL[rd.state]}</Status>
            {previewFailure ? <Status tone="danger">Recalculation failed - figures are out of date</Status> : dirty && <Status tone="warning">Preview of unsaved edits</Status>}
            {commercial && !commercial.complete && stage !== 2 && <span data-testid="commercial-chip"><Status tone="warning">{commercial.headline}</Status></span>}
          </div>
          <dl className="flex flex-wrap items-end gap-x-8 gap-y-1 max-sm:gap-x-3">
            <div><dt className="text-xs uppercase tracking-wide text-slate-700 max-sm:text-[10px] max-sm:leading-tight" data-testid="total-caption">{awaitingLines > 0 ? `Indicative total (${awaitingLines} line${awaitingLines === 1 ? "" : "s"} await the Estimator)` : totalIndicative ? "Indicative total (ex VAT)" : "Quote total (ex VAT)"}</dt><dd className={`whitespace-nowrap text-xl font-bold tabular-nums ${previewFailure ? "text-slate-700 line-through decoration-1" : "text-slate-900"}`}>{totalCents == null ? "—" : fmtCents(totalCents)}{staleCue && <span className="ml-2 text-sm font-semibold no-underline" data-testid="summary-stale">{staleCue}</span>}</dd></div>
            {budget && !budget.incomplete && <div className="max-sm:hidden"><dt className="text-xs uppercase tracking-wide text-slate-700">Total (inc VAT)</dt><dd className="whitespace-nowrap text-lg font-semibold tabular-nums text-slate-900">{fmtZar(budget.totals.totalIncTax)}</dd></div>}
            {budget && view.viewer.canViewCommercials && stage < 4 && <div><dt className="text-xs uppercase tracking-wide text-slate-700">{marginLabel}</dt><dd className="whitespace-nowrap text-lg font-semibold tabular-nums text-slate-900">{budget.totals.overallMarginPct == null ? "N/A" : `${budget.totals.overallMarginPct.toFixed(1)}%`}{marginNote && <span className="block whitespace-normal text-xs font-normal text-amber-800 max-sm:hidden" data-testid="summary-margin-note">{marginNote}</span>}</dd></div>}
          </dl>
        </div>
      </div>

      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      <ActionFeedback state={acts.stateOf("page")} floating />
      {final && <div className="mt-4"><Alert tone="info">This quote is the manager-approved final. Its accepted baseline is frozen; any change after acceptance must be a Variation on the Project.</Alert></div>}

      <StageNav compact={stage <= 2} hideNext={stage === 2} stages={stagesView} current={here} viewing={stage} onSelect={goStage} previewable={previewable} viewer={{ roles: view.viewer.roles, state: q.state, estimatorOpen: mappingOpen.length, signedOff: s2Base.signoff === "current" }} />

      {view.returnInfo?.destination === "ESTIMATOR" && !view.viewer.canViewCommercials && q.state === "ESTIMATOR_REVIEW" && stage === 1 && <p role="status" className="mt-3 text-sm text-slate-800" data-testid="rep-with-estimator">{returnNoticeText(view.returnInfo, fmtCents).headline}</p>}
      {/* D-21: the Estimator/Manager see WHY the Manager sent it back on whichever stage they land on (the notice is not tied to Stage 2); off Stage 2 it points to the review. */}
      {canCommercials && q.state === "ESTIMATOR_REVIEW" && <EstimatorReturnNotice info={view.returnInfo} fmt={fmtCents} onOpenReview={stage === 2 ? undefined : () => goStage(2)} />}
      {gated1 && <p role="status" aria-live="polite" className="mt-4 text-sm text-slate-700" data-testid="stage1-shell">Preparing your quotation steps…</p>}
      {stage === 1 && (
        <div hidden={gated1} inert={gated1}>
          {wizard.returned && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="status" data-testid="returned-banner">
              <p className="font-semibold">Returned to the Rep (revision {q.revision})</p>
              {effectInfo?.confirmationCleared && effectInfo.previousCents != null && effectInfo.newCents != null ? (
                <p className="mt-1 font-medium" data-testid="return-amount-change">The total changed from {fmtCents(effectInfo.previousCents)} to {fmtCents(effectInfo.newCents)}; the customer&apos;s confirmation was withdrawn: reconfirm the new amount with the customer and submit again.{effectInfo.approvalSyncError ? ` The approval request could not be updated: ${effectInfo.approvalSyncError}` : ""}</p>
              ) : serverReturn ? (
                <>
                  <p className="mt-1" data-testid={serverReturn.kind === "AMOUNT_CHANGED" ? "return-amount-change" : "return-reason"}>{returnNoticeText(serverReturn, fmtCents).detail}</p>
                  {returnNoticeText(serverReturn, fmtCents).action && <p className="mt-1">{returnNoticeText(serverReturn, fmtCents).action}</p>}
                </>
              ) : returnInfo ? (
                <>
                  <p className="mt-1" data-testid="return-reason">Returned by {returnInfo.by} on {formatSast(returnInfo.at)}: &ldquo;{returnInfo.reason}&rdquo;</p>
                  <p className="mt-1">Fix what the Estimator described, then submit again.</p>
                </>
              ) : returnRead === "none" && q.customer_confirmed_cents == null ? (
                // Nothing was described: the approval request was withdrawn / superseded because the total changed after the Estimator's review. Only already-loaded state is used.
                <p className="mt-1 font-medium" data-testid="return-withdrawn">The total changed after the Estimator&apos;s review, so the customer&apos;s confirmation was withdrawn. Reconfirm the current amount ({totalCents == null ? "not available yet" : fmtCents(totalCents)}) with the customer, then submit again (step 5).</p>
              ) : (
                <>
                  <p className="mt-1">The Estimator or Manager sent this quotation back for corrections. Returned by the Estimator/Manager - see Approval history for the reason.</p>
                  <p className="mt-1">Fix what the Estimator described, then submit again.</p>
                </>
              )}
              <div className="mt-2"><ApprovalHistory docType="QUOTE" docId={id} label="Show the full approval history" /></div>
            </div>
          )}
          <StepRail dense id="s1" ariaLabel="Configuration steps" steps={railSteps1} currentId={stepId} onSelect={goStep}
            moreActions={(
              <>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAllSteps} onChange={(e) => setShowAllSteps(e.target.checked)} /> Show all steps</label>
                {nextOpen
                  ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep(nextOpen)}>Next incomplete step</Button>
                  : (wizard.submitted || wizard.steps.filter((x) => x.access === "edit").every((x) => x.status === "complete")) ? <span className="text-sm text-slate-700" data-testid="all-steps-complete">{wizard.submitted ? "Rep preparation complete - next: Estimator." : "Every step you can act on is complete."}</span> : null}
                {editable && <p className="text-xs text-slate-600 sm:hidden" data-testid="saving-rules-mobile">Customer and contact save as you choose them. Everything else saves when you press Save draft.</p>}
              </>
            )}
            actions={(
              <>
                {saveRow("")}
                {editable && <p className="text-xs text-slate-600 max-sm:hidden" data-testid="saving-rules">Customer and contact save as you choose them. Everything else saves when you press Save draft.</p>}
              </>
            )} />
        </div>
      )}

      {stage === 2 && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm" data-testid="stage2-owner">
            <span className="font-semibold text-slate-900">Stage 2 is the Estimator&apos;s review.</span>
            <span role="status" aria-live="polite" className="text-slate-800" data-testid="stage2-status-line">{wizard2.statusLine}</span>
            <OwnerTag role={wizard2.nextOwner} />
            {commercial && !commercial.complete && <span data-testid="commercial-chip" className="max-w-full max-sm:hidden [&>span]:whitespace-normal"><Status tone="warning">{commercial.headline}</Status></span>}
            {commercial && !commercial.complete && <span className="sm:hidden" data-testid="commercial-chip-short"><Status tone="warning">Not commercially ready ({commercial.items.length} item{commercial.items.length === 1 ? "" : "s"})</Status></span>}
          </div>
          {amountChange.changed && q.state === "ESTIMATOR_REVIEW" && <div className="mt-2"><Alert tone="warning"><span data-testid="total-changed">{amountChange.text}</span></Alert></div>}
          {repSummary}
          {req2No !== null && req2No > visible2.length && <p className="mt-3 text-sm text-slate-800" data-testid="step-unavailable">That step is not available to you, so the first step is shown.</p>}
          <StepRail dense oneLineNotes id="s2" ariaLabel="Costing and review steps" steps={railSteps2View} currentId={step2Id} onSelect={goStep2}
            moreActions={(
              <>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAllSteps} onChange={(e) => setShowAllSteps(e.target.checked)} /> Show all steps</label>
                {next2Open
                  ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep2(next2Open)}>Next incomplete step</Button>
                  : <span className="text-sm text-slate-700" data-testid="all-steps-complete">{signedNow ? "Signed off. Next: Manager approval (Stage 3)." : q.state === "ESTIMATOR_REVIEW" && isEstimator ? "Next: sign off or return the quotation." : q.state === "REP_DRAFT" && isEstimator ? (mappingOpen.length > 0 ? "Next: choose the products listed above, then save." : "Nothing is left for you until the Rep submits.") : "Nothing is left for you in this stage."}</span>}
                </>
            )}
            actions={(s2Edit || dirty) ? saveRow("") : undefined} />
        </>
      )}

      {stage === 2 && canCommercials && <div role="status" aria-live="polite" data-testid="cost-ack-live">{ackMsg && <p className="mt-3 text-sm text-slate-800" data-testid="cost-ack-status">{ackMsg}</p>}</div>}
      {stage === 2 && <div role="status" data-testid="next-role-live">{signedNow && <p className="mt-3 text-sm font-semibold text-slate-900" data-testid="next-manager-cue">Next: Manager approval (Stage 3).</p>}</div>}
      {(stage === 1 || (stage === 2 && (s2Edit || dirty))) && (
        <>
          <div className="mt-2 space-y-1">{editable && <div className={!dirty ? "sr-only" : ""}><DisabledReason id="save-why">{saveWhy}</DisabledReason></div>}<ActionFeedback state={acts.stateOf("save")} /></div>
          <div className="mt-2 space-y-2">
          {dirty && <p className="max-w-4xl text-sm text-slate-700" data-testid="unsaved-note">{recalculating ? "Recalculating… " : ""}{view.viewer.canViewCommercials ? "The prices, costs, margins and totals" : "The quantities, prices and totals"} are a live preview of your edits and nothing is saved until you press Save draft. Sign-off and approval use the SAVED draft.</p>}
          {stage === 1 && (productChangePending || mapRefused) && <p className="max-w-4xl text-sm font-medium text-amber-900" data-testid="product-change-refused">{PRODUCT_CHANGE_SHORT}</p>}
          {previewFailure && <p className="max-w-4xl text-sm text-red-700">The live recalculation failed ({previewFailure}); the figures shown may be out of date. Edit again or reload.</p>}
          {incompleteOverrides && <p className="max-w-4xl text-sm text-amber-800">Complete or clear the highlighted cost overrides (a reason and an amount) before saving.</p>}
          {blankExclusionKeys.length > 0 && <p className="max-w-4xl text-sm text-amber-800">Enter a reason for each ticked exclusion before saving (the preview already applies it).</p>}
          </div>
        </>
      )}
      {sampleNote && stage === 1 && <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-800" data-testid="sample-note">{sampleNote}</p>}

      {/* ───────────── 1 · CONFIGURATION (the Rep's five-step wizard) ───────────── */}
      {stage === 1 && (
        <div hidden={gated1} inert={gated1}>
        <fieldset disabled={!stage1Edit} className="mt-2 min-w-0 border-0 p-0 [&_section.rounded-lg]:p-4! max-sm:[&_section.rounded-lg]:p-3! [&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11 [&_textarea]:min-h-11" data-testid="stage1-layout">
          {/* Hidden steps stay mounted (hidden + inert), so the requests made on mount are the same whichever step is shown. A LOCKED step stays mounted too; show-all lists it as heading + reason. */}
          <StepPanel railId="s1" stepId="customer" number={1} title={STAGE1_STEP_LABEL.customer} current={stepId === "customer"} showAll={showAllSteps} locked={lockedFor("customer")} className={stepPanelCls}>
            <Panel>
              <p className="text-sm text-slate-700">Search Cin7 for the customer, then choose who the quotation goes to. Choosing is saved at once.</p>
              {customerFacts.loaded && !customerFacts.available && (
                <div className="mt-4 grid gap-4 md:grid-cols-3"><TextField label="Customer" value={draft.customerName} onChange={(v) => edit((d) => { d.customerName = v; })} hint="Typed name, used only because Cin7 customer lookup is not available yet." /></div>
              )}
              <CustomerPanel quoteId={id} editable={stage1Edit} onPicked={onCustomerChanged} onFacts={onCustomerFacts} />
          {q.state === "REP_DRAFT" && (
            <div className="mt-3 text-xs text-slate-700" data-testid="estimator-note">
              {estimatorWorkOpen && <>Some products must be mapped and priced by an Estimator before this quotation can be submitted - you can finish your part first; we will show exactly what is waiting on them.{" "}
                <details className="inline"><summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-indigo-700 underline">Why?</summary><span className="ml-1">Which Cin7 product each item is, and any manual price, are chosen by an Estimator, not by the Rep. Review (step 4) lists what is waiting on them and how many.</span></details>{" "}</>}
              The customer must also confirm the quotation total with you before you submit (you record this at the last step).
            </div>
          )}
            </Panel>
          </StepPanel>

          <StepPanel railId="s1" stepId="site" number={2} title={STAGE1_STEP_LABEL.site} current={stepId === "site"} showAll={showAllSteps} locked={lockedFor("site")} className={`${stepPanelCls} xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]`}>
            <Panel>
              <PanelTitle>Site &amp; pricing basis</PanelTitle>
              <div className="mt-4 grid gap-4">
                <TextField label="Site / project name" error={err("siteName")} onBlur={() => touch("siteName")} value={draft.siteName} onChange={(v) => edit((d) => { d.siteName = v; })} />
                <Select label="Pricing basis" value={draft.quoteType} onChange={(e) => edit((d) => { d.quoteType = e.target.value as QuoteType; })}>
                  <option value="project">{QUOTE_TYPE_NEUTRAL.project}</option>
                  <option value="day_to_day">{QUOTE_TYPE_NEUTRAL.day_to_day}</option>
                </Select>
              </div>
            </Panel>
            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PanelTitle>Room measurements — describe ONE room</PanelTitle>
                {stage1Edit && <Button variant="secondary" size="sm" className="min-h-11" onClick={() => askSample("measurements")}>Load sample measurements</Button>}
              </div>
              <p className="mt-1 text-sm text-slate-700">{ROOMS_HELP}</p>
              {stage1Edit && <p className="mt-1 text-xs text-slate-600">“Load sample measurements” fills {SAMPLE_MEASUREMENTS_FILLS}. Nothing is saved until you press Save draft.</p>}
              {confirmSample === "measurements" && <SampleConfirm what="the room measurements" onYes={() => runSample("measurements")} onNo={() => setConfirmSample(null)} />}
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <NumField label="Length" error={err("lengthM")} onBlur={() => touch("lengthM")} unit="m" value={cfg.lengthM || null} onChange={(v) => edit((d) => { d.config.lengthM = num(v); })} />
                <NumField label="Width" error={err("widthM")} onBlur={() => touch("widthM")} unit="m" value={cfg.widthM || null} onChange={(v) => edit((d) => { d.config.widthM = num(v); })} />
                <NumField label="Number of rooms" error={err("rooms")} onBlur={() => touch("rooms")} value={cfg.rooms || null} onChange={(v) => edit((d) => { d.config.rooms = num(v); })} hint="Multiplies every per-room quantity" />
                <NumField label="Total pens" error={err("totalPens")} onBlur={() => touch("totalPens")} unit="per room" value={cfg.totalPens || null} onChange={(v) => edit((d) => { d.config.totalPens = num(v); })} />
                <NumField label="Hospital pens" error={err("hospitalPens")} onBlur={() => touch("hospitalPens")} unit="per room" value={cfg.hospitalPens} onChange={(v) => edit((d) => { d.config.hospitalPens = num(v); })} />
                <NumField label="Pigs per room" error={err("pigsPerRoom")} onBlur={() => touch("pigsPerRoom")} value={cfg.pigsPerRoom || null} onChange={(v) => edit((d) => { d.config.pigsPerRoom = num(v); })} hint="±600 is per room" />
              </div>
              <p className="mt-3 text-sm text-slate-600">
                Room floor area: <strong className="tabular-nums">{ev.calc.derived.floorAreaM2 == null ? "—" : `${Math.round(ev.calc.derived.floorAreaM2 * 1000) / 1000} m²`}</strong>
                {" "}· minimum lights per room = ceil(area ÷ 25) = <strong>{lineByKey.get("led_light")?.defaultQuantityPerRoom ?? "—"}</strong>
              </p>
            </Panel>
          </StepPanel>

          <StepPanel railId="s1" stepId="equipment" number={3} title={STAGE1_STEP_LABEL.equipment} current={stepId === "equipment"} showAll={showAllSteps} locked={lockedFor("equipment")} className={stepPanelCls}>
            <div className="col-span-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-sm text-slate-700 max-sm:hidden">Choose the system and options, then enter the quantities and charges.</p>
              {stage1Edit && (
                <div className="flex flex-wrap items-center gap-2">
                  <details className="text-xs text-slate-600"><summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-indigo-700 underline">What does this fill?</summary>
                    <p className="max-w-xl">“Load recommended configuration” fills {RECOMMENDED_CONFIG_FILLS}. Nothing is saved until you press Save draft.</p></details>
                  <Button variant="secondary" size="sm" className="min-h-11" onClick={() => askSample("recommended")}>Load recommended configuration</Button>
                </div>
              )}
            </div>
            {confirmSample === "recommended" && <div className="col-span-full"><SampleConfirm what="the equipment selections, quantities and overrides" onYes={() => runSample("recommended")} onNo={() => setConfirmSample(null)} /></div>}
            <div className="col-span-full grid min-w-0 items-start gap-6 xl:grid-cols-2">
            <Panel>
              <PanelTitle>Equipment selections</PanelTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Select label="CCM feeder variant" error={productChangePending ? PRODUCT_CHANGE_REFUSED : err("feederVariant")} helperText={`One feeder, two variants. Capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs per feeder. ${stage1Edit && !canMap ? PRODUCT_CHANGE_NOTE : ""}`} value={cfg.feederVariant ?? "STANDARD"} onChange={(e) => edit((d) => { d.config.feederVariant = e.target.value as "STANDARD" | "WINDOW"; delete d.estimator.confirmedMappings.feeder; })}>
                  <option value="STANDARD">Standard — PNQ082</option>
                  <option value="WINDOW">With window — PNQ082-WINDOW</option>
                </Select>
                <Select label="Penning pig size" error={err("penningPigSize")} onBlur={() => touch("penningPigSize")} value={cfg.penningPigSize ?? ""} onChange={(e) => edit((d) => { d.config.penningPigSize = (e.target.value || null) as PenningPigSize | null; })}>
                  <option value="">Select…</option>
                  {(Object.keys(PIG_SIZE_LABEL) as PenningPigSize[]).map((k) => <option key={k} value={k}>{PIG_SIZE_LABEL[k]}</option>)}
                </Select>
                {productChangePending && <div className="sm:col-span-2" data-testid="product-change-control"><Button type="button" variant="secondary" className="min-h-11" onClick={undoProductChange}>Undo this change</Button></div>}
                <NumField label="Penning running metres" error={err("penningRunningMetresPerRoom")} onBlur={() => touch("penningRunningMetresPerRoom")} unit="per room" value={cfg.penningRunningMetresPerRoom} onChange={(v) => edit((d) => { d.config.penningRunningMetresPerRoom = v; })} hint="Running metres, not m²" />
                <NumField label="Slatted floor area (context only)" error={err("slattedFloorAreaM2")} onBlur={() => touch("slattedFloorAreaM2")} unit="m², one room" value={cfg.slattedFloorAreaM2} onChange={(v) => edit((d) => { d.config.slattedFloorAreaM2 = v; })} hint="Never converted to a slat quantity — you enter the quantity below" />
              </div>
            </Panel>

            <Panel>
              <PanelTitle>Optional equipment</PanelTitle>
              <p className="mt-1 text-sm text-slate-700">Tick what the customer wants included. {stage1Edit && !canMap ? `${PRODUCT_CHANGE_NOTE} ` : ""}{VENTILATION_SCOPE_STATUS}: no fan, cooling or controller rule is invented, so you enter the quantity below once an item is included.</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {(Object.keys(OPTIONAL_LABELS) as OptionalItemKey[]).map((k) => {
                  const on = cfg.optionalEquipment[k];
                  return (
                    <li key={k}>
                      <label className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${on ? "border-indigo-600 bg-indigo-50 text-slate-900" : "border-slate-300 bg-white text-slate-700"}`}>
                        <span className="flex items-center gap-2"><input type="checkbox" className="size-6" checked={on} onChange={(e) => edit((d) => { d.config.optionalEquipment[k] = e.target.checked; })} /> {OPTIONAL_LABELS[k]}</span>
                        <span className={`text-xs font-semibold ${on ? "text-indigo-800" : "text-slate-600"}`} data-testid={`optional-state-${k}`}>{on ? "✓ Included" : "Not included"}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Panel>
            </div>

            <Panel className="col-span-full">
              <CollapsibleSection testId="section-charges" title="Charges &amp; assumptions" chip={chargeChip} attention={chargeOpen > 0}>
                <p className="mt-1 text-sm text-slate-700">Enter the amounts for this quotation (ex VAT). Each says who usually supplies it.</p>
                <ChargesSection draft={draft} edit={edit} />
              </CollapsibleSection>
            </Panel>

            <Panel className="col-span-full">
              <CollapsibleSection testId="section-quantities" title={`Quantities (per room × ${cfg.rooms || 0} rooms)`} chip={qtyChip} attention={qtyOpen > 0}>
                <p className="mt-1 text-sm text-slate-700">Enter the quantity for each item the system needs you to confirm. Product choices and manual quotation prices belong to the Estimator{estChoices > 0 ? ` (waiting on the Estimator: ${estChoices})` : ""}.</p>
                {ev.calc.valid || ev.calc.lines.length > 0
                  ? <LineDecisionsTable draft={draft} ev={ev} edit={edit} roles={roles} editable={stage1Edit} mode="rep" quantitiesEditable />
                  : <p className="mt-3 text-sm text-amber-900">Finish the room measurements in step 2 to see the quantities.</p>}
              </CollapsibleSection>
            </Panel>

            <Panel className="col-span-full">
              <CollapsibleSection testId="section-exclusions" title="Exclusions" chip={exclChip} attention={blankExclusionKeys.length > 0}>
                <ExclusionsSection draft={draft} ev={ev} edit={edit} />
              </CollapsibleSection>
            </Panel>
          </StepPanel>
        </fieldset>

        {/* Steps 4 and 5 are outside the form fieldset, so their navigation works for every role. */}
        <StepPanel railId="s1" stepId="review" number={4} title={STAGE1_STEP_LABEL.review} current={stepId === "review"} showAll={showAllSteps} locked={lockedFor("review")} className="mt-6 grid min-w-0 gap-6">
          <Stage1Review awaiting={awaiting} draft={draft} floorAreaM2={ev.calc.derived.floorAreaM2} totalLabel={totalCents == null ? "—" : fmtCents(totalCents)} derived={stage1} steps={wizard.steps} customer={customerFacts} canEdit={q.state === "REP_DRAFT" && roles.has("rep")}
            quantities={ev.calc.lines.filter((l) => l.basis !== "not_selected" && !l.exclusionReason && l.projectQuantity != null).map((l) => ({ label: l.label.split(" (")[0], qty: l.projectQuantity as number }))} onGoStep={goStep} />
        </StepPanel>

        <StepPanel railId="s1" stepId="submit" number={5} title={STAGE1_STEP_LABEL.submit} current={stepId === "submit"} showAll={showAllSteps} locked={lockedFor("submit")} className="mt-6 grid min-w-0 gap-6">
          <Panel>
            <PanelTitle>Submit to Estimator</PanelTitle>
            {wizard.submitted ? (
              <div className="mt-2 space-y-3" data-testid="rep-complete">
                <p className="text-sm font-semibold text-emerald-900"><span aria-hidden>✓ </span>Rep preparation complete - next: {wizard.nextOwner}</p>
                <p className="text-sm text-slate-800" data-testid="submit-state">{final ? "Submitted and approved." : "Submitted: the quote is with the Estimator for review."}</p>
                {q.customer_confirmed_cents != null && <ConfirmationPanel quoteId={id} amountLabel={fmtCents(q.customer_confirmed_cents)} canAct={false} ready loading={false} refreshKey={`${q.revision}:${q.state}:${q.updated_at}`} recorded onConfirm={() => undefined} />}
                <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStage(final ? 3 : 2)}>{final ? "Open Manager approval" : "Open Estimator review"}</Button>
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-sm text-slate-700 max-sm:hidden">Final step for the Rep. The Estimator reviews the costing next.</p>
                {awaitingLines > 0 && <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="indicative-note">This total is indicative while {awaitingLines} line{awaitingLines === 1 ? "" : "s"} await{awaitingLines === 1 ? "s" : ""} the Estimator. If the Estimator&apos;s pricing changes it, the quotation returns to you to reconfirm the amount with the customer.</p>}
                <div className="mt-3">
                  <ConfirmationPanel quoteId={id} amountLabel={totalCents == null ? null : fmtCents(totalCents)} canAct={roles.has("rep") && q.state === "REP_DRAFT"} ready={repReady} indicativeLines={totalIndicative ? awaiting.lines : 0} loading={isWorking} refreshKey={`${q.revision}:${q.state}:${q.updated_at}`} recorded={false}
                    onConfirm={(c) => act(() => sendGrowerQuoteToEstimatorAction(id, totalCents!, c), "Submitted to the Estimator: the customer's price confirmation is recorded and the Estimator has been notified.", "send", (v) => v.quote.state === "ESTIMATOR_REVIEW", 1)} />
                </div>
              </div>
            )}
            <ActionFeedback state={acts.stateOf("send")} />
          </Panel>
        </StepPanel>

        {!showAllSteps && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3" data-testid="step-buttons">
            {stepNo > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStepId(STAGE1_STEP_IDS[stepNo - 2])}>Back</Button> : <span />}
            {nextStep1 && nextStep1Locked && (
              <div className="flex max-w-xl flex-col items-end gap-1">
                {/* aria-disabled (not `disabled`) so that TRYING to go on is a signal: it marks this step's fields as touched and their problems appear at the fields. Nothing else happens. */}
                <Button type="button" className={`min-h-11 ${nextStep1Locked.access === "locked" ? "opacity-50" : ""}`} aria-disabled={nextStep1Locked.access === "locked" || undefined} aria-describedby={nextStep1Locked.access === "locked" ? "next-why" : undefined} onClick={() => { if (nextStep1Locked.access === "locked") { if (stepId === "site" || stepId === "equipment") touch(...STEP_FIELD_KEYS[stepId]); return; } goStepId(nextStep1); }}>Next: {STAGE1_STEP_LABEL[nextStep1]}</Button>
                {nextStep1Locked.access === "locked" && <p id="next-why" className="text-right text-sm text-amber-900" data-testid="next-blocked">{nextStep1Locked.blockedBy.join(" ")}</p>}
              </div>
            )}
          </div>
        )}
        </div>
      )}

      {/* ───────────── 2 · ESTIMATOR REVIEW ───────────── */}
      {stage === 2 && (
        <>
        <fieldset disabled={!s2Edit} className="mt-4 min-w-0 space-y-6 border-0 p-0">
          {/* Hidden steps stay mounted (hidden + inert): the requests and timers started on mount are the same whichever step is shown. A LOCKED step stays mounted too; show-all lists it as heading + reason. */}
          <StepPanel railId="s2" stepId="mapping" number={visible2.indexOf("mapping") + 1} title={STAGE2_WIZARD_LABEL.mapping} current={step2Id === "mapping"} showAll={showAllSteps} locked={lockedFor2("mapping")} className="space-y-6">
            {editWarning && <Alert tone="warning"><span data-testid="edit-clears-signoff">{editWarning}</span></Alert>}
            {s2Edit && (
              <div className="flex flex-wrap items-center gap-3" data-testid="step1-first-action">
                <Button variant="secondary" className="min-h-11" onClick={confirmSourceBacked}>Confirm source-backed mappings</Button>
                <span className="text-xs text-slate-700">Confirms the recommended product for every line the price list names. Anything it cannot confirm stays listed above.</span>
              </div>
            )}
            {wizard2.steps.find((x) => x.id === "mapping")!.access === "edit" && q.state !== "MANAGER_APPROVED_FINAL" && mappingOpen.length > 0 && (
              <details open className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="rep-waiting-banner">
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 font-semibold"><span>{q.state === "REP_DRAFT" ? "Needed from you before the Rep can submit" : "Yours to resolve: the Rep has already submitted"}</span><span className="font-normal">· {mappingOpen.length} item{mappingOpen.length === 1 ? "" : "s"}</span></summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 lg:columns-2">{mappingOpen.map((m) => <li key={m} className="break-inside-avoid">{m}</li>)}</ul>
                <p className="mt-1" data-testid="waiting-explain">{q.state === "REP_DRAFT" ? "The Rep cannot submit until these are done. Steps 2 to 4 open once the Rep has submitted." : "These are Estimator items by design. Sign-off stays disabled until they are resolved and the review is marked."}</p>
              </details>
            )}
            <Panel>
              <div className="flex flex-wrap items-center gap-3">
                <PanelTitle>Quote readiness</PanelTitle>
                <Status tone={READY_TONE[rd.state]}>{READINESS_LABEL[rd.state]}</Status>
                {rd.reasons.length > 0 && <span className="text-xs text-slate-700">{rd.reasons.length} open item{rd.reasons.length === 1 ? "" : "s"}</span>}
              </div>
              {rd.reasons.length > 0 && (
                <details className="mt-1" open={mappingOpen.length === 0}>
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-indigo-700">Why it is not READY</summary>
                  {rd.estimatorReasons.length > 0 && <><p className="mt-1 text-xs font-semibold text-slate-800">Estimator&apos;s items (yours)</p><ul className="list-disc space-y-0.5 pl-5 text-sm text-red-700" data-testid="reasons-estimator">{rd.estimatorReasons.map((r) => <li key={r}>{nr(r)}</li>)}</ul></>}
                  {rd.repReasons.length > 0 && <><p className="mt-1 text-xs font-semibold text-slate-800">Rep&apos;s items (the Rep resolves these)</p><ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-800" data-testid="reasons-rep">{rd.repReasons.map((r) => <li key={r}>{nr(r)}</li>)}</ul></>}
                </details>
              )}
              <details className="mt-3">
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-indigo-700">Readiness details</summary>
                <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
                  {(Object.keys(CAT_LABEL) as ReadinessCategory[]).map((c) => (
                    <details key={c} className="rounded-lg border border-slate-200 p-3 open:col-span-2 md:open:col-span-2">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-600">{CAT_LABEL[c]}</span>
                        <Status tone={rd.counts[c] > 0 ? CAT_TONE[c] : "neutral"}>{rd.counts[c]}</Status>
                      </summary>
                      {rd.items[c].length === 0 ? <p className="mt-2 text-xs text-slate-600">None.</p> : (
                        <ul className="mt-2 space-y-1 text-xs text-slate-700">{rd.items[c].map((i, n) => <li key={n}><span className="font-medium">{i.label}</span> — {nr(i.detail)}</li>)}</ul>
                      )}
                    </details>
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-600">Manual-by-design items (feeder / drinker / slat quantities, M75, doors, tank, ventilation scope) only block the quote until the estimator supplies them.</p>
              </details>
            </Panel>

            <Panel>
              <PanelTitle>Line decisions (per room × {cfg.rooms || 0} rooms)</PanelTitle>
              <p className="mt-2 text-sm text-slate-700" data-testid="rep-owned-note">Quantities are the Rep&apos;s (read-only here). You choose the Cin7 product for each line. To change a quantity, return the quotation to the Rep.</p>
              <details className="mt-2 text-sm" data-testid="terms-help">
                <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-indigo-700">What do these terms mean?</summary>
                <dl className="mt-1 max-w-3xl space-y-1 text-slate-800">
                  <div><dt className="inline font-semibold">Source-backed:</dt> <dd className="inline">the price list names a product for this line; it stays a recommendation until you confirm it.</dd></div>
                  <div><dt className="inline font-semibold">Workbook basis:</dt> <dd className="inline">the price comes from the NewQuip price workbook for the chosen pricing basis.</dd></div>
                  <div><dt className="inline font-semibold">Default with override:</dt> <dd className="inline">the system suggests a quantity and the Rep typed a different one, with a reason.</dd></div>
                  <div><dt className="inline font-semibold">Provisional:</dt> <dd className="inline">a temporary value used until a real price or product is confirmed.</dd></div>
                </dl>
              </details>
              <LineDecisionsTable draft={draft} ev={ev} edit={edit} roles={roles} editable={s2Edit} mode="estimator" quantitiesEditable={false} />
            </Panel>

            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PanelTitle>Product mappings</PanelTitle>
              </div>
              <p className="mt-2 text-xs text-slate-600">Source-backed SKUs are recommendations until you confirm them. A historic surrogate (e.g. FERAX for FORTIS 1.2) is never substituted.</p>
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
                        <select aria-label="Door product" value={confirmed ?? ""} onChange={(e) => edit((d) => { if (e.target.value) d.estimator.confirmedMappings.pvc_door = e.target.value; else delete d.estimator.confirmedMappings.pvc_door; })} className="h-11 rounded-md border border-slate-300 bg-white px-2 text-sm">
                          <option value="">Select door product…</option>
                          {manualSelectionSkusFor("pvc_door").map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : isOptionalItemKey(l.itemKey) ? (
                        confirmed ? <Status tone="success">Mapped to {confirmed}</Status> : <Status tone="warning">Not chosen - choose the product in the Line decisions table above</Status>
                      ) : pkg ? (
                        <Status tone={draft.estimator.confirmedPackages.includes(l.itemKey) ? "success" : "warning"}>{draft.estimator.confirmedPackages.includes(l.itemKey) ? "Package confirmed" : "Package unconfirmed"}</Status>
                      ) : (
                        <Status tone={confirmed && confirmed === exp ? "success" : "warning"}>{confirmed && confirmed === exp ? `Confirmed ${confirmed}` : `Recommended ${exp ?? "—"}`}</Status>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            {(budget?.lines ?? []).some((b) => ["unmapped", "not_in_price_source", "supplier_quote_required", "package_unconfirmed", "package_incomplete"].includes(b.status) || b.pricedBy === "estimator_resolution") && (
              <Panel>
                <PanelTitle>Manual quotation prices — exceptions to the approved price source</PanelTitle>
                <p className="mt-2 text-xs text-slate-600">A line the price source cannot price (no SKU yet, not in the workbook, or a zero price needing a supplier quote) is never quoted at R0. Enter the commercial unit price and why (e.g. “Supplier quote dated … for this product; the price source has no usable price”). It is an exceptional quote input: it is labelled as manual wherever it appears, recorded with who entered it and when, shown to the approver, and never written back to Cin7 or the price snapshot. Only an Estimator or Manager can enter one.</p>
                <div className="mt-4 space-y-4">
                  {(budget?.lines ?? []).filter((b) => ["unmapped", "not_in_price_source", "supplier_quote_required", "package_unconfirmed", "package_incomplete"].includes(b.status) || b.pricedBy === "estimator_resolution").map((b) => {
                    const k = b.itemKey as GrowerItemKey;
                    const r = draft.estimator.priceResolutions[k];
                    return (
                      <div key={b.itemKey} className="grid items-end gap-3 md:grid-cols-[minmax(14rem,1.4fr)_minmax(8rem,1fr)_minmax(0,36rem)]">
                        <div><div className="text-sm font-medium text-slate-900">{b.label}</div><div className="text-xs text-amber-700">{nr(b.reason)}</div></div>
                        <NumField label="Unit price" ariaLabel={`Unit price for ${b.label}`} unit="R ex VAT" value={r?.unitPriceExVat ?? null} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: v ?? 0, reason: d.estimator.priceResolutions[k]?.reason ?? "" } }; })} />
                        <TextField label="Reason" ariaLabel={`Reason for the manual price of ${b.label}`} value={r?.reason ?? ""} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: d.estimator.priceResolutions[k]?.unitPriceExVat ?? 0, reason: v } }; })} hint={r && !r.reason.trim() ? "A reason is required before this price is used." : undefined} />
                        {r?.by && <span className="text-xs text-slate-600 md:col-span-3">Entered by {r.by}{r.at ? ` at ${formatSast(r.at)}` : ""}</span>}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            {!canCommercials && scopePanel}
            {!canCommercials && totalsPanel}
          </StepPanel>

          {canCommercials && (
            <StepPanel railId="s2" stepId="costs" number={visible2.indexOf("costs") + 1} title={STAGE2_WIZARD_LABEL.costs} current={step2Id === "costs"} showAll={showAllSteps} locked={lockedFor2("costs")} className="space-y-6">
              {editWarning && <Alert tone="warning"><span data-testid="edit-clears-signoff-costs">{editWarning}</span></Alert>}
              <Disclosure testId="disc-cost-capture" title="Cin7 cost capture and FX rates" summary={costingIncomplete ? (marginInfo && marginInfo.missing > 0 ? `Costs are incomplete for ${marginInfo.missing} line${marginInfo.missing === 1 ? "" : "s"}: capture or enter them here` : `Costing is incomplete: ${costingReason ?? "supplier costs are unresolved"}`) : "Latest supplier prices from Cin7, exchange rates and exceptions"} attention={costingIncomplete}>
                {final ? <CostPanel quoteId={id} /> : <CostPanel quoteId={id} unsaved={dirty} previewDraft={dirty ? previewedFor : null} />}
              </Disclosure>
              {marginInfo && marginInfo.exempt.length > 0 && <p className="text-sm text-slate-800" data-testid="est-priced-note">Estimator-priced (no supplier cost by design): {marginInfo.exempt.join("; ")}. They keep the margin indicative; they are not missing costs.</p>}
              {totalsPanel}
              {/* The detail sits in labelled disclosures (closed unless something needs attention); they stay mounted, so nothing is requested differently. */}
              <Disclosure testId="disc-scope" title="Physical scope" summary="What will be supplied and installed, line by line (read-only evidence)">{scopePanel}</Disclosure>
              {budget && (
                <Disclosure testId="disc-margin" title="Margin detail" summary={marginIncomplete ? `${marginLabel}: ${marginNote}` : "Product, package, section and project margins (price-list basis)"} attention={marginIncomplete || incompleteOverrides}>
                  <div aria-busy={recalculating}><MarginPanel budget={budget} draft={draft} final={final} frozen={q.accepted_baseline?.internalMargin} editable={s2Edit} edit={edit} /></div>
                </Disclosure>
              )}
              {!final && <Alert tone="info">SKU mapping and the Cin7 latest-supplier-price capture work on the frozen physical scope, so they open for the Estimator once the quotation is approved. Until then the estimator review above, the margin sheet and the readiness items are the costing evidence.</Alert>}
            </StepPanel>
          )}
        </fieldset>

        {canCommercials && (
          <StepPanel railId="s2" stepId="final" number={visible2.indexOf("final") + 1} title={STAGE2_WIZARD_LABEL.final} current={step2Id === "final"} showAll={showAllSteps} locked={lockedFor2("final")} className="mt-6 space-y-6">
            <Panel>
              <h3 className="sr-only">Final review</h3>
              <div className="mt-3" data-testid="cost-ack">
                {costNeedsMark && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Button type="button" id="cost-ack-btn" aria-describedby="cost-ack-explain" className="min-h-11" onClick={markReviewed}>Mark reviewed &amp; continue</Button>
                    <p id="cost-ack-explain" className="min-w-0 flex-1 text-sm text-slate-800">{ACK_EXPLAIN}</p>
                  </div>
                )}
                {costAcknowledged && <p id="cost-ack-done" tabIndex={-1} className="text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" data-testid="cost-ack-done">Marked reviewed for this session (not saved - repeat after a reload before signing off). It is not a sign-off.</p>}
                {finalStepDone && !costAcknowledged && <p className="text-sm font-semibold text-emerald-900" data-testid="final-reviewed"><span aria-hidden>✓ </span>{final ? "Reviewed and approved." : "Reviewed: the Estimator sign-off is current."}</p>}
                {finalBlocked && (
                  <div className="space-y-2">
                    <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="cost-ack-blocked">{finalBlockText}</p>
                    {isEstimator && q.state === "ESTIMATOR_REVIEW" && <p className="text-sm text-slate-800">If it has to go back instead, use <button type="button" className="inline-flex min-h-11 items-center font-semibold text-indigo-700 underline" onClick={() => goStep2Id("signoff")}>Sign-off or return</button> to return it to the Rep.</p>}
                  </div>
                )}
              </div>
              {commercial && !commercial.complete && (
                <details open className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="not-commercially-ready">
                  <summary className="flex min-h-11 cursor-pointer items-center font-semibold">{commercial.headline}</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{commercial.items.map((x) => <li key={x.text}><b>{x.owner}:</b> {x.text}</li>)}</ul>
                </details>
              )}
              {isEstimator && q.state === "ESTIMATOR_REVIEW" && <div className="mt-4" data-testid="bx-note"><BaselineExceptionNote view={view.baselineException} /><UnmappedTypedPriceNote view={view.baselineException} /></div>}
              {costingSrv?.acceptedIncomplete && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="costing-accepted-incomplete">{costingAcceptedIncompleteText(costingSrv.acceptedIncomplete)}</p>}
              <FinalReviewChecklist items={finalChecklist} />
              {isEstimator && q.state === "ESTIMATOR_REVIEW" && <p className="mt-3 text-xs text-slate-700" data-testid="session-only-note">&ldquo;Mark reviewed&rdquo; is kept on this screen for this session only: it is not saved, and after a reload you mark it again. Signing off needs it in the same session, so repeat it after a reload. Returning the quote to the Rep never does.</p>}
            </Panel>
          </StepPanel>
        )}

        <StepPanel railId="s2" stepId="signoff" number={visible2.indexOf("signoff") + 1} title={STAGE2_WIZARD_LABEL.signoff} current={step2Id === "signoff"} showAll={showAllSteps} locked={lockedFor2("signoff")} className="mt-6 space-y-6">
          <Panel>
            <h3 className="sr-only">Sign off or return</h3>
            {editWarning && <div className="mt-1"><Alert tone="warning"><span data-testid="edit-clears-signoff-signoff">{editWarning}</span></Alert></div>}
            <div className="mt-1 space-y-4">
              {q.state === "REP_DRAFT" && <p className="text-sm text-slate-800" data-testid="signoff-waiting">Not submitted yet: the Estimator signs off or returns it after the Rep has submitted.</p>}
              {final && <Status tone="success">Signed off and approved</Status>}
              {q.state === "ESTIMATOR_REVIEW" && (q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash ? (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3" role="status" data-testid="signoff-success">
                  <span className="flex min-w-0 flex-wrap items-center gap-2"><Status tone="success">Estimator sign-off complete</Status><span className="min-w-0 break-words text-sm text-slate-800">{q.estimator_signoff_by_email ?? "estimator"}{q.estimator_signoff_at ? `, ${formatSast(q.estimator_signoff_at)}` : ""}</span></span>
                  <p className="mt-2 text-sm text-slate-900" data-testid="signoff-next-owner">Next responsible role: <b>Manager</b>. The Manager approves or returns it in Stage 3.</p>
                  <Button type="button" className="mt-3 min-h-11" onClick={() => goStage(3)}>Open Manager approval (Stage 3)</Button>
                </div>
              ) : (
                <>
                  {isEstimator ? (
                    <div>
                      <Button loading={isWorking} className="min-h-11" aria-describedby={signoffBlockers.length ? "signoff-why" : "signoff-effect"} disabled={!roles.has("estimator") || rd.state !== "READY" || signoffNeedsReview || costingIncomplete || amountChange.changed} onClick={() => act(() => signOffGrowerQuoteAction(id), "Estimator sign-off recorded for this exact content.", "signoff", (v) => !!v.quote.estimator_signoff_hash && v.quote.estimator_signoff_hash === v.quote.draft_hash)}>Sign off for Manager approval</Button>
                      <p id="signoff-effect" className="mt-1 text-xs text-slate-700" data-testid="signoff-effect">Signs off this version for the Manager. Any later edit withdraws it.</p>
                      {signoffBlockers.length > 0 && <ul id="signoff-why" className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700" data-testid="signoff-blockers">{signoffBlockers.map((b) => <li key={b}>{b}</li>)}</ul>}
                    </div>
                  ) : <p className="text-sm text-slate-700" data-testid="signoff-not-yours">{wizard2.statusLine} Only an Estimator can sign off or return it here.</p>}
                  {isEstimator && (
                    <section className="rounded-lg border border-slate-200 p-4" aria-label="Return to the Rep" data-testid="return-section">
                      <h3 className="text-sm font-semibold text-slate-900">Or return it to the Rep</h3>
                      <p className="mt-1 text-sm text-slate-800" data-testid="return-next-owner">Next responsible role: <b>Rep</b>. The quotation comes back as a new revision and the Rep submits it again once the correction is made.</p>
                      <div className="mt-3 max-w-2xl"><TextField label="Return to rep — reason" value={returnReason} onChange={setReturnReason} hint="Say what the Rep must correct. It is recorded in the Approval history, where the Rep reads it." /></div>
                      <div className="mt-3">
                        <Button variant="secondary" className="min-h-11" loading={isWorking} aria-describedby={returnWhy ? "return-rep-why" : undefined} disabled={!returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToRepAction(id, returnReason), "Returned to the rep as a new revision.", "signoff", (v) => v.quote.state === "REP_DRAFT")}>Return to rep</Button>
                      </div>
                      <div className="mt-1"><DisabledReason id="return-rep-why">{returnWhy}</DisabledReason></div>
                    </section>
                  )}
                </>
              ))}
            </div>
            <ActionFeedback state={acts.stateOf("signoff")} />
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mt-1 text-xs text-slate-600">The Estimator signs off for the Manager or returns the quote to the Rep. This is not the customer&apos;s formal acceptance, which comes after Manager approval.</p>
              {handoffFacts}
            </div>
          </Panel>
        </StepPanel>

        {!showAllSteps && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-end justify-between gap-3 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-6 md:px-6" data-testid="step-buttons">
          {step2Cur > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep2Id(visible2[step2Cur - 2])}>Back</Button> : <span />}
          {(() => {
            const nextId = visible2[step2Cur];
            if (!nextId) return <span />;
            const nx = step2Access(nextId);
            if (nx.access === "locked") return (
              <div className="flex max-w-xl flex-col items-end gap-1">
                <Button type="button" className="min-h-11" disabled aria-describedby="next-why">Next: {STAGE2_WIZARD_LABEL[nextId]}</Button>
                <p id="next-why" className="text-right text-sm text-amber-900" data-testid="next-blocked">{nx.blockedBy.join(" ")}</p>
              </div>
            );
            // On Final review there is NO plain Next for the Estimator until the review is marked: "Mark reviewed & continue" (in the panel) is the only way forward. A viewer who cannot mark it just navigates.
            if (step2Id === "final" && (costNeedsMark || (finalBlocked && isEstimator))) return <span />;
            // A viewer who cannot act here (Manager, observer) only INSPECTS: the way on is secondary and records nothing. A Rep has nothing to do in Stage 2 at all: no way on, only back to their own stage.
            if (!isEstimator && !roles.has("manager") && roles.has("rep")) return <span />;
            return <Button type="button" variant={isEstimator ? "primary" : "secondary"} className="min-h-11" onClick={() => goStep2Id(nextId)}>Next: {STAGE2_WIZARD_LABEL[nextId]}</Button>;
          })()}
          {!isEstimator && !roles.has("manager") && roles.has("rep") && <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStage(1)}>Return to Stage 1</Button>}
        </div>
        )}
        </>
      )}

      {/* ───────────── 3 · MANAGER APPROVAL (a read-only signed-off workspace and the Manager's decision; nothing editable) ───────────── */}
      {stage === 3 && (
        <div className="mt-6 space-y-6" data-testid="stage3-workspace">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm" data-testid="stage3-owner">
            <span className="font-semibold text-slate-900">Stage 3 is the Manager&apos;s decision.</span>
            <span role="status" aria-live="polite" className="text-slate-800" data-testid="stage3-status-line">{wizard3.statusLine}</span>
            <OwnerTag role={wizard3.nextOwner} />
          </div>
          {commercial && !commercial.complete && <Alert tone="warning"><span data-testid="s3-commercial">{commercial.headline}</span></Alert>}
          {repSummary}
          <EstimatorResult signedOffBy={q.estimator_signoff_by_email} signedOffAt={q.estimator_signoff_at} signoffCurrent={s2Base.signoff === "current"} totalCents={totalCents} confirmedCents={q.customer_confirmed_cents}
            costing={canCommercials && budget ? { estimatedCost: budget.totals.estimatedCost, marginPct: budget.totals.overallMarginPct } : null} priceExceptions={priceExceptions} costOverrides={costOverrideRows} showPriceDetail={canCommercials}
            marginUnknown={canCommercials && !!budget && (marginIncomplete || budget.incomplete || budget.totals.overallMarginPct == null)} missingCostLines={marginIncomplete && marginInfo!.missing > 0 ? marginInfo!.missing : null} estimatorPricedLines={marginInfo?.exempt.length ?? 0} largestLines={canCommercials ? largestLines : null} />
          <Panel>
            <PanelTitle>Manager approval</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Final internal commercial approval. The Rep sees the outcome here and by notification; only a Manager can decide.</p>
            {q.state === "ESTIMATOR_REVIEW" && <ApprovalChecklist items={approvalChecklist} onGoStage={goStage} />}

            {approveNotReady && <div id={`${uid}-approve-notready`}><Alert tone="danger"><span data-testid="approve-not-ready">{rd.state !== "READY" ? <>Approval is disabled: the quotation is not ready. {rd.reasons[0] ?? "Open items remain."}{rd.reasons.length > 1 ? ` (+${rd.reasons.length - 1} more)` : ""}</> : null}{approveCostingOpen ? <>{rd.state !== "READY" ? " " : ""}Approval is disabled: costing is incomplete. {costingSrv!.reason ?? "Supplier costs are unresolved."}</> : null}{commercial && !commercial.complete ? ` ${commercial.headline}.` : ""} Return it to the Estimator to resolve them.</span></Alert></div>}
            {approveSignoffMissing && <div id={`${uid}-approve-signoff`}><Alert tone="info">Waiting for the Estimator&apos;s sign-off before the Manager can decide.</Alert></div>}
            {approveSignoffStale && <div id={`${uid}-approve-stale`}><Alert tone="warning">The Estimator&apos;s sign-off no longer matches the current quotation. It must be given again before the Manager can decide.</Alert></div>}
            {q.state === "ESTIMATOR_REVIEW" && dirty && <div id={`${uid}-approve-dirty`}><Alert tone="warning" >You have unsaved edits. Save or discard your edits first: approval applies to the saved quotation.</Alert></div>}
            <div className="mt-5 space-y-3 border-t border-slate-100 pt-5">
              {q.state === "ESTIMATOR_REVIEW" && (
                <>
                  {roles.has("manager") && <div className="max-w-xl"><TextField label="Return to rep — reason" value={returnReason} onChange={setReturnReason} hint="Required only when you return the quotation instead of approving it. Say what must be corrected; it is recorded in the Approval history." /></div>}
                  {view.baselineException && <BaselineExceptionBlock view={view.baselineException} revision={q.revision} draftHash={q.draft_hash} pending={acts.isPending("approve")}
                    canDecide={!isWorking && roles.has("manager") && !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash && !dirty}
                    blockedWhy={!roles.has("manager") ? "Only a Manager can accept this exception." : !q.estimator_signoff_hash || q.estimator_signoff_hash !== q.draft_hash ? "Waiting for the Estimator's sign-off on the current quotation." : dirty ? "Save or discard your edits first." : isWorking ? "Another action is in progress. Please wait." : undefined}
                    onApprove={(request) => act(() => approveGrowerQuoteAction(id, { baselineException: request }), "Approved with a recorded exception. The accepted baseline is frozen; the Project can now be created.", "approve", (v) => v.quote.state === "MANAGER_APPROVED_FINAL")} />}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant={bxRequired ? "secondary" : "primary"} className="min-h-11" loading={acts.isPending("approve")} disabled={isWorking || !roles.has("manager") || !q.estimator_signoff_hash || q.estimator_signoff_hash !== q.draft_hash || dirty || approveNotReady || bxRequired || bxBlocking.length > 0} aria-describedby={[approveDescribedBy, bxRequired && `${uid}-approve-bx`, bxBlocking.length > 0 && `${uid}-approve-map`].filter(Boolean).join(" ") || undefined}
                      onClick={() => act(() => approveGrowerQuoteAction(id), "Approved. The accepted baseline is frozen; the Project can now be created.", "approve", (v) => v.quote.state === "MANAGER_APPROVED_FINAL")}>Manager: final approval</Button>
                    {roles.has("manager") && (<>
                      <Button variant="secondary" className="min-h-11" aria-describedby={returnWhy ? "return-mgr-why" : undefined} disabled={isWorking || !returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToRepAction(id, returnReason), "Returned to the rep as a new revision.", "approve", (v) => v.quote.state === "REP_DRAFT")}>Return to rep (reject)</Button>
                      {q.estimator_signoff_hash && (
                        <Button variant="secondary" className="min-h-11" aria-describedby={returnWhy ? "return-mgr-why" : undefined} disabled={isWorking || !returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToEstimatorAction(id, returnReason), "Returned to the estimator. Their sign-off is withdrawn and must be given again; the quote and its history are kept.", "approve", (v) => !v.quote.estimator_signoff_hash)}>Manager: return to estimator</Button>
                      )}
                    </>)}
                  </div>
                  {roles.has("manager") && <p className="text-xs text-slate-700" data-testid="return-owners">Return to rep: the Rep corrects it (new revision), then submits it again. Return to estimator: the Estimator&apos;s sign-off is withdrawn and they review again.</p>}
                  {bxBlocking.length > 0 && <DisabledReason id={`${uid}-approve-map`}>Approval is unavailable: {bxBlocking.map((b) => b.label).join(", ")} {bxBlocking.length === 1 ? "needs" : "need"} an active library mapping. The Manager exception covers only M75 / penning systems{(view?.baselineException?.items.length ?? 0) > 0 ? ", and is offered only once these are mapped" : ""}.</DisabledReason>}
                  {bxRequired && <DisabledReason id={`${uid}-approve-bx`}>Plain approval is unavailable: an approval exception is required (see above). Use &quot;Approve with recorded exception&quot;.</DisabledReason>}
                  {isWorking && <DisabledReason id={`${uid}-approve-busy`}>Another action is in progress. Please wait.</DisabledReason>}
                  {roles.has("manager") && <DisabledReason id="return-mgr-why">{returnWhy ? `Return buttons: ${returnWhy.charAt(0).toLowerCase()}${returnWhy.slice(1)}` : undefined}</DisabledReason>}
                  {!roles.has("manager") && <p id={`${uid}-approve-role`} className="text-sm text-slate-700">Final approval needs the Manager role.</p>}
                </>
              )}
              {q.state === "REP_DRAFT" && <p className="text-sm text-slate-700">This quotation is with the Rep ({q.revision > 1 ? "returned as a new revision" : "not yet sent for review"}).</p>}
              {final && <Status tone="success">Manager approved — final</Status>}
            </div>
            <ActionFeedback state={acts.stateOf("approve")} />
          </Panel>
          <Panel>
            <PanelTitle>Approval history and decisions</PanelTitle>
            <div className="mt-2"><ApprovalHistory docType="QUOTE" docId={id} label="Show the timestamped approval history (also on the Approvals page)" /></div>
          </Panel>
        </div>
      )}

      {/* ───────────── 4 · CUSTOMER QUOTATION ───────────── */}
      {hold(stage) && (
        <div className="mt-6" data-testid="stage-loading">
          {gateError
            ? <Alert tone="danger">{gateError} <button type="button" className="ml-2 underline" onClick={() => { setGateError(null); setGateTry((n) => n + 1); }}>Try again</button></Alert>
            : <p className="text-sm text-slate-600" role="status">Loading the current status of this quotation…</p>}
        </div>
      )}
      {stage === 4 && !hold(4) && (
        <div className="mt-6 space-y-6">
          {!final && <Alert tone="info">The customer quotation can be issued only after the Manager has approved. Below is the customer-facing summary as it stands.</Alert>}
          {final && q.accepted_baseline && (
            <StepRail id="s4" ariaLabel="Customer quotation steps" steps={stage4} currentId={step4Id} onSelect={(sid) => goStep4No(STAGE4_STEP_IDS.indexOf(sid as Stage4StepId) + 1)}
              actions={(
                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAllSteps} onChange={(e) => setShowAllSteps(e.target.checked)} /> Show all steps</label>
                  {next4Open
                    ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep4No(STAGE4_STEP_IDS.indexOf(next4Open as Stage4StepId) + 1)}>Next incomplete step</Button>
                    : <span className="text-sm text-slate-700" data-testid="all-steps-complete">Every step is complete.</span>}
                </div>
              )} />
          )}
          {final && q.accepted_baseline && <DeliveryPanel quoteId={id} contractCents={q.accepted_baseline.contractCents} onGate={applyGate} section="quotation" steps={{ current: step4Id, showAll: showAllSteps }} />}
          {final && q.accepted_baseline && !showAllSteps && (
            <div className="flex items-center justify-between gap-3" data-testid="step-buttons">
              {step4No > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep4No(step4No - 1)}>Back</Button> : <span />}
              {step4No < STAGE4_STEP_IDS.length ? <Button type="button" className="min-h-11" onClick={() => goStep4No(step4No + 1)}>Next</Button> : <span />}
            </div>
          )}
        <Panel>
          {!summary ? (
            <Alert tone="warning">The customer summary appears once the quote is complete (READY). Resolve the items on the Estimator review tab.</Alert>
          ) : (
            <div className="mx-auto max-w-3xl">
              <p className="text-xs uppercase tracking-wide text-slate-600">Newquip Agri Supplies · Quotation {q.quote_ref}{q.revision > 1 ? ` (revision ${q.revision})` : ""}</p>
              <h2 className="mt-1 text-xl font-bold text-slate-900">Grower house — {draft.siteName}</h2>
              <p className="text-sm text-slate-600">Prepared for {draft.customerName} · {cfg.rooms} room{cfg.rooms === 1 ? "" : "s"}</p>
              <table className="mt-5 w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600"><th className="py-2 text-left">Scope</th><th className="py-2 text-right">Amount (ex VAT)</th></tr></thead>
                <tbody>
                  {summary.sections.map((s) => (
                    <tr key={s.title} className="border-b border-slate-100 align-top"><td className="py-3 pr-4"><div className="font-medium text-slate-900">{s.title}</div><div className="text-xs text-slate-600">{s.scope}</div></td><td className="py-3 text-right tabular-nums whitespace-nowrap">{fmtZar(s.amountExVat)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td className="pt-3 text-right text-slate-600">Subtotal</td><td className="whitespace-nowrap pt-3 text-right tabular-nums">{fmtZar(summary.subtotalExVat)}</td></tr>
                  <tr><td className="text-right text-slate-600">VAT 15%</td><td className="whitespace-nowrap text-right tabular-nums">{fmtZar(summary.vat)}</td></tr>
                  <tr><td className="pt-1 text-right font-semibold text-slate-900">Total</td><td className="whitespace-nowrap pt-1 text-right text-lg font-bold tabular-nums">{fmtZar(summary.totalIncVat)}</td></tr>
                </tfoot>
              </table>
              {draft.estimator.assumptions.trim() && <p className="mt-4 text-xs text-slate-600"><strong>Assumptions:</strong> {draft.estimator.assumptions}</p>}
              {Object.entries(cfg.exclusions ?? {}).filter(([, r]) => r.trim()).length > 0 && <p className="mt-2 text-xs text-slate-600"><strong>Excluded at your request:</strong> {Object.keys(cfg.exclusions ?? {}).filter((k) => cfg.exclusions![k as GrowerItemKey]?.trim()).join(", ").replace(/_/g, " ")}</p>}
              <p className="mt-6 text-xs text-slate-600">Summary view — individual stock lines are kept on the internal estimator view. Not an e-signature; acceptance is recorded by the manager&apos;s final approval.</p>
            </div>
          )}
        </Panel>
        </div>
      )}

      {/* ───────────── 5 · CUSTOMER ACCEPTANCE ───────────── */}
      {stage === 5 && !hold(5) && (
        <div className="mt-6 space-y-6">
          {!final && <Alert tone="info">Customer acceptance is recorded against the issued, Manager-approved quotation. It becomes available once the quotation has been issued.</Alert>}
          {final && !gate.requires && !acceptanceBanner && <Alert tone="info">This quotation was approved before customer acceptance was introduced, so it is grandfathered: a Project does not depend on a recorded acceptance. A response can still be recorded if the customer gives one.</Alert>}
          {final && acceptanceBanner && <AcceptanceStatusBanner banner={acceptanceBanner} />}
          {final && q.accepted_baseline && <AcceptancePanel quoteId={id} onGate={applyGate} />}
        </div>
      )}

      {/* ───────────── 6 · PROJECT HANDOVER ───────────── */}
      {stage === 6 && !hold(6) && (
        <div className="mt-6 space-y-6">
          {final && q.accepted_baseline && (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-900" data-testid="stage6-next">
              {q.project_id ? "Project created. Next: run billing and fulfilment in the Project."
                : !roles.has("manager") ? "Next: the Manager creates the Project from the accepted quotation."
                : gate.requires && !gate.accepted ? "Next: the customer's verified acceptance (Stage 5) is needed before you can create the Project."
                : "Next: create the Project from the accepted quotation (the button below)."}
            </p>
          )}
          {!final || !q.accepted_baseline ? <Alert tone="info">Project handover opens once the quotation is approved{gate.requires ? " and the customer has accepted the issued quotation" : ""}. The full Projects module is not duplicated here.</Alert> : (
                      <Panel>
              <PanelTitle>Accepted commercial baseline (frozen)</PanelTitle>
              <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                {[
                  ["Total contract value (ex VAT)", fmtCents(q.accepted_baseline.contractCents)],
                  ["Template", `${q.accepted_baseline.template.name} v${q.accepted_baseline.template.version}`],
                  ["Rule set", q.accepted_baseline.template.rulesetVersion],
                  ["Quote revision", String(q.accepted_baseline.quote.revision)],
                  ["Price source", q.accepted_baseline.pricing.source.label],
                  ["Pricing basis", view.viewer.canViewCommercials ? q.accepted_baseline.pricing.basis : QUOTE_TYPE_NEUTRAL[draft.quoteType]],
                  ["Overrides · exclusions · price resolutions", `${q.accepted_baseline.overrides.length} · ${q.accepted_baseline.exclusions.length} · ${q.accepted_baseline.priceResolutions.length}`],
                  ...(view.viewer.canViewCommercials && q.accepted_baseline.physicalCostEstimate?.incomplete && q.accepted_baseline.physicalCostEstimate.costBasis?.incompleteAccepted ? [["Costing", costingAcceptedIncompleteText(q.accepted_baseline.physicalCostEstimate.costBasis.incompleteAccepted)]] : []),
                  ["Seal (sha256)", `${(q.baseline_hash ?? "").slice(0, 16)}…`],
                ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-600">{k}</dt><dd className="mt-0.5 break-words font-medium text-slate-900">{v}</dd></div>)}
              </dl>
              <BaselineExceptionsSummary exceptions={q.accepted_baseline.exceptions} />
              <p className="mt-3 text-xs text-slate-600">Cin7: <strong>NOT SENT TO CIN7</strong> — the push to Cin7 comes later and is not part of the POC.</p>

              <p className="mt-2 text-xs text-slate-600">Customer: {draft.customerName || "—"} · Cin7 customer reference is taken from the latest customer snapshot when the Project is created. Physical SKU mappings are frozen with the baseline; the Project, its billing stages and the Cin7 Sale are managed in the Projects module.</p>
              <div className="mt-5 border-t border-slate-100 pt-5">
                {!q.project_id && <HandoverChecklist items={handoverReadiness} onGoStage={goStage} />}
                {q.project_id ? (
                  <Link href={`/projects/${q.project_id}`} className="inline-flex h-9 items-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">Open the Project</Link>
                ) : gate.requires && !gate.accepted ? null /* the checklist above says why (with the link to Stage 5) */
                : (
                  <>
                  {gate.requires ? <p className="mb-2 text-sm text-slate-600">The Project will use the billing schedule printed on the quotation the customer accepted.</p> : <ScheduleChooser contractCents={q.accepted_baseline.contractCents} onChange={setScheduleChoice} />}
                  {!roles.has("manager") ? <Alert tone="info">A Manager creates the Project from the accepted quotation after verifying the customer&apos;s acceptance. You will be able to open it from here once it exists.</Alert> : <Button loading={acts.isPending("handover")} className="min-h-11" aria-describedby={isWorking || (!gate.requires && !resolveScheduleChoice(scheduleChoice).ok) ? "handover-why" : undefined} disabled={isWorking || (!gate.requires && !resolveScheduleChoice(scheduleChoice).ok)} onClick={() => void acts.run("handover", async () => {
                    const r = await createProjectFromGrowerQuoteAction(id, scheduleChoice);
                    if (!r.ok) return r;
                    setError(null);
                    const v = await getGrowerQuoteAction(id);
                    if (v.ok && v.data) adopt(v.data);
                    return r;
                  }, {
                    pending: "Creating the Project from the accepted baseline…",
                    success: (r) => { const made = r.data; return `Project ${made?.created === false ? "already existed (its stages were not changed)" : "created from the accepted baseline (no engineering recalculation)"}. Billing stages: ${(made?.stages ?? []).map((x) => `${x.name} ${fmtCents(x.valueCents)}`).join(" · ") || "none"}.`; },
                    // A lost response: look for the Project before suggesting another attempt (creating it twice is harmless but confusing).
                    reconcile: async () => { const v = await getGrowerQuoteAction(id); if (!v.ok || !v.data) return "unknown"; if (v.data.quote.project_id) { adopt(v.data); return "done"; } return "not_done"; },
                    doneAfterReconcile: "The Project exists (the response was lost, but it was created).",
                  })}>Create Project from accepted quote</Button>}
                  {roles.has("manager") && <DisabledReason id="handover-why">{isWorking ? "Another action is in progress. Please wait." : !gate.requires && !resolveScheduleChoice(scheduleChoice).ok ? "Fix the billing schedule above (the stages must add up to the contract value) before creating the Project." : undefined}</DisabledReason>}
                  <ActionFeedback state={acts.stateOf("handover")} />
                  </>
                )}
              </div>
            </Panel>
          )}
          <p className="text-xs"><BuildStamp /></p>
        </div>
      )}
      <details className="mt-6 text-xs text-slate-600" data-testid="provenance"><summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-slate-700">Price source &amp; provenance</summary>
        <p className="mt-1">Grower House Template v1 · {view.viewer.canViewCommercials ? QUOTE_TYPE_LABEL[draft.quoteType] : QUOTE_TYPE_NEUTRAL[draft.quoteType]} · {budget?.priceSource.label ?? "NewQuip Master workbook – POC controlled snapshot"}</p>
        {budget && <p className="mt-1">{budget.priceSource.notice} Provenance: {budget.priceSource.provenance}</p>}</details>
      {view.viewer.previewTools && editable && stage <= 2 && (
        <details className="mt-8 max-w-4xl rounded-lg border border-dashed border-slate-400 px-3 py-1 text-sm" data-testid="preview-tools">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-slate-800">Testing utility (Preview only)</summary>
          <p className="mt-2 text-slate-700">Replaces the inputs of this draft (the selected customer is kept) with the demonstration quotation. It is not saved, and it never submits, approves, signs off, creates a Project or writes to Cin7. It exists on Preview deployments only.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!confirmDemo && <Button variant="secondary" className="min-h-11" onClick={() => (hasEntries(draft) ? setConfirmDemo(true) : loadDemo())}>Load whole demonstration quote</Button>}
            {confirmDemo && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                <span>This replaces the values in this draft with the demonstration quotation (nothing is saved until you press Save draft). The customer you selected is kept.</span>
                <Button size="sm" className="min-h-11" onClick={loadDemo}>Replace with demo</Button>
                <Button size="sm" variant="secondary" className="min-h-11" onClick={() => setConfirmDemo(false)}>Cancel</Button>
              </div>
            )}
          </div>
          {demoLoaded && (
            <div className="mt-3">
              <Alert tone={rd.state === "READY" ? "success" : "warning"}>
                Demo defaults loaded into this draft ({DEMO_DEFAULTS_SOURCE}) {demoLoaded.length ? `Replaced: ${demoLoaded.join(", ")}.` : "The draft already matched the demonstration; nothing changed."}{" "}
                Status: {READINESS_LABEL[rd.state]}.{rd.reasons.length ? ` Open: ${rd.reasons.join("; ")}.` : ""}
                {" "}Prices marked MANUAL QUOTATION PRICE are the demonstration quote&apos;s own estimator values. Not saved, approved, frozen or sent anywhere.
              </Alert>
            </div>
          )}
        </details>
      )}
    </main>
  );
}
