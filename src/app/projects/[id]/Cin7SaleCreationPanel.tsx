"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import type { Reconciled } from "@/components/ui/action-feedback";
import { Feedback, type RunFn } from "./feedback-context";
import { DisabledReason } from "./DisabledReason";
import { Status, statusText } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StepRail, StepPanel } from "@/components/ui/StepRail";
import { nextIncompleteStepId } from "@/components/ui/step-rail-model";
import { useShowAllSteps } from "@/components/ui/use-show-all-steps";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { SALE_STEP_IDS, SALE_STEP_LABEL, referencesKey, saleRequirements, saleSteps, type SaleStepId } from "@/lib/projects/cin7-sale-steps";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { isP0Disposable } from "@/lib/projects/p0-project";
import type { P0Report } from "@/lib/projects/p0-checklist";
import { CREATE_CONFIRMATION_TEXT } from "@/lib/projects/cin7-sale-creation";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { VariationProductPicker, type PickedProduct } from "./VariationProductPicker";
import type { PackageMapping } from "@/lib/projects/package-mapping-store";
import { getCin7ReferenceOptionsAction, type Cin7ReferenceOptions, createCin7SaleAction, getPackageMappingAction, getCin7SaleCreationStatusAction, reconcileCin7SaleCreationAction, resolveScopeItemAction, runP0ChecklistAction, type Cin7SaleCreationStatus } from "../cin7-actions";

// Create the project's Cin7 ADVANCED SALE. The physical products come from the project's APPROVED PRODUCT SCOPE (inherited from the quotation,
// or from the variation): nobody types or picks SKUs here. Anything the scope cannot identify as a real Cin7 SKU is listed as a blocker and
// can only be resolved by a manager with a recorded reason (map to a real SKU, or exclude). The server re-checks the rollout flag, the org, the
// manager role, the state and the confirmation, validates the customer and every SKU read-only before storing any intent, and links the Sale
// only after reading it back and verifying it matches the plan exactly.
const TONE: Record<string, BadgeTone> = { PENDING: "warning", CREATED: "warning", RECONCILED: "success", FAILED_CONFIRMED_NO_WRITE: "warning", FAILED_UNCERTAIN: "danger" };

