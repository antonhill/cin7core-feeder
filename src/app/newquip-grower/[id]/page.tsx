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
import {
  approveGrowerQuoteAction, createProjectFromGrowerQuoteAction, getGrowerQuoteAction, previewGrowerDraftAction, returnGrowerQuoteToEstimatorAction, returnGrowerQuoteToRepAction,
  saveGrowerDraftAction, sendGrowerQuoteToEstimatorAction, signOffGrowerQuoteAction, type QuoteView,
} from "../actions";
import { formatSast } from "@/lib/approvals/time";
import { isOptionalItemKey } from "@/newquip/grower/types";
import { mappingControlFor } from "@/newquip/grower/mapping-access";
import { blankExclusions, createRecalcLoop } from "@/newquip/grower/preview-draft";
import { previewCostOverrides } from "@/newquip/quote/margin";
import { ProductMappingPicker } from "./ProductMappingPicker";
import { fmtCents, fmtZar, NumField, TextField } from "../fields";
import { formatZar } from "@/lib/format-money";
import { MarginPanel } from "./MarginPanel";
import { BuildStamp } from "@/components/BuildStamp";
import { ScheduleChooser } from "./ScheduleChooser";
import { CostPanel } from "./CostPanel";
import { CustomerPanel } from "./CustomerPanel";
import { Stage1Review } from "./Stage1Review";
import { StepRail, StepPanel } from "@/components/ui/StepRail";
import { useShowAllSteps } from "@/components/ui/use-show-all-steps";
import { nextIncompleteStepId, parseStepParam } from "@/components/ui/step-rail-model";
import { deriveStage1Steps, NO_CUSTOMER_FACTS, STAGE1_STEP_IDS, STAGE1_STEP_LABEL, type Stage1CustomerFacts, type Stage1StepId } from "@/newquip/quote/stage1-steps";
import { costAckKey, deriveStage2Steps, nextCandidates, type Stage2Input, stage2StepIds, STAGE2_STEP_LABEL, type Stage2StepId } from "@/newquip/quote/stage2-steps";
import { ConfirmationPanel } from "./ConfirmationPanel";
import { DeliveryPanel, type DeliveryGate } from "./DeliveryPanel";
import { StageNav } from "./StageNav";
import { AcceptancePanel } from "./AcceptancePanel";
import { computeStages, currentStage, parseStage, type CommercialState, type StageId } from "@/newquip/quote/stages";
import { getQuoteDeliveryAction } from "../delivery-actions";
import { ScopePanel } from "./ScopePanel";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { DisabledReason } from "@/components/ApprovalDisabledReason";
import { resolveScheduleChoice, type ScheduleChoice } from "@/newquip/quote/billing-schedule";

// NewQuip Grower quote editor, in six stages: 1 Configuration → 2 Costing & Estimator Review → 3 Manager Approval → 4 Customer Quotation → 5 Customer Acceptance → 6 Project Handover.
// The stage is a PRESENTATION derived from the quotation's existing state and immutable records (see src/newquip/quote/stages.ts); every action is still authorised on the server.
// (Original note:) The browser holds only the
// editable DRAFT; every number shown comes from the server's evaluateDraft(), and approval re-evaluates on the server again.

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
const PIG_SIZE_LABEL: Record<PenningPigSize, string> = { SMALL: `Small — ${formatZar(1300)} / rm`, MEDIUM: `Medium — ${formatZar(1500)} / rm`, LARGE: `Large — ${formatZar(2200)} / rm` };
const OPTIONAL_LABELS: Record<OptionalItemKey, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows",
  pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};
