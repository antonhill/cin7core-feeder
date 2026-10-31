import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { DeliveryLayer } from "@/rwtsa-demo/state/layers";
import type { ProvenanceLabel, ReadinessLabel } from "@/rwtsa-demo/state/demo-state";

const PROVENANCE_TONE: Record<ProvenanceLabel, BadgeTone> = { SYNTHETIC: "warning", "LOCAL WORKBOOK": "info", "NO DATA": "neutral" };
const LAYER_TONE: Record<DeliveryLayer, BadgeTone> = { "CIN7 CORE": "primary", TOOLBOX: "success", XERO: "info", "FAST REACT / EXTERNAL": "warning" };

export function ProvenanceBadge({ provenance }: { provenance: ProvenanceLabel }) {
  return (
    <span data-testid="provenance">
      <Badge tone={PROVENANCE_TONE[provenance]} dot>
        {provenance}
      </Badge>
    </span>
  );
}

export function ReadinessBadge({ readiness }: { readiness: ReadinessLabel }) {
  return (
    <span data-testid="readiness">
      <Badge tone={readiness === "READY" ? "success" : "danger"} dot>
        {readiness}
      </Badge>
    </span>
  );
}

export function LayerBadge({ layer }: { layer: DeliveryLayer }) {
  return <Badge tone={LAYER_TONE[layer]}>{layer}</Badge>;
}
