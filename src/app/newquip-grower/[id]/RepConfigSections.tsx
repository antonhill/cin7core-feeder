"use client";

import { Status } from "@/components/ui/Status";
import { GROWER_RULES, CCM_FEEDER_CAPACITY_PIGS, PIGS_PER_DRINKER } from "@/newquip/grower/rules";
import { CHARGE_LABEL, type BridgeLine, type ChargeKey } from "@/newquip/grower/quote-bridge";
import { valueKindOf, VALUE_KIND_LABEL, type ValueKind } from "@/newquip/grower/bom-view";
import { mappingControlFor } from "@/newquip/grower/mapping-access";
import { ESTIMATOR_LINE_STATUSES } from "@/newquip/quote/stage1-steps";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { GrowerItemKey } from "@/newquip/grower/types";
import type { BadgeTone } from "@/components/ui/Badge";
import { ProductMappingPicker } from "./ProductMappingPicker";
import { fmtZar, NumField, TextField } from "../fields";

// The Rep's configuration sections, shared by Stage 1 (step 3 "Equipment & options": Quantities, Charges & assumptions, Exclusions) and by Stage 2 once the quotation is with the
// Estimator. They are the SAME components, props and handlers that used to sit in Stage 2: nothing is duplicated and nothing about validation or recalculation changed. Product MAPPING and
// MANUAL QUOTATION PRICES are Estimator-owned and stay in Stage 2; Stage 1 shows them as read-only rows that name the owner. Presentation only: the server re-checks every action.

type Edit = (fn: (d: QuoteDraft) => void) => void;
const KIND_TONE: Record<ValueKind, BadgeTone> = { auto_calculated: "success", default_suggested: "info", estimator_input_required: "warning", estimator_input: "neutral" };
export const CHARGE_HELP: Record<ChargeKey, string> = {
  delivery: "From the courier invoice — truck size × truck price; distance affects it.",
  installation: "From the teams' service reports — days × daily rate.",
  concrete_slat_delivery: "Truck price ÷ slat weight, by distance.",
};

/**
 * The per-line decisions table. `mode="estimator"` is the Stage 2 table with the mapping chooser (Estimator-owned); `mode="rep"` is the Stage 1 "Quantities" table, where the Product cell
 * is read-only and names the owner when the Estimator still has to map the item. `quantitiesEditable` says whether the quantity inputs are live (the surrounding fieldset also disables them).
 */
