"use client";

import { Status } from "@/components/ui/Status";
import type { PackageMapping } from "@/newquip/grower/commercial";

/**
 * A package that is NOT safe to confirm in bulk (the LED light: Sean confirmed the SKUs, not the quantities; the cup drinker: the Master names a different sellable SKU) is confirmed by the
 * Estimator individually, and only after its composition and the reason it needs a decision are on screen. Nothing here prices or saves by itself: the checkbox edits the draft like every
 * other Estimator decision, and the draft save records who confirmed and when.
 */
export function PackageOwnConfirmation({ pkg, confirmed, canEdit, onChange }: { pkg: PackageMapping; confirmed: boolean; canEdit: boolean; onChange: (yes: boolean) => void }) {
  const reason = pkg.estimatorConfirmation
    ?? (pkg.alternativeIdentity ? `The NewQuip Master lists ${pkg.alternativeIdentity.sku} (${pkg.alternativeIdentity.description}) as a different representation of this item. ${pkg.alternativeIdentity.note}` : "This package's definition is not complete enough to confirm in bulk.");
  return (
    <div className="basis-full rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm" data-testid={`package-own-confirmation-${pkg.itemKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-slate-900">Proposed composition, per unit</span>
        <Status tone={confirmed ? "success" : "warning"}>{confirmed ? "Package confirmed" : "Package unconfirmed"}</Status>
      </div>
      <ul className="mt-2 space-y-0.5" data-testid="package-own-composition">
        {pkg.components.map((c) => <li key={c.id} className="flex flex-wrap gap-x-2"><span className="tabular-nums font-semibold">{c.qtyPerUnit ?? "?"} ×</span><span className="font-mono">{c.sku ?? "no SKU"}</span><span className="text-slate-700">{c.description}</span></li>)}
      </ul>
      <p className="mt-2 text-xs text-amber-900" data-testid="package-own-reason">{reason}</p>
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-0.5 size-5" checked={confirmed} disabled={!canEdit} onChange={(e) => onChange(e.target.checked)} />
        <span>I have reviewed this composition and confirm the {pkg.name.toLowerCase()} package. <span className="text-slate-700">Saved with the draft, with your name and the time.</span></span>
      </label>
    </div>
  );
}
