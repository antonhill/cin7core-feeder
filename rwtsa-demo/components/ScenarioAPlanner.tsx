import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { RedFlagModel, ResultRow } from "@/rwtsa-demo/state/red-flag-model";

const n0 = (v: number): string => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const dash = "-";
const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";
const btn = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold";
const CLASS_TEXT = { ordinary: "ORDINARY REPLENISHMENT", tender: "TENDER / CUSTOMER-ORDER-ONLY", unclassified: "UNCLASSIFIED" } as const;
const CLASS_TONE = { ordinary: "success", tender: "neutral", unclassified: "warning" } as const;
const SOURCE_TEXT = { planner: "set by the planner on this page", workbook: "from the workbook (Items tender marker)", none: "no source: neither the workbook nor the planner has classified it" } as const;

function Hidden({ sku, returnTo, action }: { sku: string; returnTo: string; action: string }) {
  return (
    <>
      <input type="hidden" name="sku" value={sku} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="action" value={action} />
    </>
  );
}

/** Planner controls for the selected SKU: classification, temporary minimum, order override, local-make assumption. Plain forms, no script. */
export function ScenarioAPlanner({ model, returnTo }: { model: RedFlagModel; returnTo: string }) {
  const r = model.result;
  if (!r) return null;
  const rows = model.rows.filter((x): x is ResultRow & { sku: string } => x.sku !== null && x.planner !== null);
  const sel = rows.find((x) => x.key === model.settings.sel) ?? rows.find((x) => x.planner?.classification === "unclassified") ?? rows[0] ?? null;
  const decided = rows.filter((x) => x.planner && (x.planner.classificationSource === "planner" || x.planner.minOverride || x.planner.override || x.planner.localMake.entry));
  const stock = r.config.stockDate;
  return (
    <Panel>
      <span id="planner" />
      <PanelTitle>Planner decisions</PanelTitle>
      <p className="mt-1 text-sm text-slate-600">
        Decisions are saved on this machine only, outside the repository, and never change the workbook. Nothing here creates or authorises a purchase order in Cin7 or anywhere else.
      </p>
      {model.settings.view !== "sku" || !sel || !sel.planner ? (
        <p data-testid="planner-need-sku" className="mt-3 text-sm text-slate-700">Switch to the SKU view and select a SKU to classify it, set a temporary minimum, override its order or enter a local-make assumption.</p>
      ) : (
        <div data-testid="planner-selected" data-sku={sel.sku} className="mt-3 grid gap-6 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold text-slate-900">{sel.sku}</p>
            <div className="mt-2 text-sm text-slate-800" data-testid="planner-class">
              <Badge tone={CLASS_TONE[sel.planner.classification]}>{CLASS_TEXT[sel.planner.classification]}</Badge>
              <p className="mt-1 text-xs text-slate-600" data-testid="planner-class-source">Source: {SOURCE_TEXT[sel.planner.classificationSource]}{sel.planner.classificationReason ? `. Note: ${sel.planner.classificationReason}` : ""}.</p>
              {sel.planner.classification === "tender" && <p className="mt-1 text-xs text-slate-600">Demand history and projected inventory risk continue. No standing replenishment proposal and no standing minimum: risk is a stock-out below zero.</p>}
              {sel.planner.classification === "unclassified" && <p className="mt-1 text-xs text-amber-800">Its proposed order is withheld until you classify it. Demand and projected shortfall are still calculated.</p>}
            </div>
            <form method="post" action="/api/planner" className="mt-2 flex flex-wrap items-center gap-2">
              <Hidden sku={sel.sku} returnTo={returnTo} action="classify" />
              <select name="value" aria-label={`Classification for ${sel.sku}`} defaultValue={sel.planner.classificationSource === "planner" ? sel.planner.classification : "ordinary"} className={field}>
                <option value="ordinary">Ordinary replenishment SKU</option>
                <option value="tender">Tender / customer-order-only SKU</option>
                <option value="clear">Unclassified (remove my choice)</option>
              </select>
              <input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Classification note" className={`${field} w-44`} />
              <button type="submit" className={btn}>Save classification</button>
            </form>

            <p className="mt-4 text-sm font-semibold text-slate-900">Minimum stock level</p>
            <div data-testid="planner-min" className="mt-1 text-sm text-slate-800">
              <span data-testid="min-original" data-value={sel.planner.originalMin ?? ""}>Original (workbook): {sel.planner.originalMin === null ? "none" : n0(sel.planner.originalMin)}</span>
              {" | "}
              <span data-testid="min-effective" data-value={sel.planner.effectiveMin ?? ""}>Effective at {stock}: {sel.planner.classification === "tender" ? "none (tender: stock-out risk only)" : sel.planner.effectiveMin === null ? "none" : n0(sel.planner.effectiveMin)}</span>
            </div>
            {sel.planner.minOverride && (
              <p data-testid="min-override" className="mt-1 text-xs text-slate-700">
                Temporary minimum {n0(sel.planner.minOverride.replacement)} from {sel.planner.minOverride.effectiveFrom} {sel.planner.minOverride.expires ? `to ${sel.planner.minOverride.expires}` : "until removed"}; in force in {sel.planner.minOverride.activeWeeks} of {r.config.horizonWeeks} projection weeks. Reason: {sel.planner.minOverride.reason}
              </p>
            )}
            <form method="post" action="/api/planner" className="mt-2 flex flex-wrap items-end gap-2 text-sm">
              <Hidden sku={sel.sku} returnTo={returnTo} action="min-set" />
              <label className="flex flex-col gap-1 text-xs">Replacement minimum<input name="replacement" required inputMode="decimal" className={`${field} w-24`} /></label>
              <label className="flex flex-col gap-1 text-xs">Effective from<input name="effectiveFrom" type="date" required defaultValue={stock} className={field} /></label>
              <label className="flex flex-col gap-1 text-xs">Expires<input name="expires" type="date" className={field} /></label>
              <label className="flex items-center gap-1 text-xs"><input name="untilRemoved" type="checkbox" value="1" />Until I remove it</label>
              <label className="flex flex-col gap-1 text-xs">Reason (required)<input name="reason" required maxLength={500} className={`${field} w-44`} /></label>
              <button type="submit" className={btn}>Set temporary minimum</button>
            </form>
            {sel.planner.minOverride && (
              <form method="post" action="/api/planner" className="mt-1">
                <Hidden sku={sel.sku} returnTo={returnTo} action="min-remove" />
                <button type="submit" className={btn}>Remove temporary minimum</button>
              </form>
            )}
          </div>

          <div>
            <p className="text-sm font-semibold text-slate-900">Replenishment proposal</p>
            <div data-testid="planner-order" data-state={sel.proposalWithheld ? "withheld" : "value"} className="mt-1 text-sm text-slate-800">
              <p>Formula: {sel.planner.formula === "net-requirement" ? "RFP DP-13 net requirement" : "minimum-shortfall demonstration formula (previously defined; not RWTSA-approved policy)"} (change it in the controls).</p>
              {sel.proposalWithheld ? (
                <p className="text-amber-800">Withheld: classify this SKU first.</p>
              ) : (
                <>
                  <p>Calculated: <span data-testid="order-calculated" data-value={sel.planner.calculated ?? ""}>{sel.planner.calculated === null ? "cannot be calculated" : sel.planner.classification === "tender" ? "0 (tender: none)" : n0(sel.planner.calculated)}</span></p>
                  <p>Planner-adjusted: <span data-testid="order-adjusted" data-value={sel.planner.adjusted ?? ""}>{sel.planner.override ? n0(sel.planner.override.quantity) : "none: the calculated proposal stands"}</span></p>
                  {sel.planner.override && <p className="text-xs text-slate-700">Override reason: {sel.planner.override.reason}. Saved {sel.planner.override.savedAt}; the calculation is not re-checked against it, so review it when the data or settings change.</p>}
                </>
              )}
            </div>
            {sel.planner.classification === "ordinary" ? (
              <>
                <form method="post" action="/api/planner" className="mt-2 flex flex-wrap items-end gap-2">
                  <Hidden sku={sel.sku} returnTo={returnTo} action="override-set" />
                  <label className="flex flex-col gap-1 text-xs">Override quantity<input name="quantity" required inputMode="numeric" className={`${field} w-24`} /></label>
                  <label className="flex flex-col gap-1 text-xs">Reason (required)<input name="reason" required maxLength={500} className={`${field} w-44`} /></label>
                  <button type="submit" className={btn}>Override quantity</button>
                </form>
                {sel.planner.override && (
                  <form method="post" action="/api/planner" className="mt-1">
                    <Hidden sku={sel.sku} returnTo={returnTo} action="override-reverse" />
                    <button type="submit" className={btn}>Reverse override</button>
                  </form>
                )}
              </>
            ) : (
              <>
                <p data-testid="override-ineligible" className="mt-2 text-xs text-slate-600">An order override needs an ordinary replenishment SKU: a tender or unclassified SKU cannot be overridden into an order.</p>
                {sel.planner.heldOverride && (
                  <form method="post" action="/api/planner" className="mt-1" data-testid="held-override">
                    <Hidden sku={sel.sku} returnTo={returnTo} action="override-reverse" />
                    <p className="text-xs text-amber-800">A saved override of {n0(sel.planner.heldOverride.quantity)} is on hold while this SKU is not ordinary (reason: {sel.planner.heldOverride.reason}). It returns if the SKU becomes ordinary again.</p>
                    <button type="submit" className={btn}>Reverse held override</button>
                  </form>
                )}
              </>
            )}

            <p className="mt-4 text-sm font-semibold text-slate-900">Local 7th Wave make (DP-14)</p>
            <div data-testid="localmake" data-status={sel.planner.localMake.status} className="mt-1 text-sm text-slate-800">
              <Badge tone={sel.planner.localMake.status === "EVALUATED" ? "warning" : "neutral"}>{sel.planner.localMake.status}</Badge>
              {sel.planner.localMake.reason && <p className="mt-1 text-xs text-slate-700">{sel.planner.localMake.reason}</p>}
              {sel.planner.localMake.label && <p className="mt-1 text-xs font-semibold text-amber-800">{sel.planner.localMake.label}</p>}
              {sel.planner.localMake.status === "EVALUATED" && (
                <ul className="mt-1 text-xs text-slate-800">
                  <li>Gross shortage (calculated requirement): <span data-testid="make-gross">{n0(sel.planner.localMake.gross as number)}</span></li>
                  <li>Local make counted within the {r.config.horizonWeeks}-week horizon: <span data-testid="make-counted">{n0(sel.planner.localMake.localCounted)}</span></li>
                  <li>Residual import requirement: <span data-testid="make-residual">{n0(sel.planner.localMake.residualImport as number)}</span></li>
                </ul>
              )}
              <p className="mt-1 text-xs text-slate-600">Local make is not received stock and is never added to Available or inbound; it only reduces the requirement left after the imports already counted. The gross shortage is the calculated requirement (before any planner override) over the whole horizon: local make is not matched to the week of the first shortage.</p>
            </div>
            {sel.planner.classification === "ordinary" && (
              <>
                <form method="post" action="/api/planner" className="mt-2 flex flex-wrap items-end gap-2">
                  <Hidden sku={sel.sku} returnTo={returnTo} action="make-set" />
                  <label className="flex flex-col gap-1 text-xs">Local-make quantity<input name="quantity" required inputMode="numeric" className={`${field} w-24`} /></label>
                  <label className="flex flex-col gap-1 text-xs">Capacity (units)<input name="capacity" required inputMode="numeric" className={`${field} w-24`} /></label>
                  <label className="flex flex-col gap-1 text-xs">Lead time (weeks)<input name="leadTime" required inputMode="numeric" className={`${field} w-20`} /></label>
                  <label className="flex flex-col gap-1 text-xs">Completion week<input name="completionWeek" required inputMode="numeric" className={`${field} w-20`} /></label>
                  <button type="submit" className={btn}>Save assumption</button>
                </form>
                {sel.planner.localMake.entry && (
                  <form method="post" action="/api/planner" className="mt-1">
                    <Hidden sku={sel.sku} returnTo={returnTo} action="make-remove" />
                    <button type="submit" className={btn}>Remove assumption</button>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <p className="mt-6 text-sm font-semibold text-slate-900">Decisions in force</p>
      {decided.length === 0 ? (
        <p data-testid="no-planner-decisions" className="mt-1 text-sm text-slate-700">None. Every SKU uses the workbook&apos;s values and the calculated proposal.</p>
      ) : (
        <div className="mt-2 overflow-x-auto" data-testid="planner-decisions">
          <Table>
            <THead>
              <TR>
                <TH>SKU</TH>
                <TH>Class</TH>
                <TH align="right">Min: original</TH>
                <TH align="right">Min: effective</TH>
                <TH align="right">Calculated</TH>
                <TH align="right">Planner-adjusted</TH>
                <TH>Local make</TH>
              </TR>
            </THead>
            <TBody>
              {decided.map((x) => (
                <TR key={x.key}>
                  <TD>
                    <span data-testid="decision-row" data-sku={x.sku} />
                    {x.sku}
                  </TD>
                  <TD>{CLASS_TEXT[(x.planner as NonNullable<typeof x.planner>).classification]}</TD>
                  <TD align="right" numeric>{(x.planner as NonNullable<typeof x.planner>).originalMin === null ? dash : n0((x.planner as NonNullable<typeof x.planner>).originalMin as number)}</TD>
                  <TD align="right" numeric>{(x.planner as NonNullable<typeof x.planner>).effectiveMin === null ? dash : n0((x.planner as NonNullable<typeof x.planner>).effectiveMin as number)}</TD>
                  <TD align="right" numeric>{x.proposalWithheld ? "Withheld" : (x.planner as NonNullable<typeof x.planner>).calculated === null ? dash : n0((x.planner as NonNullable<typeof x.planner>).calculated as number)}</TD>
                  <TD align="right" numeric>{x.proposalWithheld ? "Withheld" : (x.planner as NonNullable<typeof x.planner>).override ? n0((x.planner as NonNullable<typeof x.planner>).override!.quantity) : dash}</TD>
                  <TD>{(x.planner as NonNullable<typeof x.planner>).localMake.status}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