export function LineDecisionsTable({ draft, ev, edit, roles, editable, mode, quantitiesEditable }: {
  draft: QuoteDraft; ev: QuoteEvaluation; edit: Edit; roles: ReadonlySet<string>; editable: boolean; mode: "rep" | "estimator"; quantitiesEditable: boolean;
}) {
  const cfg = draft.config;
  const budget = ev.budget;
  const bridgeByKey = new Map<string, BridgeLine>((budget?.lines ?? []).map((b) => [b.itemKey, b]));
  const rep = mode === "rep";
  return (
    <div className="mt-4 overflow-x-auto">
      <table className={`w-full text-left text-sm ${rep ? "min-w-[760px]" : "min-w-[1080px]"}`} aria-label={rep ? "Quantities per room" : "Line decisions"}>
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
            <th className="py-2 pr-3">Item</th><th className="py-2 pr-3">Basis</th><th className="py-2 pr-3">Quantity per room</th><th className="py-2 pr-3 text-right">Project qty</th>
            <th className="py-2 pr-3">Product</th>{!rep && <th className="py-2 pr-3 text-right">Line total (ex VAT)</th>}<th className="py-2">Status</th>
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
            const estimatorOwned = !!b && !b.sku && ESTIMATOR_LINE_STATUSES.has(b.status);
            return (
              <tr key={l.itemKey} className={`border-b border-slate-100 align-top ${l.exclusionReason ? "bg-amber-50" : optionalOff ? "bg-slate-50" : ""}`}>
                <td className="py-3 pr-3"><div className="font-medium text-slate-900">{l.label}</div><div className="font-mono text-xs text-slate-600">{l.ruleId}</div>
                  {l.exclusionReason && <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-amber-900"><Status tone="warning">Excluded</Status>{l.exclusionReason}</div>}
                  {optionalOff && <div className="mt-1"><Status tone="neutral">Not selected</Status></div>}</td>
                <td className="py-3 pr-3"><Status tone={l.overrideState === "manual_override" ? "warning" : KIND_TONE[kind]}>{l.overrideState === "manual_override" ? "OVERRIDE" : VALUE_KIND_LABEL[kind]}</Status>
                  <div className="mt-1 text-xs text-slate-600">{rule.treatment.replace(/_/g, " ")}</div></td>
                <td className="py-3 pr-3 min-w-[230px]">
                  {rule.estimatorEntry && l.basis !== "not_selected" && (
                    quantitiesEditable ? <NumField label="" value={cfg.estimatorQuantities?.[k] ?? null} onChange={(v) => edit((d) => { d.config.estimatorQuantities = { ...d.config.estimatorQuantities }; if (v == null) delete d.config.estimatorQuantities[k]; else d.config.estimatorQuantities[k] = v; })}
                      hint={l.itemKey === "feeder" ? `Capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs/feeder · ${cfg.pigsPerRoom} pigs/room. You confirm the number.` : l.itemKey === "cup_drinker" ? `Suggested ${l.suggestedQuantityPerRoom ?? "—"} (${cfg.pigsPerRoom} ÷ ${PIGS_PER_DRINKER}, unrounded). You confirm the number.` : l.itemKey === "flex_auger" ? "Number of M75 systems per room (client preference)" : "Enter the quantity"} />
                      : <span className="tabular-nums text-slate-800" data-testid={`qty-readonly-${l.itemKey}`}>{cfg.estimatorQuantities?.[k] ?? <span className="text-amber-800">not entered</span>}</span>
                  )}
                  {l.itemKey === "penning_package" && <span className="text-slate-700">{l.quantityPerRoom == null ? <span className="text-amber-700">{l.inputRequired ?? "Enter the running metres in step 3"}</span> : `${l.quantityPerRoom} rm`}</span>}
                  {!rule.estimatorEntry && rule.defaultCompute && (
                    <div className="space-y-1">
                      <div className="text-xs text-slate-600">Default <strong>{l.defaultQuantityPerRoom ?? "—"}</strong>{l.itemKey === "led_light" ? " = ceil(area ÷ 25)" : " = 1 per feeder"}</div>
                      {quantitiesEditable ? <NumField label="" placeholder="Override (blank = default)" value={cfg.quantityOverrides?.[k] ?? null} onChange={(v) => edit((d) => { d.config.quantityOverrides = { ...d.config.quantityOverrides }; if (v == null) delete d.config.quantityOverrides[k]; else d.config.quantityOverrides[k] = v; })} />
                        : cfg.quantityOverrides?.[k] != null && <span className="text-xs text-slate-800">Override {cfg.quantityOverrides[k]}</span>}
                      {quantitiesEditable && cfg.quantityOverrides?.[k] != null && (
                        <TextField label="" placeholder="Reason for the override (required)" value={cfg.quantityOverrideReasons?.[k] ?? ""} onChange={(v) => edit((d) => { d.config.quantityOverrideReasons = { ...d.config.quantityOverrideReasons, [k]: v }; })} />
                      )}
                    </div>
                  )}
                  {l.basis === "not_selected" && !l.exclusionReason && <span className="text-xs text-slate-700">Optional equipment is not included. Choose “Included” above to add it.</span>}
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">{l.projectQuantity ?? "—"}</td>
                <td className="py-3 pr-3 text-xs text-slate-700">{rep ? (
                  b?.sku ? b.sku : estimatorOwned ? <span className="text-amber-800" data-testid={`owner-row-${l.itemKey}`}>Estimator mapping needed: {l.label}</span> : b?.pricedBy === "penning_rate" ? "Pig-size / running-metre basis" : b?.pricedBy === "estimator_input" ? "Priced from your system price" : b?.pricedBy === "estimator_resolution" ? "Estimator-resolved" : "—"
                ) : mapControl === "chooser" ? (
                  <div className="min-w-[280px]" data-testid={`mapping-chooser-${l.itemKey}`}>
                    <ProductMappingPicker label={l.label} value={draft.estimator.confirmedMappings[l.itemKey]}
                      onChange={(sku) => edit((d) => { if (sku) d.estimator.confirmedMappings[l.itemKey] = sku; else delete d.estimator.confirmedMappings[l.itemKey]; })} />
                  </div>
                ) : mapControl === "waiting_for_estimator" && !b?.sku ? <span className="text-amber-800">Awaiting an Estimator to choose the Cin7 product.</span> : b?.sku ?? (b?.pricedBy === "penning_rate" ? "Pig-size / running-metre basis" : b?.pricedBy === "estimator_input" ? "Estimator-priced system" : b?.pricedBy === "estimator_resolution" ? "Estimator-resolved" : "—")}</td>
                {!rep && <td className="whitespace-nowrap py-3 pr-3 text-right tabular-nums">{b?.revenueExTax != null ? fmtZar(b.revenueExTax) : "—"}</td>}
                <td className="py-3 text-xs">{b ? (b.status === "priced" ? <span className="text-emerald-800"><span aria-hidden>✓ </span>Priced</span> : b.status === "not_selected" ? "" : <span className="text-amber-800">{b.reason}</span>) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Delivery / installation / slat-delivery charges, the M75 system price and the frozen assumptions (the Rep's "Charges & assumptions"). */
export function ChargesSection({ draft, edit }: { draft: QuoteDraft; edit: Edit }) {
  return (
    <>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {(["delivery", "installation", "concrete_slat_delivery"] as ChargeKey[]).map((c) => (
          <NumField key={c} label={CHARGE_LABEL[c]} unit="R" hint={CHARGE_HELP[c]} value={draft.estimator.charges[c] ?? null} onChange={(v) => edit((d) => { d.estimator.charges = { ...d.estimator.charges, [c]: v }; })} />
        ))}
        <NumField label="M75 system price" unit="R per system" hint="Entered by hand by design. NQ3132 is N/A — supplier quote required; it is not priced separately." value={draft.estimator.unitPrices.flex_auger ?? null} onChange={(v) => edit((d) => { d.estimator.unitPrices = { ...d.estimator.unitPrices, flex_auger: v }; })} />
      </div>
      <label className="mt-4 flex max-w-3xl flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">Assumptions (frozen with the quote)</span>
        <textarea value={draft.estimator.assumptions} onChange={(e) => edit((d) => { d.estimator.assumptions = e.target.value; })} rows={3} className="rounded-md border border-slate-300 p-2 text-sm" />
      </label>
    </>
  );
}

/** Customer-driven exclusions with their required reasons. */
export function ExclusionsSection({ draft, ev, edit }: { draft: QuoteDraft; ev: QuoteEvaluation; edit: Edit }) {
  const cfg = draft.config;
  return (
    <>
      <p className="mt-2 text-xs text-slate-600">Everything in the template is required by default. Exclude a section only at the customer&apos;s request, with a reason that stays visible and is frozen in the baseline.</p>
      <ul className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {ev.calc.lines.filter((l) => !GROWER_RULES.find((r) => r.itemKey === l.itemKey)!.optionalKey).map((l) => {
          const k = l.itemKey as GrowerItemKey;
          const on = cfg.exclusions?.[k] !== undefined;
          return (
            <li key={l.itemKey} className={`rounded-md border px-3 py-2 text-sm ${on ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"}`}>
              <div className="flex items-center justify-between gap-3">
                <label className="flex min-h-11 items-center gap-2 text-slate-800"><input type="checkbox" className="size-6" checked={on} onChange={(e) => edit((d) => { d.config.exclusions = { ...d.config.exclusions }; if (e.target.checked) d.config.exclusions[k] = ""; else delete d.config.exclusions[k]; })} /> Exclude {l.label.split(" (")[0]}</label>
                <span className={`text-xs font-semibold ${on ? "text-amber-900" : "text-slate-600"}`} aria-hidden>{on ? "! Excluded" : "Included"}</span>
              </div>
              {on && <div className="mt-2"><TextField label="" placeholder="Reason (required)" value={cfg.exclusions?.[k] ?? ""} onChange={(v) => edit((d) => { d.config.exclusions = { ...d.config.exclusions, [k]: v }; })} hint={(cfg.exclusions?.[k] ?? "").trim() ? undefined : "A reason is required before this can be saved."} /></div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
