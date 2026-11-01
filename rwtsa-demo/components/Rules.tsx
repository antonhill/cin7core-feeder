import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import type { UnresolvedRule } from "@/rwtsa-demo/state/rules";

/** The commercial-rules indicator, separate from structure, READY and ENGINE. */
export function RulesBadge({ rules }: { rules: readonly UnresolvedRule[] }) {
  return (
    <span data-testid="rules-badge">
      <Badge tone={rules.length === 0 ? "success" : "warning"}>{rules.length === 0 ? "RULES: NONE OPEN" : `RULES: ${rules.length} OPEN`}</Badge>
    </span>
  );
}

/** Lists each unresolved rule by name, what it withholds, and how it is resolved. Renders nothing when none are open. */
export function RulesPanel({ rules }: { rules: readonly UnresolvedRule[] }) {
  if (rules.length === 0) return null;
  return (
    <Panel>
      <PanelTitle>Unresolved commercial rules (reconciliation is not complete)</PanelTitle>
      <p className="mt-1 text-sm text-slate-600">The workbook does not establish these rules, so nothing has been assumed. Each affected output is withheld until the rule is resolved.</p>
      <ul data-testid="rules" className="mt-3 space-y-3">
        {rules.map((r) => (
          <li key={r.id}>
            <span data-testid="rule-row" data-id={r.id} data-how={r.how} />
            <Alert tone="warning">
              <p className="font-semibold">{r.title}</p>
              <p className="mt-1">{r.detail}</p>
              <p className="mt-1">
                <span className="font-semibold">Withheld:</span> {r.withholds}. <span className="font-semibold">Resolved by:</span> {r.how === "choose" ? "a choice in the controls on this page" : "an owner decision (cannot be made on this page)"}.
              </p>
            </Alert>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
