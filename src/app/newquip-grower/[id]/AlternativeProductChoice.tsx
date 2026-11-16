"use client";

import { alternativesFor } from "@/newquip/grower/commercial";
import type { GrowerItemKey } from "@/newquip/grower/types";

// An item's standard product, or one of the alternatives NewQuip said are included for that SAME item (e.g. PNQ002 for the feeder, SYSH-2750-4 for the bulk tank). Choosing one REPLACES the
// item's product (it never adds a line). The standard stays the default; the caution for an alternative is shown beside it. Nothing is saved here: the choice goes through the draft save.
export function AlternativeProductChoice({ itemKey, standardSku, value, onChange }: { itemKey: GrowerItemKey; standardSku: string | undefined; value: string | undefined; onChange: (sku: string | null) => void }) {
  const alts = alternativesFor(itemKey);
  if (alts.length === 0) return null;
  const chosen = value && alts.some((a) => a.sku === value) ? value : null;
  return (
    <fieldset className="mt-1 space-y-1.5 text-xs" data-testid={`alternatives-${itemKey}`}>
      <legend className="sr-only">Product for {itemKey.replace(/_/g, " ")}</legend>
      <label className="flex min-h-11 cursor-pointer items-center gap-2">
        <input type="radio" className="size-4" name={`alt-${itemKey}`} checked={!chosen} onChange={() => onChange(null)} />
        <span>Standard product{standardSku ? ` (${standardSku})` : ""}</span>
      </label>
      {alts.map((a) => (
        <div key={a.sku}>
          <label className="flex min-h-11 cursor-pointer items-center gap-2">
            <input type="radio" className="size-4" name={`alt-${itemKey}`} checked={chosen === a.sku} onChange={() => onChange(a.sku)} />
            <span>{a.label}</span>
          </label>
          {chosen === a.sku && <p className="ml-6 rounded bg-amber-50 px-2 py-1 text-amber-950" data-testid={`alternative-caution-${a.sku}`}>{a.caution}</p>}
        </div>
      ))}
    </fieldset>
  );
}