const CHARGE_HELP: Record<ChargeKey, string> = {
  delivery: "From the courier invoice — truck size × truck price; distance affects it.",
  installation: "From the teams' service reports — days × daily rate.",
  concrete_slat_delivery: "Truck price ÷ slat weight, by distance.",
};


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
  const [stepNo, setStepNo] = useState<number>(() => (parseStage(search.get("stage")) === 2 ? 1 : parseStepParam(search.get("step"), STAGE1_STEP_IDS.length)));
  // Stage 2 has its own step number but SHARES the "Show all steps" preference (one setting for the builder, one storage key).
  const [step2No, setStep2No] = useState<number>(() => (parseStage(search.get("stage")) === 2 ? parseStepParam(search.get("step"), 5) : 1));
  // "Mark reviewed & continue" on Cost & margin: a CLIENT-LOCAL acknowledgement, never stored and never a sign-off. It holds a key built from the version it was given on; any change makes it stale.
  const [costAck, setCostAck] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null); // which acknowledgement may be announced; cleared after a few seconds and when the step changes
  useEffect(() => { if (!ackFor) return; const t = setTimeout(() => setAckFor(null), 6000); return () => clearTimeout(t); }, [ackFor]);
  const [showAllSteps, setShowAllSteps] = useShowAllSteps("nq-builder-show-all");
  const [customerFacts, setCustomerFacts] = useState<Stage1CustomerFacts>(NO_CUSTOMER_FACTS);
  const onCustomerFacts = (f: Stage1CustomerFacts) => setCustomerFacts((p) => (p.loaded === f.loaded && p.available === f.available && p.hasSnapshot === f.hasSnapshot && p.hasContact === f.hasContact && p.contactName === f.contactName && p.loadError === f.loadError ? p : f));
  const [error, setError] = useState<string | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [demoLoaded, setDemoLoaded] = useState<string[] | null>(null);
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

  // A ?step= beyond this viewer's steps (a Rep has three) is shown as step 1 (everything reads the clamped step) and dropped from the address bar once the viewer is known.
  const viewerCommercials = view?.viewer.canViewCommercials;
  useEffect(() => {
    if (viewerCommercials === undefined) return;
    const count = stage2StepIds(viewerCommercials).length;
    if (step2No >= 1 && step2No <= count) return;
    try { const u = new URL(window.location.href); if (u.searchParams.get("stage") === "2" && u.searchParams.has("step")) { u.search = new URLSearchParams([...u.searchParams].filter(([k]) => k !== "step")).toString(); window.history.replaceState(null, "", u.toString()); } } catch { /* the address bar is a convenience */ }
  }, [viewerCommercials, step2No]);

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
  // "Manager: final approval" is described by whichever of the existing messages currently applies (each is already on the page, so nothing is duplicated). Role/process wording only.
  const approveSignoffMissing = q?.state === "ESTIMATOR_REVIEW" && !q.estimator_signoff_hash;
  const approveSignoffStale = q?.state === "ESTIMATOR_REVIEW" && !!q.estimator_signoff_hash && q.estimator_signoff_hash !== q.draft_hash;
  const approveDescribedBy = [isWorking && `${uid}-approve-busy`, !roles.has("manager") && `${uid}-approve-role`, approveSignoffMissing && `${uid}-approve-signoff`, approveSignoffStale && `${uid}-approve-stale`, dirty && `${uid}-approve-dirty`].filter(Boolean).join(" ") || undefined;
  const returnWhy = isWorking ? "Another action is in progress. Please wait." : !returnReason.trim() ? "Enter the reason for returning it to enable this." : undefined;
  const totalCents = budget && !budget.incomplete ? Math.round(budget.totals.subtotalExTax * 100) : null;

  // One-click demonstration quotation: replaces the inputs of THIS editable draft only (not saved, nothing created, approved or sent).
  function loadDemo() {
    const r = applyDemoDefaults(draft!);
    setDraft(r.draft); setDirty(true); setConfirmDemo(false); setDemoLoaded(r.replaced); setError(null);
  }
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
  function act(fn: () => Promise<{ ok: boolean; error?: string; data?: QuoteView }>, done: string, key = "page", confirm?: (v: QuoteView) => boolean) {
    void acts.run(key, async () => {
      if (dirty && !final) {
        const s = await saveGrowerDraftAction(id, draft!);
        if (!s.ok) return { ok: false, error: s.error ?? "Could not save" } as { ok: boolean; error?: string; data?: QuoteView };
      }
      const r = await fn();
      if (r.ok && r.data) adopt(r.data, true);
      return r;
    }, {
      pending: "Working… please wait",
      success: done,
      reconcile: async () => {
        const v = await getGrowerQuoteAction(id);
        if (!v.ok || !v.data || !confirm) return "unknown";
        if (confirm(v.data)) { adopt(v.data, true); return "done"; }
        return "not_done";
      },
    });
  }
  function save() {
    void acts.run("save", async () => {
      const r = await saveGrowerDraftAction(id, draft!);
      if (!r.ok || !r.data) return { ok: false, error: r.error ?? "Could not save" };
      setError(null);
      adopt(r.data);
      return r;
    }, { pending: "Saving the draft…", success: "Draft saved. Any estimator sign-off made on earlier content no longer applies." });
  }

  const cfg = draft.config;
  const lineByKey = new Map(ev.calc.lines.map((l) => [l.itemKey, l]));
  const bridgeByKey = new Map<string, BridgeLine>((budget?.lines ?? []).map((b) => [b.itemKey, b]));
  const summary = budget ? buildCustomerSummary(budget) : null;
  const stages = computeStages({
    state: q.state, revision: q.revision, ready: rd.state === "READY", customerSelected: !!draft.customerName.trim(), confirmed: q.customer_confirmed_cents != null,
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
  const here = currentStage(stages);
  if (landing === null && !loadingStages) setLanding(here); // once, when the current stage is first known (React's render-phase initialisation)
  const stage: StageId = picked ?? landing ?? here;
  const goStage = (n: StageId) => { setPicked(n); try { const u = new URL(window.location.href); const at = n === 1 ? stepNo : n === 2 ? step2Cur : 1; const sp = new URLSearchParams([...u.searchParams].filter(([k]) => k !== "step" && k !== "stage")); sp.set("stage", String(n)); if (at > 1) sp.set("step", String(at)); u.search = sp.toString(); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ } };

  const stage1 = deriveStage1Steps({ customerName: draft.customerName, siteName: draft.siteName, penningPigSize: cfg.penningPigSize, calcIssues: ev.calc.issues, readinessReasons: rd.reasons, customer: customerFacts, roomValues: { lengthM: cfg.lengthM, widthM: cfg.widthM, rooms: cfg.rooms, totalPens: cfg.totalPens, pigsPerRoom: cfg.pigsPerRoom } });
  const stepId = STAGE1_STEP_IDS[stepNo - 1];
  const goStepNo = (n: number) => {
    const next = Math.min(Math.max(n, 1), STAGE1_STEP_IDS.length);
    setStepNo(next);
    try { const u = new URL(window.location.href); u.searchParams.set("step", String(next)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ }
  };
  const goStep = (id: string) => goStepNo(STAGE1_STEP_IDS.indexOf(id as Stage1StepId) + 1);
  const nextOpen = nextIncompleteStepId(stage1.steps, stepId);
  // Guided: each step is its own grid and a single panel spans the full width. Show all: the step sections are `contents`, so every panel joins the fieldset's one grid
  // and Room inputs | Selections sit side by side again (xl:order-* puts the two headings above their panels at xl only; below xl the one-column source order keeps each heading right before its own panel). A hidden step is never `contents` (hidden wins via !important).
  const stepPanelCls = showAllSteps ? "contents" : "col-span-full grid min-w-0 items-start gap-6 xl:grid-cols-2";
  const wide = showAllSteps ? "" : "col-span-full";

  // Stage 2 steps: the same navigation and guidance (never a gate). Statuses come from data already loaded here: the readiness result, the budget, the draft's own validation and the stage gates.
  const canCommercials = view.viewer.canViewCommercials;
  const step2Ids = stage2StepIds(canCommercials);
  const step2Cur = step2No >= 1 && step2No <= step2Ids.length ? step2No : 1; // a ?step= beyond this viewer's steps (a Rep has three) falls back to the first, as for Stage 1
  const step2Id = step2Ids[step2Cur - 1];
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
  // Any unsaved edit clears the acknowledgement (reverting does not restore it: safe), and so does a save or any change to the costing. The cost and margin in the key are belt-and-braces
  // beside the revision, content hash and update time. It is offered only while the Cost step is genuinely in the "Review needed" state (not while the costing needs attention).
  const costReviewable = deriveStage2Steps({ ...s2Base, costAcknowledged: false }).steps.find((x) => x.id === "cost")?.status === "review";
  const isEstimatorOrManager = roles.has("estimator") || roles.has("manager");
  const isObserver = canCommercials && !isEstimatorOrManager; // can see the costing (e.g. an Administrator) but holds no quote role: nothing for them to mark
  const canAckCost = canCommercials && q.state === "ESTIMATOR_REVIEW" && isEstimatorOrManager && costKey != null && costReviewable;
  const costAcknowledged = canAckCost && costAck === costKey && !dirty;
  const costNeedsMark = canAckCost && !dirty && !costAcknowledged; // the one action is offered only when it can actually take effect
  const onCostUnmarked = costNeedsMark && step2Id === "cost";
  const onCostMarked = costAcknowledged && step2Id === "cost";
  const ACK_EXPLAIN = "This records that you have looked at the costing and margin for this version. It is not the Estimator sign-off.";
  const markReviewed = () => {
    setCostAck(costKey);
    if (showAllSteps) setTimeout(() => document.getElementById("cost-ack-done")?.focus(), 0); else goStep2("signoff"); // step mode: the Sign-off heading takes focus; show-all: the "marked reviewed" text does
    setAckFor(costKey);
  };
  // The announcement is derived from the resulting state, never from the click: it is spoken only while the acknowledgement actually holds.
  const ackMsg = costAcknowledged && ackFor === costKey ? "Cost & margin marked reviewed. This is not a sign-off." : "";
  const stage2 = deriveStage2Steps({ ...s2Base, costAcknowledged });
  // On Cost & margin there is no ineffective "Next": when the review cannot be recorded (not in Estimator review, costing needing attention, cost unavailable) the bar says why and offers Back only.
  const costStepNow = stage2.steps.find((x) => x.id === "cost");
  const costDone = q.state === "MANAGER_APPROVED_FINAL" || costStepNow?.status === "complete" || costStepNow?.counted === true;
  const costBlockedNow = canCommercials && !costNeedsMark && !costAcknowledged && !costDone; // nothing can be recorded: say why instead of offering an ineffective action
  const costBlocked = costBlockedNow && step2Id === "cost";
  const costBlockedText = isObserver ? "You can view the costing and margin but only the Estimator or a Manager can mark it reviewed."
    : q.state !== "ESTIMATOR_REVIEW" ? "Marking the costing reviewed is available once the quote is in Estimator review."
    : costStepNow?.status === "attention" ? `Resolve the costing items above before marking reviewed. ${costStepNow.note ?? ""}`.trim()
    : dirty ? "Save or discard your unsaved edits before marking the costing reviewed."
    : `The costing cannot be marked reviewed yet. ${costStepNow?.note ?? ""}`.trim();
  const groupTone = { success: "complete", warning: "attention", danger: "attention", info: "incomplete", neutral: "neutral" } as const;
  const stage2Groups = stage2.groups.map((g) => ({ id: g.id, label: g.label, owner: g.id === "rep" ? "Rep" : "Estimator", statusText: `Workflow: ${g.statusLine}`, tone: groupTone[g.tone] }));
  const signoffOutstandingForYou = q.state === "ESTIMATOR_REVIEW" && (roles.has("estimator") || roles.has("manager")) && stage2.steps.find((x) => x.id === "signoff")?.status !== "complete";
  const goStep2No = (n: number) => {
    setAckFor(null);
    const next = Math.min(Math.max(n, 1), step2Ids.length);
    setStep2No(next); // the address bar gets stage and step together, so a reload lands on the same step
    try { const u = new URL(window.location.href); u.searchParams.set("stage", "2"); u.searchParams.set("step", String(next)); window.history.replaceState(null, "", u.toString()); } catch { /* the address bar is a convenience */ }
  };
  const goStep2 = (id: string) => goStep2No(step2Ids.indexOf(id as Stage2StepId) + 1);
  const next2Open = nextIncompleteStepId(nextCandidates(stage2, step2Id), step2Id); // only this viewer's own work, never another role's

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
        {view.viewer.canViewCommercials && <><dt className="text-slate-600">Estimated cost · GP (managers)</dt><dd className="text-right tabular-nums">{fmtZar(budget.totals.estimatedCost)} · {budget.totals.overallMarginPct == null ? "N/A" : `${budget.totals.overallMarginPct.toFixed(1)}%`}</dd></>}
      </dl>
      <p className="mt-2 text-xs text-slate-600">{budget.pricingBasis}. {budget.state === "complete" ? "Every required line is priced." : "Incomplete: the total is partial until every blocker is resolved."}</p>
    </Panel>
  );
  // The physical scope (read-only evidence). A viewer who may not see commercials has no Cost & margin step, so their scope sits under the line decisions and their totals under the charges.
  const scopePanel = <ScopePanel quoteId={id} draft={dirty ? (previewedFor ?? q.draft) : draft} />;

  return (
    <main className={pageContainerClass("data")}>
      <ModuleHeader variant="workspace" module={SOLUTION_BUILDER_MODULE}>
        <Link href="/newquip-grower" className="text-indigo-700 hover:underline">← Solution Builder quotes</Link> · {q.quote_ref} <span className="text-slate-600">rev {q.revision}</span>
      </ModuleHeader>

      <p className="mt-4 text-sm text-slate-700">
        Grower House Template v1 · {QUOTE_TYPE_LABEL[draft.quoteType]} pricing · {budget?.priceSource.label ?? "NewQuip Master workbook – POC controlled snapshot"}
      </p>
      {/* The price and margin summary stays in view while the form scrolls. It always shows the same figures as the Totals below (the live preview of unsaved edits). */}
      <div className="top-0 z-10 mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm md:sticky" data-testid="quote-summary-bar" aria-busy={recalculating}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-700">Calculation</span>
            <Status tone={READY_TONE[rd.state]}>{READINESS_LABEL[rd.state]}</Status>
            {previewFailure ? <Status tone="danger">Recalculation failed - figures are out of date</Status> : dirty && <Status tone="warning">Preview of unsaved edits</Status>}
          </div>
          <dl className="flex flex-wrap items-end gap-x-8 gap-y-1">
            <div><dt className="text-xs uppercase tracking-wide text-slate-700">Quote total (ex VAT)</dt><dd className={`whitespace-nowrap text-2xl font-bold tabular-nums ${previewFailure ? "text-slate-700 line-through decoration-1" : "text-slate-900"}`}>{totalCents == null ? "—" : fmtCents(totalCents)}{staleCue && <span className="ml-2 text-sm font-semibold no-underline" data-testid="summary-stale">{staleCue}</span>}</dd></div>
            {budget && !budget.incomplete && <div><dt className="text-xs uppercase tracking-wide text-slate-700">Total (inc VAT)</dt><dd className="whitespace-nowrap text-lg font-semibold tabular-nums text-slate-900">{fmtZar(budget.totals.totalIncTax)}</dd></div>}
            {budget && view.viewer.canViewCommercials && stage < 4 && <div><dt className="text-xs uppercase tracking-wide text-slate-700">Gross margin</dt><dd className="whitespace-nowrap text-lg font-semibold tabular-nums text-slate-900">{budget.totals.overallMarginPct == null ? "N/A" : `${budget.totals.overallMarginPct.toFixed(1)}%`}</dd></div>}
          </dl>
        </div>
      </div>

      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      <ActionFeedback state={acts.stateOf("page")} floating />
      {final && <div className="mt-4"><Alert tone="info">This quote is the manager-approved final. Its accepted baseline is frozen; any change after acceptance must be a Variation on the Project.</Alert></div>}
      {budget && <p className="mt-3 text-xs text-slate-600">{budget.priceSource.notice} Provenance: {budget.priceSource.provenance}</p>}

      <StageNav stages={stages} current={here} viewing={stage} onSelect={goStage} />

      {stage === 1 && (
        <StepRail id="s1" ariaLabel="Configuration steps" steps={stage1.steps} currentId={stepId} onSelect={goStep}
          actions={(
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAllSteps} onChange={(e) => setShowAllSteps(e.target.checked)} /> Show all steps</label>
              {nextOpen
                ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep(nextOpen)}>Next incomplete step</Button>
                : <span className="text-sm text-slate-700" data-testid="all-steps-complete">Every step is complete.</span>}
            </div>
          )} />
      )}

      {stage === 2 && step2No > step2Ids.length && <p className="mt-3 text-sm text-slate-800" data-testid="step-unavailable">That step is not available to you, so the first step is shown.</p>}
      {stage === 2 && (
        <StepRail id="s2" ariaLabel="Costing and review steps" steps={stage2.steps} currentId={step2Id} onSelect={goStep2} groups={stage2Groups}
          actions={(
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAllSteps} onChange={(e) => setShowAllSteps(e.target.checked)} /> Show all steps</label>
              {next2Open
                ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep2(next2Open)}>Next incomplete step</Button>
                : <span className="text-sm text-slate-700" data-testid="all-steps-complete">{signoffOutstandingForYou ? "Next: sign off or return the quotation." : "Nothing is left for you in this stage."}</span>}
            </div>
          )} />
      )}

      {stage === 2 && canCommercials && <div role="status" aria-live="polite" data-testid="cost-ack-live">{ackMsg && <p className="mt-3 text-sm text-slate-800" data-testid="cost-ack-status">{ackMsg}</p>}</div>}
      {stage === 2 && !showAllSteps && onCostUnmarked && (
        <p className="mt-3 text-sm text-slate-800" data-testid="cost-ack-pointer">Review the costing below, then use Mark reviewed &amp; continue. <button type="button" className="font-semibold text-indigo-700 underline" onClick={() => document.getElementById("cost-ack-btn")?.focus()}>Go to the button</button></p>
      )}
      {stage === 2 && <div role="status" data-testid="next-role-live">{q.state === "ESTIMATOR_REVIEW" && stage2.groups.find((x) => x.id === "estimator")?.statusLine === "Signed off" && <p className="mt-3 text-sm font-semibold text-slate-900" data-testid="next-manager-cue">Next: Manager approval (Stage 3).</p>}</div>}
      {stage <= 2 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={acts.isPending("save")} aria-describedby={saveWhy ? "save-why" : undefined} disabled={isWorking || !editable || !dirty || incompleteOverrides || blankExclusionKeys.length > 0}>Save draft</Button>
            <span role="status" aria-live="polite" data-testid="save-state">{dirty ? <Status tone="warning">Unsaved changes</Status> : editable ? <Status tone="success">All changes saved</Status> : null}</span>
            {editable && !confirmDemo && <Button variant="secondary" onClick={() => (hasEntries(draft) ? setConfirmDemo(true) : loadDemo())}>Load Demo Defaults</Button>}
            {!editable && <span id="save-why" className="text-sm text-slate-700">{final ? "Read-only: accepted quote." : "You do not have permission to edit: only a Rep or Estimator can edit and save this quotation."}</span>}
          </div>
          <div className="mt-2 space-y-1">{editable && <DisabledReason id="save-why">{saveWhy}</DisabledReason>}<ActionFeedback state={acts.stateOf("save")} /></div>
          <div className="mt-2 space-y-2">
          {dirty && <p className="max-w-4xl text-sm text-slate-700" data-testid="unsaved-note">{recalculating ? "Recalculating… " : ""}The prices, costs, margins and totals are a live preview of your edits and nothing is saved until you press Save draft. Sign-off and approval use the SAVED draft.</p>}
          {previewFailure && <p className="max-w-4xl text-sm text-red-700">The live recalculation failed ({previewFailure}); the figures shown may be out of date. Edit again or reload.</p>}
          {incompleteOverrides && <p className="max-w-4xl text-sm text-amber-800">Complete or clear the highlighted cost overrides (a reason and an amount) before saving.</p>}
          {blankExclusionKeys.length > 0 && <p className="max-w-4xl text-sm text-amber-800">Enter a reason for each ticked exclusion before saving (the preview already applies it).</p>}
          {editable && confirmDemo && (
            <div className="flex max-w-4xl flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span>This replaces the values in this draft with the demonstration quotation (nothing is saved until you press Save draft). The customer you selected is kept.</span>
              <Button size="sm" onClick={loadDemo}>Replace with demo</Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDemo(false)}>Cancel</Button>
            </div>
          )}
          </div>
        </>
      )}
      {demoLoaded && stage <= 2 && (
        <div className="mt-3">
          <Alert tone={rd.state === "READY" ? "success" : "warning"}>
            Demo defaults loaded into this draft ({DEMO_DEFAULTS_SOURCE}) {demoLoaded.length ? `Replaced: ${demoLoaded.join(", ")}.` : "The draft already matched the demonstration; nothing changed."}{" "}
            Status: {READINESS_LABEL[rd.state]}.{rd.reasons.length ? ` Open: ${rd.reasons.join("; ")}.` : ""}
            {rd.counts.supplierQuoteRequired + rd.counts.missingMappings + rd.counts.pricingExceptions > 0 ? ` Unresolved: ${rd.counts.supplierQuoteRequired} supplier-quote-required, ${rd.counts.missingMappings} unmapped, ${rd.counts.pricingExceptions} pricing exceptions (listed below).` : " No supplier-quote-required, unmapped or pricing-exception items remain."}
            {" "}Prices marked MANUAL QUOTATION PRICE are the demonstration quote&apos;s own estimator values. Not saved, approved, frozen or sent anywhere.
          </Alert>
        </div>
      )}

      {/* ───────────── 1 · CONFIGURATION ───────────── */}
      {stage === 1 && (
        <>
        <fieldset disabled={!editable} className="mt-4 grid min-w-0 items-start gap-6 border-0 p-0 xl:grid-cols-2" data-testid="stage1-layout">
          {/* Hidden steps stay mounted (hidden + inert), so the requests made on mount are the same whichever step is shown. */}
          <StepPanel railId="s1" stepId="customer" number={1} title={STAGE1_STEP_LABEL.customer} current={stepId === "customer"} showAll={showAllSteps} className={stepPanelCls}>
            <Panel className="xl:col-span-2">
              <PanelTitle>Customer & quotation contact</PanelTitle>
              <p className="mt-2 text-xs text-slate-600">Choosing a Cin7 customer or contact below is saved at once. The customer name field is saved with Save draft. The quotation contact is chosen in this step.</p>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <TextField label="Customer" value={draft.customerName} onChange={(v) => edit((d) => { d.customerName = v; })} />
              </div>
              <CustomerPanel quoteId={id} editable={editable} onPicked={onCustomerChanged} onFacts={onCustomerFacts} />
            </Panel>
          </StepPanel>

          <StepPanel railId="s1" stepId="site" number={2} title={STAGE1_STEP_LABEL.site} current={stepId === "site"} showAll={showAllSteps} className={stepPanelCls}>
            <Panel className="col-span-full">
              <PanelTitle>Site name & pricing basis</PanelTitle>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <TextField label="Site / project name" value={draft.siteName} onChange={(v) => edit((d) => { d.siteName = v; })} />
                <Select label="Pricing basis" value={draft.quoteType} onChange={(e) => edit((d) => { d.quoteType = e.target.value as QuoteType; })}>
                  <option value="project">Project — landed cost + 20%</option>
                  <option value="day_to_day">Day-to-day — workbook Retail ex VAT</option>
                </Select>
              </div>
              <p className="mt-4 text-sm text-slate-800" data-testid="step2-contact-status">
                Quotation contact: {customerFacts.contactName ? <strong>{customerFacts.contactName}</strong> : <span className="text-amber-900">{customerFacts.loaded && customerFacts.available ? "not chosen yet" : "not read yet"}</span>}
                {" "}{/* A link, not a button: navigation must keep working for a viewer who cannot edit (the fieldset disables buttons). A "#" href is an in-page link the unsaved guard ignores. */}
                <a href="#s1-customer-heading" onClick={(e) => { e.preventDefault(); goStep("customer"); }} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">Choose the contact in step 1</a>
              </p>
              <p className="mt-2 text-xs text-slate-600">The site name and pricing basis are saved with Save draft.</p>
            </Panel>
          </StepPanel>

          <StepPanel railId="s1" stepId="room" number={3} title={STAGE1_STEP_LABEL.room} current={stepId === "room"} showAll={showAllSteps} className={stepPanelCls} headingClassName={showAllSteps ? "xl:order-1" : undefined}>
            <Panel className={showAllSteps ? "xl:order-3" : wide}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PanelTitle>Room inputs — describe ONE room</PanelTitle>
                <Button variant="secondary" size="sm" onClick={() => edit((d) => { d.config = { ...structuredClone(TOPIGS_GROWER_INPUT), feederVariant: "STANDARD", exclusions: {}, estimatorQuantities: {}, quantityOverrides: {}, quantityOverrideReasons: {} }; })}>Load Topigs sample inputs</Button>
              </div>
              <p className="mt-2 text-xs text-slate-600">{ROOMS_HELP}</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
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
          </StepPanel>

          <StepPanel railId="s1" stepId="equipment" number={4} title={STAGE1_STEP_LABEL.equipment} current={stepId === "equipment"} showAll={showAllSteps} className={stepPanelCls} headingClassName={showAllSteps ? "xl:order-2" : undefined}>
            <Panel className={showAllSteps ? "xl:order-4" : wide}>
              <PanelTitle>Selections</PanelTitle>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Select label="CCM feeder variant" helperText={`One feeder, two variants. Capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs per feeder.`} value={cfg.feederVariant ?? "STANDARD"} onChange={(e) => edit((d) => { d.config.feederVariant = e.target.value as "STANDARD" | "WINDOW"; delete d.estimator.confirmedMappings.feeder; })}>
                  <option value="STANDARD">Standard — PNQ082</option>
                  <option value="WINDOW">With window — PNQ082-WINDOW</option>
                </Select>
                <Select label="Penning pig size" value={cfg.penningPigSize ?? ""} onChange={(e) => edit((d) => { d.config.penningPigSize = (e.target.value || null) as PenningPigSize | null; })}>
                  <option value="">Select…</option>
                  {(Object.keys(PIG_SIZE_LABEL) as PenningPigSize[]).map((k) => <option key={k} value={k}>{PIG_SIZE_LABEL[k]}</option>)}
                </Select>
                <NumField label="Penning running metres" unit="per room" value={cfg.penningRunningMetresPerRoom} onChange={(v) => edit((d) => { d.config.penningRunningMetresPerRoom = v; })} hint="Running metres, not m²" />
                <NumField label="Slatted floor area (context only)" unit="m², one room" value={cfg.slattedFloorAreaM2} onChange={(v) => edit((d) => { d.config.slattedFloorAreaM2 = v; })} hint="Never converted to a slat quantity — the rep enters the quantity" />
              </div>
            </Panel>

            <Panel className={`xl:col-span-2${showAllSteps ? " xl:order-5" : ""}`}>
              <PanelTitle>Ventilation — optional inside Grower</PanelTitle>
              <p className="mt-2 max-w-4xl text-sm text-amber-800">{VENTILATION_SCOPE_STATUS}. AS.03 is not yet ingested: no fan, cooling or controller rule is invented — once selected, the estimator enters the quantity after engineering review.</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(Object.keys(OPTIONAL_LABELS) as OptionalItemKey[]).map((k) => {
                  const on = cfg.optionalEquipment[k];
                  return (
                    <li key={k}>
                      <label className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${on ? "border-indigo-600 bg-indigo-50 text-slate-900" : "border-slate-300 bg-white text-slate-700"}`}>
                        <span className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={(e) => edit((d) => { d.config.optionalEquipment[k] = e.target.checked; })} /> {OPTIONAL_LABELS[k]}</span>
                        <span className={`text-xs font-semibold ${on ? "text-indigo-800" : "text-slate-600"}`} aria-hidden>{on ? "✓ Included" : "Not included"}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </StepPanel>
        </fieldset>

        {/* Step 5 is read-only and outside the form fieldset, so its navigation works for every role. */}
        <StepPanel railId="s1" stepId="review" number={5} title={STAGE1_STEP_LABEL.review} current={stepId === "review"} showAll={showAllSteps} className="mt-6 grid min-w-0 gap-6">
          <Stage1Review draft={draft} floorAreaM2={ev.calc.derived.floorAreaM2} totalLabel={totalCents == null ? "—" : fmtCents(totalCents)} derived={stage1} onGoStep={goStep} onContinue={() => goStage(2)} />
        </StepPanel>

        {!showAllSteps && (
          <div className="mt-6 flex items-center justify-between gap-3" data-testid="step-buttons">
            {stepNo > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStepNo(stepNo - 1)}>Back</Button> : <span />}
            {stepNo < STAGE1_STEP_IDS.length ? <Button type="button" className="min-h-11" onClick={() => goStepNo(stepNo + 1)}>Next</Button> : <span />}
          </div>
        )}
        </>
      )}

      {/* ───────────── 2 · ESTIMATOR REVIEW ───────────── */}
      {stage === 2 && (
        <>
        <fieldset disabled={!editable} className="mt-4 min-w-0 space-y-6 border-0 p-0">
          {/* Hidden steps stay mounted (hidden + inert): the requests and timers started on mount are the same whichever step is shown. */}
          <StepPanel railId="s2" stepId="lines" number={1} title={STAGE2_STEP_LABEL.lines} current={step2Id === "lines"} showAll={showAllSteps} className="space-y-6">
            <Panel>
              <div className="flex flex-wrap items-center gap-3">
                <PanelTitle>Quote readiness</PanelTitle>
                <Status tone={READY_TONE[rd.state]}>{READINESS_LABEL[rd.state]}</Status>
              </div>
              {rd.reasons.length > 0 && (
                <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-red-700">{rd.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {(Object.keys(CAT_LABEL) as ReadinessCategory[]).map((c) => (
                  <details key={c} className="rounded-lg border border-slate-200 p-3 open:col-span-2 md:open:col-span-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-600">{CAT_LABEL[c]}</span>
                      <Status tone={rd.counts[c] > 0 ? CAT_TONE[c] : "neutral"}>{rd.counts[c]}</Status>
                    </summary>
                    {rd.items[c].length === 0 ? <p className="mt-2 text-xs text-slate-600">None.</p> : (
                      <ul className="mt-2 space-y-1 text-xs text-slate-700">{rd.items[c].map((i, n) => <li key={n}><span className="font-medium">{i.label}</span> — {i.detail}</li>)}</ul>
                    )}
                  </details>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-600">Manual-by-design items (feeder / drinker / slat quantities, M75, doors, tank, ventilation scope) only block the quote until the estimator supplies them.</p>
            </Panel>

            <Panel>
              <PanelTitle>Line decisions (per room × {cfg.rooms || 0} rooms)</PanelTitle>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[1080px] text-left text-sm" aria-label="Line decisions">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
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
                      const mapControl = mappingControlFor(l.itemKey, l.basis, roles, editable);
                      return (
                        <tr key={l.itemKey} className={`border-b border-slate-100 align-top ${l.exclusionReason ? "bg-amber-50" : optionalOff ? "bg-slate-50" : ""}`}>
                          <td className="py-3 pr-3"><div className="font-medium text-slate-900">{l.label}</div><div className="font-mono text-xs text-slate-600">{l.ruleId}</div>
                            {l.exclusionReason && <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-amber-900"><Status tone="warning">Excluded</Status>{l.exclusionReason}</div>}
                            {optionalOff && <div className="mt-1"><Status tone="neutral">Not selected</Status></div>}</td>
                          <td className="py-3 pr-3"><Status tone={l.overrideState === "manual_override" ? "warning" : KIND_TONE[kind]}>{l.overrideState === "manual_override" ? "OVERRIDE" : VALUE_KIND_LABEL[kind]}</Status>
                            <div className="mt-1 text-xs text-slate-600">{rule.treatment.replace(/_/g, " ")}</div></td>
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
                            {l.basis === "not_selected" && !l.exclusionReason && <span className="text-xs text-slate-700">Optional equipment is not included. Tick it on the Configuration stage to add it.</span>}
                          </td>
                          <td className="py-3 pr-3 text-right tabular-nums">{l.projectQuantity ?? "—"}</td>
                          <td className="py-3 pr-3 text-xs text-slate-700">{mapControl === "chooser" ? (
                            <div className="min-w-[280px]" data-testid={`mapping-chooser-${l.itemKey}`}>
                              <ProductMappingPicker label={l.label} value={draft.estimator.confirmedMappings[l.itemKey]}
                                onChange={(sku) => edit((d) => { if (sku) d.estimator.confirmedMappings[l.itemKey] = sku; else delete d.estimator.confirmedMappings[l.itemKey]; })} />
                            </div>
                          ) : mapControl === "waiting_for_estimator" && !b?.sku ? <span className="text-amber-800">Awaiting an Estimator to choose the Cin7 product.</span> : b?.sku ?? (b?.pricedBy === "penning_rate" ? "Pig-size / running-metre basis" : b?.pricedBy === "estimator_input" ? "Estimator-priced system" : b?.pricedBy === "estimator_resolution" ? "Estimator-resolved" : "—")}</td>
                          <td className="whitespace-nowrap py-3 pr-3 text-right tabular-nums">{b?.revenueExTax != null ? fmtZar(b.revenueExTax) : "—"}</td>
                          <td className="py-3 text-xs">{b ? (b.status === "priced" ? <span className="text-emerald-800"><span aria-hidden>✓ </span>Priced</span> : b.status === "not_selected" ? "" : <span className="text-amber-800">{b.reason}</span>) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

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
                          <select aria-label="Door product" value={confirmed ?? ""} onChange={(e) => edit((d) => { if (e.target.value) d.estimator.confirmedMappings.pvc_door = e.target.value; else delete d.estimator.confirmedMappings.pvc_door; })} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
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

            {!view.viewer.canViewCommercials && scopePanel}
          </StepPanel>

          <StepPanel railId="s2" stepId="charges" number={2} title={STAGE2_STEP_LABEL.charges} current={step2Id === "charges"} showAll={showAllSteps} className="space-y-6">
              <Panel>
                <PanelTitle>Commercial inputs (ex VAT)</PanelTitle>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {(["delivery", "installation", "concrete_slat_delivery"] as ChargeKey[]).map((c) => (
                    <NumField key={c} label={CHARGE_LABEL[c]} unit="R" hint={CHARGE_HELP[c]} value={draft.estimator.charges[c] ?? null} onChange={(v) => edit((d) => { d.estimator.charges = { ...d.estimator.charges, [c]: v }; })} />
                  ))}
                  <NumField label="M75 system price" unit="R per system" hint="Estimator input by design. NQ3132 is N/A — supplier quote required; it is not priced separately." value={draft.estimator.unitPrices.flex_auger ?? null} onChange={(v) => edit((d) => { d.estimator.unitPrices = { ...d.estimator.unitPrices, flex_auger: v }; })} />
                </div>
                <label className="mt-4 flex max-w-3xl flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700">Assumptions (frozen with the quote)</span>
                  <textarea value={draft.estimator.assumptions} onChange={(e) => edit((d) => { d.estimator.assumptions = e.target.value; })} rows={3} className="rounded-md border border-slate-300 p-2 text-sm" />
                </label>
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
                        <div><div className="text-sm font-medium text-slate-900">{b.label}</div><div className="text-xs text-amber-700">{b.reason}</div></div>
                        <NumField label="Unit price" unit="R ex VAT" value={r?.unitPriceExVat ?? null} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: v ?? 0, reason: d.estimator.priceResolutions[k]?.reason ?? "" } }; })} />
                        <TextField label="Reason" value={r?.reason ?? ""} onChange={(v) => edit((d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, [k]: { unitPriceExVat: d.estimator.priceResolutions[k]?.unitPriceExVat ?? 0, reason: v } }; })} hint={r && !r.reason.trim() ? "A reason is required before this price is used." : undefined} />
                        {r?.by && <span className="text-xs text-slate-600 md:col-span-3">Entered by {r.by}{r.at ? ` at ${formatSast(r.at)}` : ""}</span>}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            <Panel>
              <PanelTitle>Customer-driven exclusions</PanelTitle>
              <p className="mt-2 text-xs text-slate-600">Everything in the template is required by default. Exclude a section only at the customer&apos;s request, with a reason that stays visible and is frozen in the baseline.</p>
              <ul className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {ev.calc.lines.filter((l) => !GROWER_RULES.find((r) => r.itemKey === l.itemKey)!.optionalKey).map((l) => {
                  const k = l.itemKey as GrowerItemKey;
                  const on = cfg.exclusions?.[k] !== undefined;
                  return (
                    <li key={l.itemKey} className={`rounded-md border px-3 py-2 text-sm ${on ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" checked={on} onChange={(e) => edit((d) => { d.config.exclusions = { ...d.config.exclusions }; if (e.target.checked) d.config.exclusions[k] = ""; else delete d.config.exclusions[k]; })} /> Exclude {l.label.split(" (")[0]}</label>
                        <span className={`text-xs font-semibold ${on ? "text-amber-900" : "text-slate-600"}`} aria-hidden>{on ? "! Excluded" : "Included"}</span>
                      </div>
                      {on && <div className="mt-2"><TextField label="" placeholder="Reason (required)" value={cfg.exclusions?.[k] ?? ""} onChange={(v) => edit((d) => { d.config.exclusions = { ...d.config.exclusions, [k]: v }; })} hint={(cfg.exclusions?.[k] ?? "").trim() ? undefined : "A reason is required before this can be saved."} /></div>}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            {!view.viewer.canViewCommercials && totalsPanel}
          </StepPanel>

        </fieldset>

        <StepPanel railId="s2" stepId="submit" number={step2Ids.indexOf("submit") + 1} title={STAGE2_STEP_LABEL.submit} current={step2Id === "submit"} showAll={showAllSteps} className="mt-6 space-y-6">
          <Panel>
            <PanelTitle>Submit to Estimator</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">The Rep records the pre-approval price confirmation with the customer and submits the quote to the Estimator. This is not the customer&apos;s formal acceptance, which comes after Manager approval.</p>
            {q.state !== "REP_DRAFT" && q.customer_confirmed_cents != null && (
              <div className="mt-3 space-y-2">
                <ConfirmationPanel quoteId={id} amountLabel={fmtCents(q.customer_confirmed_cents)} canAct={false} ready loading={false} refreshKey={`${q.revision}:${q.state}:${q.updated_at}`} recorded onConfirm={() => undefined} />
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-5">
              {q.state === "REP_DRAFT" && (
                <>
                  <div className="w-full">
                    <ConfirmationPanel quoteId={id} amountLabel={totalCents == null ? null : fmtCents(totalCents)} canAct={roles.has("rep")} ready={rd.state === "READY"} loading={isWorking} refreshKey={`${q.revision}:${q.state}:${q.updated_at}`} recorded={false}
                      onConfirm={(c) => act(() => sendGrowerQuoteToEstimatorAction(id, totalCents!, c), "Pre-approval price confirmation recorded and sent to the estimator.", "send", (v) => v.quote.state === "ESTIMATOR_REVIEW")} />
                  </div>
                </>
              )}
              {q.state !== "REP_DRAFT" && <p className="text-sm text-slate-700" data-testid="submit-state">{final ? "Submitted and approved." : "Submitted: the quote is with the Estimator."}</p>}
            </div>
            <ActionFeedback state={acts.stateOf("send")} />
          </Panel>
        </StepPanel>

        {view.viewer.canViewCommercials && (
          <fieldset disabled={!editable} className="mt-6 min-w-0 space-y-6 border-0 p-0">
              <StepPanel railId="s2" stepId="cost" number={step2Ids.indexOf("cost") + 1} title={STAGE2_STEP_LABEL.cost} current={step2Id === "cost"} showAll={showAllSteps} className="space-y-6">
                {scopePanel}
                {/* Right under the physical scope, where the estimator resolves the SKUs: capture the latest Cin7 costs for a draft quotation. */}
                {!final && <CostPanel quoteId={id} unsaved={dirty} previewDraft={dirty ? previewedFor : null} />}
                {totalsPanel}
                {budget && view.viewer.canViewCommercials && (
                  <div aria-busy={recalculating}><MarginPanel budget={budget} draft={draft} final={final} frozen={q.accepted_baseline?.internalMargin} editable={editable} edit={edit} /></div>
                )}
              </StepPanel>
          </fieldset>
        )}


        {showAllSteps && canCommercials && (costNeedsMark || costAcknowledged) && (
          <div className="mt-4 max-w-3xl rounded-lg border border-indigo-200 bg-indigo-50 p-4" data-testid="cost-ack">
            <p id="cost-ack-explain-all" className="text-sm text-slate-800">{ACK_EXPLAIN}</p>
            {costAcknowledged
              ? <p id="cost-ack-done" tabIndex={-1} className="mt-2 text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" data-testid="cost-ack-done">You marked the costing reviewed for this version.</p>
              : <Button type="button" aria-describedby="cost-ack-explain-all" className="mt-3 min-h-11" onClick={markReviewed}>Mark reviewed &amp; continue</Button>}
          </div>
        )}
        {showAllSteps && costBlockedNow && (
          <p role="status" className="mt-4 max-w-3xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="cost-ack-blocked">{costBlockedText}</p>
        )}

        <StepPanel railId="s2" stepId="signoff" number={step2Ids.indexOf("signoff") + 1} title={STAGE2_STEP_LABEL.signoff} current={step2Id === "signoff"} showAll={showAllSteps} className="mt-6 space-y-6">
          <Panel>
            <PanelTitle>Estimator review and handoff</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">The Estimator signs off or returns the quote to the Rep. This is not the customer&apos;s formal acceptance, which comes after Manager approval.</p>
            {handoffFacts}
                {q.state !== "REP_DRAFT" && q.customer_confirmed_cents != null && !final && totalCents != null && totalCents !== q.customer_confirmed_cents && <Alert tone="warning">The quote total ({fmtCents(totalCents)}) no longer equals the confirmed amount ({fmtCents(q.customer_confirmed_cents)}). Return it to the Rep to reconfirm with the customer before it can be approved.</Alert>}
            <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-5">
              {q.state === "ESTIMATOR_REVIEW" && (
                <>
                  {q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash
                    ? <span className="flex min-w-0 flex-wrap items-center gap-2"><Status tone="success">Estimator sign-off complete</Status><span className="min-w-0 break-words text-sm text-slate-700">{q.estimator_signoff_by_email ?? "estimator"}{q.estimator_signoff_at ? `, ${formatSast(q.estimator_signoff_at)}` : ""}</span></span>
                    : <Button loading={isWorking} aria-describedby={signoffWhy ? "signoff-why" : undefined} disabled={!roles.has("estimator") || rd.state !== "READY"} onClick={() => act(() => signOffGrowerQuoteAction(id), "Estimator sign-off recorded for this exact content.", "signoff", (v) => !!v.quote.estimator_signoff_hash && v.quote.estimator_signoff_hash === v.quote.draft_hash)}>Estimator: I double-checked this quote</Button>}
                  {roles.has("estimator") && (<>
                  <TextField label="Return to rep — reason" value={returnReason} onChange={setReturnReason} />
                  <Button variant="secondary" loading={isWorking} aria-describedby={returnWhy ? "return-rep-why" : undefined} disabled={!returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToRepAction(id, returnReason), "Returned to the rep as a new revision.", "signoff", (v) => v.quote.state === "REP_DRAFT")}>Return to rep</Button>
                  </>)}
                  {!roles.has("estimator") && <span className="text-xs text-slate-600">With the Estimator for review. Only an Estimator can sign off or return it here.</span>}
                </>
              )}
              {final && <Status tone="success">Signed off and approved</Status>}
            </div>
            {q.state === "ESTIMATOR_REVIEW" && !(q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash) && <div className="mt-2 space-y-1"><DisabledReason id="signoff-why">{signoffWhy}</DisabledReason>{roles.has("estimator") && <DisabledReason id="return-rep-why">{returnWhy}</DisabledReason>}</div>}
            <ActionFeedback state={acts.stateOf("signoff")} />
          </Panel>
          {final ? (
            <>
              {final && <ScopePanel quoteId={id} draft={draft} />}
              {final && view.viewer.canViewCommercials && <CostPanel quoteId={id} />}
            </>
          ) : (
            <Alert tone="info">SKU mapping and the Cin7 latest-supplier-price capture work on the frozen physical scope, so they open for the Estimator once the quotation is approved. Until then the estimator review above, the margin sheet and the readiness items are the costing evidence.</Alert>
          )}
        </StepPanel>

        {!showAllSteps && (
          <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-end justify-between gap-3 border-t border-slate-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-6 md:px-6" data-testid="step-buttons">
            {step2Cur > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => goStep2No(step2Cur - 1)}>Back</Button> : <span />}
            {onCostUnmarked ? (
              // The ONLY way forward from Cost & margin while the review is outstanding: it records the review (client-local), then moves on. The rail and Back still navigate and record nothing.
              <div className="flex max-w-xl flex-col items-end gap-2" data-testid="cost-ack">
                <p id="cost-ack-explain" className="text-right text-sm text-slate-800">{ACK_EXPLAIN}</p>
                <Button type="button" id="cost-ack-btn" aria-describedby="cost-ack-explain" className="min-h-11" onClick={markReviewed}>Mark reviewed &amp; continue</Button>
              </div>
            ) : costBlocked ? (
              <div className="flex max-w-xl flex-col items-end gap-2">
                <p role="status" className="text-right text-sm text-amber-900" data-testid="cost-ack-blocked">{costBlockedText}</p>
                {isObserver && step2Cur < step2Ids.length && <Button type="button" className="min-h-11" onClick={() => goStep2No(step2Cur + 1)}>Next: Sign-off or return</Button>}
              </div>
            ) : step2Cur < step2Ids.length ? (
              <div className="flex flex-col items-end gap-2">
                {onCostMarked && <p id="cost-ack-done" tabIndex={-1} className="mt-2 text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" data-testid="cost-ack-done">You marked the costing reviewed for this version.</p>}
                <Button type="button" className="min-h-11" onClick={() => goStep2No(step2Cur + 1)}>{onCostMarked ? "Next: Sign-off or return" : "Next"}</Button>
              </div>
            ) : <span />}
          </div>
        )}
        </>
      )}

      {/* ───────────── 3 · MANAGER APPROVAL ───────────── */}
      {stage === 3 && (
        <div className="mt-6 space-y-6">
          <Panel>
            <PanelTitle>Manager approval</PanelTitle>
            <p className="mt-1 text-xs text-slate-600">Final internal commercial approval. The Rep sees the outcome here and by notification; only a Manager can decide.</p>
            {handoffFacts}

            {approveSignoffMissing && <div id={`${uid}-approve-signoff`}><Alert tone="info">Waiting for the Estimator&apos;s sign-off before the Manager can decide.</Alert></div>}
            {approveSignoffStale && <div id={`${uid}-approve-stale`}><Alert tone="warning">The Estimator&apos;s sign-off no longer matches the current quotation. It must be given again before the Manager can decide.</Alert></div>}
            {q.state === "ESTIMATOR_REVIEW" && dirty && <div id={`${uid}-approve-dirty`}><Alert tone="warning" >You have unsaved edits. Save or discard your edits first: approval applies to the saved quotation.</Alert></div>}
            <div className="mt-5 space-y-3 border-t border-slate-100 pt-5">
              {q.state === "ESTIMATOR_REVIEW" && (
                <>
                  {roles.has("manager") && <div className="max-w-xl"><TextField label="Return to rep — reason" value={returnReason} onChange={setReturnReason} hint="Required only when you return the quotation instead of approving it." /></div>}
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" loading={acts.isPending("approve")} disabled={isWorking || !roles.has("manager") || !q.estimator_signoff_hash || q.estimator_signoff_hash !== q.draft_hash || dirty} aria-describedby={approveDescribedBy}
                      onClick={() => act(() => approveGrowerQuoteAction(id), "Approved. The accepted baseline is frozen; the Project can now be created.", "approve", (v) => v.quote.state === "MANAGER_APPROVED_FINAL")}>Manager: final approval</Button>
                    {roles.has("manager") && (<>
                      <Button variant="secondary" aria-describedby={returnWhy ? "return-mgr-why" : undefined} disabled={isWorking || !returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToRepAction(id, returnReason), "Returned to the rep as a new revision.", "approve", (v) => v.quote.state === "REP_DRAFT")}>Return to rep (reject)</Button>
                      {q.estimator_signoff_hash && (
                        <Button variant="secondary" aria-describedby={returnWhy ? "return-mgr-why" : undefined} disabled={isWorking || !returnReason.trim()} onClick={() => act(() => returnGrowerQuoteToEstimatorAction(id, returnReason), "Returned to the estimator. Their sign-off is withdrawn and must be given again; the quote and its history are kept.", "approve", (v) => !v.quote.estimator_signoff_hash)}>Manager: return to estimator</Button>
                      )}
                    </>)}
                  </div>
                  {isWorking && <DisabledReason id={`${uid}-approve-busy`}>Another action is in progress. Please wait.</DisabledReason>}
                  {roles.has("manager") && <DisabledReason id="return-mgr-why">{returnWhy ? `Return buttons: ${returnWhy.charAt(0).toLowerCase()}${returnWhy.slice(1)}` : undefined}</DisabledReason>}
                  {!roles.has("manager") && <p id={`${uid}-approve-role`} className="text-sm text-slate-700">Final approval needs the manager role (org owner/admin).</p>}
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
          {final && q.accepted_baseline && <DeliveryPanel quoteId={id} contractCents={q.accepted_baseline.contractCents} onGate={applyGate} section="quotation" />}
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
          {final && !gate.requires && <Alert tone="info">This quotation was approved before customer acceptance was introduced, so it is grandfathered: a Project does not depend on a recorded acceptance. A response can still be recorded if the customer gives one.</Alert>}
          {final && q.accepted_baseline && <AcceptancePanel quoteId={id} onGate={applyGate} />}
        </div>
      )}

      {/* ───────────── 6 · PROJECT HANDOVER ───────────── */}
      {stage === 6 && !hold(6) && (
        <div className="mt-6 space-y-6">
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
                  ["Pricing basis", q.accepted_baseline.pricing.basis],
                  ["Overrides · exclusions · price resolutions", `${q.accepted_baseline.overrides.length} · ${q.accepted_baseline.exclusions.length} · ${q.accepted_baseline.priceResolutions.length}`],
                  ["Seal (sha256)", `${(q.baseline_hash ?? "").slice(0, 16)}…`],
                ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-600">{k}</dt><dd className="mt-0.5 break-words font-medium text-slate-900">{v}</dd></div>)}
              </dl>
              <p className="mt-3 text-xs text-slate-600">Cin7: <strong>NOT SENT TO CIN7</strong> — the push to Cin7 comes later and is not part of the POC.</p>

              <p className="mt-2 text-xs text-slate-600">Customer: {draft.customerName || "—"} · Cin7 customer reference is taken from the latest customer snapshot when the Project is created. Physical SKU mappings are frozen with the baseline; the Project, its billing stages and the Cin7 Sale are managed in the Projects module.</p>
              <div className="mt-5 border-t border-slate-100 pt-5">
                {q.project_id ? (
                  <Link href={`/projects/${q.project_id}`} className="inline-flex h-9 items-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">Open the Project</Link>
                ) : gate.requires && !gate.accepted ? (
                  <Alert tone="info"><b>Project handover is not available yet.</b> {stages[5].summary} A Project for a new quotation is created only after the customer&apos;s acceptance of the issued quotation is recorded (with its evidence) or, if it came by email, verified in <button type="button" className="underline" onClick={() => goStage(5)}>Customer Acceptance</button>. Nothing is created automatically.</Alert>
                ) : (
                  <>
                  {gate.requires ? <p className="mb-2 text-sm text-slate-600">The Project will use the billing schedule printed on the quotation the customer accepted.</p> : <ScheduleChooser contractCents={q.accepted_baseline.contractCents} onChange={setScheduleChoice} />}
                  <p className="mb-2"><BuildStamp /></p>
                  {!roles.has("manager") ? <Alert tone="info">A Manager creates the Project from the accepted quotation after verifying the customer&apos;s acceptance. You will be able to open it from here once it exists.</Alert> : <Button loading={acts.isPending("handover")} aria-describedby={isWorking || (!gate.requires && !resolveScheduleChoice(scheduleChoice).ok) ? "handover-why" : undefined} disabled={isWorking || (!gate.requires && !resolveScheduleChoice(scheduleChoice).ok)} onClick={() => void acts.run("handover", async () => {
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
        </div>
      )}
    </main>
  );
}
