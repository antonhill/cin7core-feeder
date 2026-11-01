import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { OverviewView, ScenarioView, ValidationView } from "@/rwtsa-demo/state/demo-state";
import { LayerBadge, ProvenanceBadge, ReadinessBadge } from "./Badges";

function BannerAlert({ banner }: { banner: { tone: "warning" | "info" | "danger" | "neutral"; text: string } }) {
  return <Alert tone={banner.tone === "neutral" ? "info" : banner.tone}>{banner.text}</Alert>;
}

const ASSUMPTION_TONE = { Approved: "success", Brief: "info", Open: "warning" } as const;

export function OverviewPageView({ view }: { view: OverviewView }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Overview</h1>
        <ProvenanceBadge provenance={view.provenance} />
      </div>
      <BannerAlert banner={view.banner} />
      <Panel>
        <PanelTitle>Status</PanelTitle>
        <p data-testid="headline" className="mt-2 text-lg font-semibold text-slate-900">
          {view.headline}
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
          {view.notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Panel>
      <Panel>
        <PanelTitle>Scenarios</PanelTitle>
        <div className="mt-3">
          <Table>
            <THead>
              <TR>
                <TH>Scenario</TH>
                <TH>Input readiness (from the validator)</TH>
                <TH>Calculation engine</TH>
              </TR>
            </THead>
            <TBody>
              {view.scenarios.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link href={`/${s.slug}`} className="text-primary hover:underline" prefetch={false}>
                      {s.id} · {s.title}
                    </Link>
                  </TD>
                  <TD>
                    <ReadinessBadge readiness={s.readiness} />
                  </TD>
                  <TD>
                    {s.engineImplemented ? <Badge tone="success">ENGINE AVAILABLE</Badge> : <Badge tone="neutral">NOT IMPLEMENTED</Badge>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <p className="mt-3 text-sm">
          <Link href="/validation" className="text-primary hover:underline" prefetch={false}>
            Data validation and readiness detail
          </Link>
        </p>
      </Panel>
    </div>
  );
}

export function ScenarioPageView({ view }: { view: ScenarioView }) {
  const { meta } = view;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Scenario {meta.id}</p>
        <h1 className="text-xl font-semibold text-slate-900">{meta.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{meta.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={view.provenance} />
          <ReadinessBadge readiness={view.readiness} />
          <Badge tone="neutral">{view.engineImplemented ? "ENGINE AVAILABLE" : "ENGINE NOT IMPLEMENTED"}</Badge>
        </div>
      </div>
      <BannerAlert banner={view.banner} />

      <Panel>
        <PanelTitle>Input readiness</PanelTitle>
        {view.readiness === "READY" ? (
          <p className="mt-2 text-sm text-slate-700">
            The validator reports this scenario&apos;s required records and columns as present and populated. This is input readiness only; it is not a calculated result.
          </p>
        ) : (
          <div className="mt-2">
            <p className="text-sm font-medium text-slate-800">NOT READY because:</p>
            <ul data-testid="reasons" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {view.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4">
          <Table>
            <THead>
              <TR>
                <TH>Required tab</TH>
                <TH>Present</TH>
                <TH align="right">Rows</TH>
              </TR>
            </THead>
            <TBody>
              {view.inputs.map((i) => (
                <TR key={i.tab}>
                  <TD>{i.tab}</TD>
                  <TD>{i.present ? "yes" : "no"}</TD>
                  <TD align="right" numeric>
                    {i.rows ?? "-"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Delivery layer</PanelTitle>
        <div className="mt-3">
          <Table>
            <THead>
              <TR>
                <TH>Capability</TH>
                <TH>Layer</TH>
                <TH>Native claim</TH>
              </TR>
            </THead>
            <TBody>
              {view.capabilities.map((c) => (
                <TR key={c.name}>
                  <TD>{c.name}</TD>
                  <TD>
                    <LayerBadge layer={c.layer} />
                  </TD>
                  <TD>{c.verify ? <Badge tone="warning">TO BE VERIFIED INDEPENDENTLY</Badge> : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Assumptions and open inputs</PanelTitle>
        <ul data-testid="assumptions" className="mt-3 space-y-2 text-sm text-slate-700">
          {view.assumptions.map((a) => (
            <li key={a.text} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <Badge tone={ASSUMPTION_TONE[a.status]}>{a.status.toUpperCase()}</Badge>
              </span>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel>
        <PanelTitle>Results</PanelTitle>
        <div className="mt-3">
          <EmptyState
            title="No results: the calculation engine is not implemented in this build."
            description={`${meta.engine.name} is a later step. This page shows inputs, readiness and assumptions only. Nothing on it is a finding.`}
          />
        </div>
      </Panel>
    </div>
  );
}

export function ValidationPageView({ view }: { view: ValidationView }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Data validation and readiness</h1>
        <ProvenanceBadge provenance={view.provenance} />
      </div>
      <BannerAlert banner={view.banner} />
      {view.message && <Alert tone="danger">{view.message}</Alert>}

      <Panel>
        <PanelTitle>Source and structure</PanelTitle>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-slate-500">Structure</dt>
          <dd data-testid="structure" className="font-semibold text-slate-900">
            {view.structure}
          </dd>
          <dt className="text-slate-500">Source</dt>
          <dd className="font-mono text-slate-700">{view.sourceLabel ?? "-"}</dd>
          <dt className="text-slate-500">Forecast window</dt>
          <dd className="text-slate-700">{view.forecastWindowMonths === null ? "-" : `${view.forecastWindowMonths} months (the validator checks the latest N months on the sheet; the Scenario A engine anchors its own window to the stock date and shows the difference as an assumption)`}</dd>
        </dl>
        <p className="mt-3 text-sm text-slate-600">Structure PASS is not readiness. Readiness is decided per scenario, below.</p>
      </Panel>

      {view.layout.length > 0 && (
        <Panel>
          <PanelTitle>Sheet layout and row accounting</PanelTitle>
          <p className="mt-1 text-sm text-slate-600">How each sheet was read, with every non-empty row accounted for. Counts and field names only: no cell values. The ReadMe sheet is recognised as supplementary and is not parsed.</p>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Tab</TH>
                  <TH>Layout</TH>
                  <TH align="right">Header row</TH>
                  <TH align="right">Sheet rows</TH>
                  <TH align="right">Title</TH>
                  <TH align="right">Data</TH>
                  <TH align="right">Notes</TH>
                  <TH align="right">Excluded (explained)</TH>
                  <TH align="right">Trailing summary</TH>
                  <TH align="right">Trailing notes</TH>
                  <TH align="right">Parsed rows</TH>
                  <TH>Values taken from titles, text lines or derived</TH>
                </TR>
              </THead>
              <TBody>
                {view.layout.map((l) => (
                  <TR key={l.tab}>
                    <TD>
                      <span data-testid="layout-row" data-tab={l.tab} data-layout={l.layout} data-header-row={l.headerRow} />
                      {l.tab}
                    </TD>
                    <TD>{l.layout}</TD>
                    <TD align="right" numeric>{l.headerRow}</TD>
                    <TD align="right" numeric>{l.sheetRows}</TD>
                    <TD align="right" numeric>{l.titleRows}</TD>
                    <TD align="right" numeric>{l.dataRows}</TD>
                    <TD align="right" numeric>{l.noteRows}</TD>
                    <TD align="right" numeric>{l.excludedRows}</TD>
                    <TD align="right" numeric>{l.trailingSummaryRows}</TD>
                    <TD align="right" numeric>{l.trailingNoteRows}</TD>
                    <TD align="right" numeric>{l.parsedRows}{l.expandedRows > 0 ? ` (+${l.expandedRows} from size lists)` : ""}</TD>
                    <TD>{l.derived.length === 0 ? "-" : l.derived.map((d) => `${d.field} (${d.source})`).join("; ")}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Panel>
      )}

      <Panel>
        <PanelTitle>Per-scenario readiness (validator flags)</PanelTitle>
        <div className="mt-3">
          <Table>
            <THead>
              <TR>
                <TH>Scenario</TH>
                <TH>Readiness</TH>
                <TH>Why not</TH>
              </TR>
            </THead>
            <TBody>
              {view.readiness.map((r) => (
                <TR key={r.scenario}>
                  <TD>{r.scenario}</TD>
                  <TD>
                    <ReadinessBadge readiness={r.label} />
                  </TD>
                  <TD>{r.reasons.length ? r.reasons.join(" ") : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Tabs</PanelTitle>
        <div className="mt-3">
          {view.tabs.length === 0 ? (
            <EmptyState title="No workbook has been validated." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Tab</TH>
                  <TH>Present</TH>
                  <TH align="right">Parsed rows</TH>
                  <TH>Missing required fields</TH>
                </TR>
              </THead>
              <TBody>
                {view.tabs.map((t) => (
                  <TR key={t.tab}>
                    <TD>{t.tab}</TD>
                    <TD>{t.present ? "yes" : "no"}</TD>
                    <TD align="right" numeric>
                      {t.rows ?? "-"}
                    </TD>
                    <TD>{t.missingFields.length ? t.missingFields.join(", ") : "-"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Findings (counts only; no workbook values)</PanelTitle>
        <div className="mt-3">
          {view.findings.length === 0 ? (
            <p className="text-sm text-slate-600">No findings.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Severity</TH>
                  <TH>Code</TH>
                  <TH>Where</TH>
                  <TH align="right">Count</TH>
                </TR>
              </THead>
              <TBody>
                {view.findings.map((f, i) => (
                  <TR key={`${f.code}-${f.tab}-${f.field}-${i}`} flagged={f.severity === "error" ? "danger" : f.severity === "warning" ? "warning" : undefined}>
                    <TD>{f.severity}</TD>
                    <TD className="font-mono">{f.code}</TD>
                    <TD>{[f.tab, f.field, f.reason, f.fields?.join("+")].filter(Boolean).join(" / ") || "-"}</TD>
                    <TD align="right" numeric>
                      {f.count}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </Panel>
    </div>
  );
}
