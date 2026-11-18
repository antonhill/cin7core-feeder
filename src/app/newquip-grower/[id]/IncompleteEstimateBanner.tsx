// The INCOMPLETE ESTIMATE warning (customer UAT feedback): shown wherever a total is shown while selected equipment has no confirmed selling price. It separates the KNOWN CHARGE SUBTOTAL from the
// total project estimate (which does not exist yet) and lists what is unpriced. Customer-safe content only (labels, quantities, neutral reasons): no cost, SKU, rate or margin.
import { Alert } from "@/components/ui/Alert";
import { fmtZar } from "../fields";
import type { IncompleteEstimate } from "@/newquip/grower/incomplete-estimate";

export function IncompleteEstimateBanner({ estimate, mode = "full" }: { estimate: IncompleteEstimate | null; /** "text": the warning sentence only (page top). "detail": the breakdown only (beside the totals). "full": both. */ mode?: "full" | "text" | "detail" }) {
  if (!estimate) return null;
  return (
    <div data-testid="incomplete-estimate">
      <Alert tone="danger">
        {mode !== "detail" && <p className="font-semibold">{estimate.text}</p>}
        {mode !== "text" && (
          <>
            <dl className="mt-2 grid max-w-md grid-cols-2 gap-y-0.5 text-sm">
              <dt>Known charges subtotal (delivery, installation, commissioning)</dt><dd className="text-right tabular-nums" data-testid="incomplete-charges-subtotal">{fmtZar(estimate.chargesSubtotalExVat)}</dd>
              <dt>Priced equipment</dt><dd className="text-right tabular-nums">{fmtZar(estimate.pricedEquipmentExVat)}</dd>
              <dt className="font-semibold">Total project estimate</dt><dd className="text-right font-semibold" data-testid="incomplete-total-project">Not available</dd>
            </dl>
            <p className="mt-2 text-sm font-medium">Unpriced equipment:</p>
            <ul className="mt-1 list-disc pl-5 text-sm" data-testid="incomplete-lines">
              {estimate.lines.map((l) => <li key={l.itemKey}>{l.label}{l.quantity != null ? ` × ${l.quantity}` : ""} — {l.reason}</li>)}
            </ul>
          </>
        )}
      </Alert>
    </div>
  );
}