export function Cin7SaleCreationPanel({ view, run, working, boot }: { view: ProjectView; run: RunFn; working: boolean; boot: Cin7SaleCreationStatus | null }) {
  const uid = useId(); // ids are unique per mounted workspace: several can be on one page (embedded per variation, hidden-but-mounted)
  const projectId = view.project.id;
  const [st, setSt] = useState<Cin7SaleCreationStatus | null>(boot); // the initial record arrives with the tab (one round trip for the whole Commercial tab)
  // A disposable P0 project already knows its customer and location (entered when it was prepared); everything else stays explicit.
  const isP0Project = isP0Disposable(view.project.originating_quote_ref);
  const [customer, setCustomer] = useState(view.project.customer_name ?? "");
  const [location, setLocation] = useState(isP0Project ? "MSTR" : "");
  const [account, setAccount] = useState("");
  const [taxRule, setTaxRule] = useState("Standard Rate Sales");
  // After a request whose outcome was lost, a Sale may exist in Cin7: nothing may be retried until the creation record has been RE-READ.
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false); // the last re-read failed: stay blocked
  const [confirmed, setConfirmed] = useState(false); // unchecked by default; the server still requires the confirmation token, the flag, the instance pin and refuses a second Sale
  // Choose Location and Revenue Account from Cin7's own lists (read-only). If the lists cannot be read, the typed fields stay available.
  const [refs, setRefs] = useState<Cin7ReferenceOptions | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [typedAccounts, setTypedAccounts] = useState(false);
  const [p0, setP0] = useState<P0Report | null>(null);
  const [p0Error, setP0Error] = useState<string | null>(null);
  const [p0Busy, setP0Busy] = useState(false);
  const [saved, setSaved] = useState<Record<string, { packageKey: string; unavailable: boolean; active: PackageMapping | null }>>({});
  const [saveReuse, setSaveReuse] = useState<Record<string, boolean>>({});
  const [multi, setMulti] = useState<Record<string, PickedProduct[]>>({});
  const [res, setRes] = useState<Record<string, { sku: string; quantity: string; reason: string }>>({});
  // Guided steps (navigation only; no action is ever called by moving between them). Start on the last step when a creation record already exists.
  const [stepId, setStepId] = useState<SaleStepId>(boot?.creation ? "confirm" : "scope");
  const [showAll, setShowAll] = useShowAllSteps("nq-sale-show-all");
  const [p0Key, setP0Key] = useState<string | null>(null); // the references the shown pre-flight result was run with
  // Typed-but-uncreated work: references that differ from where the form started, an unsaved per-item reason or an unsaved product pick. Gone once the Sale is requested.
  const startCustomer = useState(view.project.customer_name ?? "")[0];
  const startLocation = useState(isP0Project ? "MSTR" : "")[0];
  const pending = st?.scopeItems.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution) ?? [];
  const typedRefs = customer !== startCustomer || location !== startLocation || account !== "" || taxRule !== "Standard Rate Sales";
  const typedItems = pending.some((i) => (res[i.id]?.reason ?? "").trim() !== "" || (multi[i.id] ?? []).length > 0);
  useUnsavedGuard(!!st && !st.creation && (typedRefs || typedItems));

  // The Cin7 location / account lists are a LIVE Cin7 read (credentials + paged requests). They are only the options of the Create form, so they are fetched only when
  // that form is actually shown: a manager, on a project that has no Sale yet. They were read on every open of the tab, for every project and every variation.
  const needsLists = !!st && st.gates.orgEnabled && st.gates.isManager && !st.linked && !st.creation;
  useEffect(() => {
    if (!needsLists) return;
    let live = true;
    getCin7ReferenceOptionsAction(projectId).then((r) => { if (!live) return; if (r.ok && r.data) { setRefs(r.data); setRefsError(null); } else setRefsError(r.error ?? "The Cin7 lists could not be loaded."); });
    return () => { live = false; };
  }, [projectId, needsLists]);
  /** Re-reads the creation record. Null when the read failed (callers must then treat the outcome as unknown). */
  const reload = useCallback(async (): Promise<Cin7SaleCreationStatus | null> => {
    try {
      const r = await getCin7SaleCreationStatusAction(projectId);
      if (r.ok && r.data) { setSt(r.data); setUncertain(false); return r.data; }
    } catch { /* treated as a failed read below */ }
    return null;
  }, [projectId]);

  if (!st || !st.gates.orgEnabled) return null;
  const { gates, creation } = st;
  if (st.linked && !creation) return null; // a manually linked Sale: nothing to create
  // The result's own message (e.g. the reconcile outcome) is the success text, shown beside the control that ran it (key) - never at the top of the page.
  const after = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, key: string) =>
    run(async () => {
      setChecking(true);
      const r = await fn(); // a throw (lost response) leaves `checking` on: the reconcile below owns the re-read and releases it
      await reload();
      setChecking(false);
      return r;
    }, undefined, key, {
      success: (_v, res) => (res.data as { message?: string } | undefined)?.message ?? "Done.",
      exclusive: true, cin7: true,
      doneAfterReconcile: key === "sale:create" ? "The Sales Order request was recorded (its response was lost). Its state is shown below: reconcile to verify and link it." : undefined,
      reconcile: async (): Promise<Reconciled> => {
        const s2 = await reload();
        setUncertain(s2 === null); // a failed read keeps Create blocked
        setConfirmed(false);       // any retry needs a fresh, deliberate confirmation
        setChecking(false);
        if (!s2) return "unreadable";
        if (key === "sale:create") return s2.creation ? "done" : "not_done";
        if (key === "sale:reconcile") return s2.creation?.creation_state === "RECONCILED" ? "done" : "unknown";
        return "unknown";
      },
    });
  const rereading = checking || uncertain;
  const canCreate = gates.isManager && gates.writesEnabled && !working && !rereading && !creation && st.blockers.length === 0 && customer.trim() && location.trim() && account.trim() && taxRule.trim() && confirmed;
  // Why Create is disabled, in the order a person would fix it. Only facts the viewer already has (the gates and the form they are filling in); a non-manager is told only that a manager
  // is needed, never the blockers that a manager would see.
  const createReasons: string[] = [];
  if (!gates.isManager) createReasons.push("Only a manager can create the Cin7 Sales Order.");
  else {
    if (!gates.writesEnabled) createReasons.push("Cin7 writes are switched off for this organisation.");
    if (working) createReasons.push("Another action is in progress.");
    if (rereading) createReasons.push("The Cin7 status is being re-read.");
    if (st.blockers.length > 0) createReasons.push(`${st.blockers.length === 1 ? "A scope item is" : `${st.blockers.length} scope items are`} not resolved yet (see above).`);
    const missing = [["customer name", customer], ["location", location], ["revenue account", account], ["tax rule", taxRule]].filter(([, v]) => !v.trim()).map(([k]) => k);
    if (missing.length > 0) createReasons.push(`Enter the Cin7 ${missing.join(", ")}.`);
    if (!confirmed) createReasons.push("Tick the confirmation above.");
  }
  const unresolved = pending;
  const refsNow = { customer, location, account, taxRule };
  const steps = saleSteps({
    blockerCount: st.blockers.length, unresolvedCount: unresolved.length, ...refsNow,
    preflight: p0 ? { verdictReady: p0.verdict === "READY_PENDING_MANUAL", inputsKey: p0Key ?? "" } : null,
    confirmed, creationState: creation?.creation_state ?? null,
  });
  const railId = `${uid}-sale`;
  const stepNo = SALE_STEP_IDS.indexOf(stepId) + 1;
  const nextOpen = nextIncompleteStepId(steps, stepId);
  const requirements = saleRequirements({ blockerCount: st.blockers.length, unresolvedCount: unresolved.length, ...refsNow, confirmed });
  const panel = (id: SaleStepId, children: React.ReactNode) => <StepPanel railId={railId} stepId={id} number={SALE_STEP_IDS.indexOf(id) + 1} title={SALE_STEP_LABEL[id]} current={stepId === id} showAll={showAll} className="mt-4">{children}</StepPanel>;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Create the Cin7 Sales Order</PanelTitle>
        <Status tone={gates.writesEnabled ? "warning" : "neutral"}>{gates.writesEnabled ? "Cin7 writes ENABLED" : "Cin7 writes OFF"}</Status>
      </div>
      <p className="mt-1 text-sm text-slate-600">Creates ONE Advanced Sale from this project&apos;s approved product scope: the products below at R0, and the approved contract value as Additional Charges (one per billing stage). It is read back and verified before it is linked. No customer, invoice, fulfilment or stock movement is created.</p>

      <StepRail id={railId} ariaLabel="Sales Order steps" steps={steps} currentId={stepId} onSelect={(id) => setStepId(id as SaleStepId)}
        actions={(
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-800"><input type="checkbox" className="size-6" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all steps</label>
            {nextOpen
              ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => setStepId(nextOpen as SaleStepId)}>Next incomplete step</Button>
              : <span className="text-sm text-slate-700" data-testid="all-steps-complete">Every step is complete.</span>}
          </div>
        )} />

      {panel("scope", <>
      <div className="mt-4">
        <p className="text-sm font-medium text-slate-800">Products on the Sales Order (inherited from the approved scope - not typed)</p>
        {st.saleLines.length === 0 ? <p className="mt-1 text-sm text-slate-600">No physical products: a commercial-only Sale.</p> : (
          <ul className="mt-1 space-y-0.5 text-sm">{st.saleLines.map((l) => <li key={l.sku}><span className="font-mono">{l.sku}</span> x {l.quantity} <span className="text-slate-600">- {l.description} (R0)</span></li>)}</ul>
        )}
        {st.excluded.length > 0 && <p className="mt-1 text-xs text-slate-600">Excluded from the Sale by a manager: {st.excluded.map((e) => `${e.description} (${e.reason})`).join("; ")}.</p>}
      </div>

      <div className="mt-4">
        <p className="text-sm font-medium text-slate-800">Contract charges on the Sales Order (the approved billing stages)</p>
        <ul className="mt-1 space-y-0.5 text-sm">{view.stages.filter((x) => x.valueCents !== 0).map((x) => <li key={x.id}>{x.name} <span className="tabular-nums text-slate-600">- {formatCents(x.valueCents)} ex VAT</span></li>)}</ul>
      </div>

      {unresolved.length > 0 && !creation && (
        <div className="mt-4 space-y-3">
          <Alert tone="warning">The Sale cannot be created yet: {unresolved.length} scope item(s) have no authoritative Cin7 SKU. Nothing is guessed or substituted. A manager resolves each one below, with a reason.</Alert>
          {unresolved.map((i) => {
            const r = res[i.id] ?? { sku: "", quantity: String(i.quantity ?? ""), reason: "" };
            const set = (patch: Partial<typeof r>) => setRes({ ...res, [i.id]: { ...r, ...patch } });
            return (
              <div key={i.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-medium">{i.description} <span className="text-xs font-normal text-slate-600">({i.origin.section ?? "scope"})</span></p>
                <p className="text-xs text-slate-600">{i.mapping.status === "UNMAPPED" ? i.mapping.reason : ""}</p>
                {gates.isManager ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input label="Reason (required)" value={r.reason} onChange={(e) => set({ reason: e.target.value })} />
                    <Button size="sm" variant="secondary" disabled={working || !r.reason.trim()} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "EXCLUDE", reason: r.reason }), `sale:item:${i.id}`)}>Exclude from the Sale</Button>
                  </div>
                ) : <p className="mt-1 text-xs text-slate-600">A manager resolves this.</p>}
                <Feedback k={`sale:item:${i.id}`} />
                {gates.isManager ? (
                  <details open className="mt-3 rounded border border-slate-200 p-3">
                    <summary className="cursor-pointer py-1.5 text-sm font-medium text-slate-800">Map this package to Cin7 products (search the catalogue; quantities are converted)</summary>
                    <p className="mt-1 text-xs text-slate-600">Search and add each product NewQuip supplies for this package (standard stock or a Cin7 assembly; its internal components stay in Cin7). Enter how many units of each make up ONE {i.unit}; the converted quantity is shown.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Button size="sm" variant="secondary" disabled={working} onClick={async () => { const g = await getPackageMappingAction(projectId, i.id); if (g.ok && g.data) setSaved({ ...saved, [i.id]: g.data }); }}>Look for a saved mapping</Button>
                      {saved[i.id]?.unavailable && <span className="text-slate-600">Reusable mappings are not available yet (database migration pending).</span>}
                      {saved[i.id] && !saved[i.id].unavailable && !saved[i.id].active && <span className="text-slate-600">No saved mapping for {saved[i.id].packageKey} yet.</span>}
                      {saved[i.id]?.active && (
                        <span className="text-slate-700">Saved v{saved[i.id].active!.version} ({saved[i.id].active!.lines.map((l) => `${l.sku} x${l.factor}`).join(", ")}) <Button size="sm" disabled={working || !r.reason.trim()} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "MAP_LINES", useSavedVersion: saved[i.id].active!.version, reason: r.reason }), `sale:item:${i.id}`)}>Apply v{saved[i.id].active!.version} to this project</Button></span>
                      )}
                    </div>
                    <div className="mt-2"><VariationProductPicker picked={multi[i.id] ?? []} onChange={(next) => setMulti({ ...multi, [i.id]: next })} disabled={working} quantityLabel={`SKU units per 1 ${i.unit}`}
                      extra={(p) => (i.quantity ? `= ${Math.round(i.quantity * (Number(p.quantity) || 0) * 1e6) / 1e6} on the order` : "no quoted quantity")} /></div>
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <Input label="Reason (required)" value={r.reason} onChange={(e) => set({ reason: e.target.value })} />
                      <label className="flex items-center gap-1 pb-2 text-xs text-slate-600"><input type="checkbox" checked={saveReuse[i.id] ?? false} onChange={(e) => setSaveReuse({ ...saveReuse, [i.id]: e.target.checked })} /> also save as a reusable mapping (new version)</label>
                      <Button size="sm" disabled={working || !r.reason.trim() || (multi[i.id] ?? []).length === 0} onClick={() => after(() => resolveScopeItemAction(projectId, { itemId: i.id, kind: "MAP_LINES", saveAsReusable: saveReuse[i.id] ?? false, reason: r.reason, lines: (multi[i.id] ?? []).map((p) => ({ sku: p.sku, factor: Number(p.quantity), unit: i.unit })) }), `sale:item:${i.id}`)}>Save mapping</Button>
                    </div>
                  </details>
                ) : <p className="mt-1 text-xs text-slate-600">A manager resolves this.</p>}
              </div>
            );
          })}
        </div>
      )}
      </>)}

      {creation ? (<>
      {panel("refs", <p className="mt-2 text-sm text-slate-600">A Sales Order request already exists for this project, so the references can no longer be entered.</p>)}
      {panel("preflight", <p className="mt-2 text-sm text-slate-600">A Sales Order request already exists for this project, so the pre-flight check is no longer offered.</p>)}
      {panel("confirm",
        <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Status tone={TONE[creation.creation_state] ?? "neutral"}>{statusText(creation.creation_state)}</Status>
            {creation.cin7_sale_number && <span>Cin7 {creation.cin7_sale_number}</span>}</div>
          {creation.last_error_message && <Alert tone={creation.creation_state === "FAILED_UNCERTAIN" ? "danger" : "warning"}>{creation.last_error_message}</Alert>}
          {creation.creation_state !== "RECONCILED" && creation.creation_state !== "FAILED_CONFIRMED_NO_WRITE" && (
            <Button size="sm" variant="secondary" disabled={working || !gates.isManager} aria-describedby={working || !gates.isManager ? `${uid}-sale-reconcile-reason` : undefined} onClick={() => after(() => reconcileCin7SaleCreationAction(projectId), "sale:reconcile")}>Reconcile with Cin7 (read-only)</Button>
          )}
          {creation.creation_state !== "RECONCILED" && creation.creation_state !== "FAILED_CONFIRMED_NO_WRITE" && (working || !gates.isManager) && <DisabledReason id={`${uid}-sale-reconcile-reason`}>{!gates.isManager ? "Only a manager can reconcile the Sales Order with Cin7." : "Reconcile is disabled while another action is in progress."}</DisabledReason>}
          <Feedback k="sale:reconcile" />
          <Feedback k="sale:create" />{/* the Create form is gone once a record exists, so a "recorded" message about it must show here */}
          {creation.creation_state === "FAILED_UNCERTAIN" && <p className="text-xs text-slate-600">Do not retry. Reconcile first; if a Sale exists but is incomplete, complete or void it in Cin7. An administrator can use the recovery option on the Cin7 Core panel only if the existing Sale is verifiably this project&apos;s.</p>}
        </div>)}
      </>) : (<>
      {panel("refs",
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Input label="Cin7 customer name (must already exist)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            {refs && !typedAccounts ? (
              <Select label="Cin7 location" value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">Choose a location…</option>
                {refs.locations.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
            ) : <Input label="Cin7 location" value={location} onChange={(e) => setLocation(e.target.value)} />}
            {refs && !typedAccounts ? (
              <Select label="Revenue account" value={account} onChange={(e) => setAccount(e.target.value)} helperText="Only revenue accounts Cin7 is proven to accept can be chosen.">
                <option value="">Choose an account…</option>
                {refs.accounts.map((a) => <option key={a.code} value={a.code} disabled={!a.selectable} title={a.note}>{a.code} · {a.name}{a.selectable ? "" : ` (${a.group === "LIABILITY" ? "balance sheet, not yet verified" : a.group === "SYSTEM" ? "system account" : a.group === "INACTIVE" ? "inactive" : "not a revenue account"})`}</option>)}
              </Select>
            ) : <Input label="Revenue account code" value={account} onChange={(e) => setAccount(e.target.value)} />}
            <Input label="Cin7 tax rule name" value={taxRule} onChange={(e) => setTaxRule(e.target.value)} />
          </div>
          {refsError && <p className="text-xs text-amber-700">The Cin7 lists could not be loaded ({refsError}). Type the location and account code instead; they are still checked before anything is created.</p>}
          {refs && <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={typedAccounts} onChange={(e) => setTypedAccounts(e.target.checked)} /> Type the location and account manually instead</label>}
        </div>)}
      {panel("preflight",
        <div className="mt-4 space-y-3">
          <details open className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer py-1.5 text-sm text-slate-700">Optional: run the read-only pre-flight check</summary>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" disabled={p0Busy || working || !gates.isManager} onClick={async () => {
                setP0Busy(true); setP0Error(null);
                const r = await runP0ChecklistAction(projectId, { customerName: customer, location, taxRule, revenueAccount: account, skus: st.saleLines.map((l) => ({ sku: l.sku, quantity: l.quantity })) });
                setP0(r.ok && r.data ? r.data : null); setP0Key(referencesKey(refsNow)); setP0Error(r.ok ? null : r.error ?? "P0 failed to run"); setP0Busy(false);
              }}>{p0Busy ? "Reading Cin7…" : "Run P0 checklist (read-only)"}</Button>
              <span className="text-xs text-slate-600">Reads only. Fails explicitly; never picks a customer, instance or database for you. The VAT rate comes from the project ({(view.project.tax_rate_bps / 100).toFixed(2)}%); the tax rule name is the Cin7 one entered above.</span>
            </div>
            {p0Error && <div className="mt-3"><Alert tone="danger">{p0Error}</Alert></div>}
            {p0 && (
              <div className="mt-3">
                <Alert tone={p0.verdict === "READY_PENDING_MANUAL" ? "info" : "danger"}>{p0.verdict === "READY_PENDING_MANUAL" ? `Automated checks passed (${p0.counts.PASS}); confirm the ${p0.counts.MANUAL} manual items below before P1.` : `NOT READY: ${p0.counts.FAIL} failed, ${p0.counts.NOT_RUN} not run.`}</Alert>
                <ul className="mt-2 space-y-1 text-sm">
                  {p0.checks.map((k) => (
                    <li key={k.id} className="flex gap-2"><Status tone={k.status === "PASS" ? "success" : k.status === "FAIL" ? "danger" : k.status === "MANUAL" ? "warning" : "neutral"}>{statusText(k.status)}</Status><span><span className="font-medium">{k.label}.</span> <span className="text-slate-600">{k.detail}</span></span></li>
                  ))}
                </ul>
              </div>
            )}
          </details>
        </div>)}
      {panel("confirm",
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-sm text-slate-800"><input type="checkbox" className="mt-1 size-6 shrink-0" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> <span>I confirm I want to create one Cin7 Sales Order for this project. This creates a real order in the connected Cin7 instance, and only one can ever be created for a project.</span></label>
          {rereading && <Alert tone="warning">{checking ? "Checking the current Cin7 status. Create stays disabled until the record has been re-read." : "The outcome of the last request could not be confirmed and the status could not be re-read. Reload the page. Create stays disabled until the status has been read."}</Alert>}
          <Button className="min-h-11" disabled={!canCreate} aria-describedby={!canCreate && createReasons.length > 0 ? `${uid}-sale-create-reason` : undefined} onClick={() => after(() => createCin7SaleAction(projectId, { confirmation: CREATE_CONFIRMATION_TEXT, customerName: customer, location, revenueAccount: account, cin7TaxRule: taxRule }), "sale:create")}>Create Sales Order in Cin7</Button>
          {!canCreate && createReasons.length > 0 && <DisabledReason id={`${uid}-sale-create-reason`}>Create is disabled: {createReasons.join(" ")}</DisabledReason>}
          {gates.isManager && (
            <ul className="space-y-0.5 text-sm" aria-label="What Create needs" data-testid="sale-requirements">
              {requirements.map((q) => <li key={q.id} data-met={q.met ? "true" : "false"} className={q.met ? "text-emerald-800" : "text-slate-700"}><span aria-hidden>{q.met ? "✓ " : "○ "}</span>{q.label}: {q.met ? "done" : "still to do"}</li>)}
            </ul>
          )}
          <Feedback k="sale:create" />
        </div>)}
      </>)}

      {!showAll && (
        <div className="mt-4 flex items-center justify-between gap-3" data-testid="sale-step-nav">
          {stepNo > 1 ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => setStepId(SALE_STEP_IDS[stepNo - 2])}>Back</Button> : <span />}
          {stepNo < SALE_STEP_IDS.length ? <Button type="button" className="min-h-11" onClick={() => setStepId(SALE_STEP_IDS[stepNo])}>Next</Button> : <span />}
        </div>
      )}
    </Panel>
  );
}
