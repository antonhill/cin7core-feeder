import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { DATE_FORMATS, ORDER_STATUSES, fileName } from "@/rwtsa-demo/fastreact/contract";
import type { ExportFile, FileStatus } from "@/rwtsa-demo/fastreact/export";
import type { Outcome } from "@/rwtsa-demo/fastreact/return-reconcile";
import type { FastReactModel } from "@/rwtsa-demo/state/fastreact-model";
import { ProvenanceBadge } from "./Badges";

const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";
const btn = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold";
const mono = "font-mono text-xs";

const FILE_TONE: Record<FileStatus, BadgeTone> = { READY: "success", FAILED: "danger", NOT_EXPORTABLE: "warning" };
const OUTCOME_TONE: Record<Outcome, BadgeTone> = { NEW: "success", UPDATED: "success", DUPLICATE: "neutral", SUPERSEDED: "neutral", STALE: "warning", CONFLICT: "danger", REJECTED: "danger" };
const CONF_TONE: Record<string, BadgeTone> = { verified: "success", proposed: "info", unresolved: "warning" };

function previewLines(text: string, n = 6): string {
  const lines = text.split("\r\n");
  return lines.slice(0, n).join("\n") + (lines.length > n + 1 ? `\n… (${lines.length - 1 - (n - 1)} more rows)` : "");
}

function Post({ action, children, multipart = false, testid }: { action: string; children: React.ReactNode; multipart?: boolean; testid?: string }) {
  return (
    <form method="post" action="/api/fast-react" encType={multipart ? "multipart/form-data" : undefined} data-testid={testid} className="flex flex-wrap items-end gap-2 text-sm">
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

function FileCard({ f, base }: { f: ExportFile; base: boolean }) {
  return (
    <div data-testid={`file-${f.id}`} data-status={f.status} className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{f.name}</span>
        <Badge tone={FILE_TONE[f.status]} dot>
          {f.status.replace("_", " ")}
        </Badge>
        <Badge tone={base ? "info" : "neutral"}>{base ? "base file" : "additional file"}</Badge>
        <span className="text-xs text-slate-500">{f.rowCount} record(s)</span>
        {f.status === "READY" && (
          <a data-testid={`download-${f.id}`} href={`/api/fast-react/download?file=${f.id}`} className="text-sm font-semibold text-primary hover:underline">
            Download {f.name}
          </a>
        )}
      </div>
      {f.status === "NOT_EXPORTABLE" && <p className="mt-2 text-sm text-amber-800">NOT EXPORTABLE: {f.notExportableReason}</p>}
      {f.columns.length > 0 && <p className="mt-2 text-xs text-slate-600">Columns written: <span className={mono}>{f.columns.join("  ")}</span></p>}
      {f.issues.length > 0 && (
        <ul data-testid={`issues-${f.id}`} className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
          {f.issues.map((i, k) => (
            <li key={`${i.field}-${i.ref}-${k}`}>
              <span className={mono}>{i.field}</span> {i.ref ? <>({i.ref}) </> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {f.notes.map((n) => (
        <p key={n} className="mt-1 text-xs text-slate-600">
          {n}
        </p>
      ))}
      {f.text !== null && (
        <>
          <pre data-testid={`preview-${f.id}`} className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{previewLines(f.text)}</pre>
          <p className="mt-1 break-all text-xs text-slate-500">SHA-256 {f.sha256}</p>
        </>
      )}
    </div>
  );
}

export function FastReactPageView({ model, done }: { model: FastReactModel; done: { code: string; text: string } | null }) {
  const r = model.report;
  const opts = model.exchange.options;
  const supp = model.exchange.supplement;
  const selected = new Set(opts.selectedOrders ?? model.orders.map((o) => o.orderNo));
  const pending = model.pending;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">MFG-08</p>
        <h1 className="text-xl font-semibold text-slate-900">Fast React exchange: file-based demonstration</h1>
        <p className="mt-1 text-sm text-slate-600">
          Orders and master data out to Fast React as the vendor&apos;s documented import files; planning and production progress back as a clearly labelled Spark-proposed return file. Calculated and validated on this machine.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={model.provenance} />
          <span data-testid="integration-status">
            <Badge tone="warning">NOT A LIVE FAST REACT CONNECTION</Badge>
          </span>
          <Badge tone="info">OUTBOUND: VENDOR-DOCUMENTED FIELDS</Badge>
          <Badge tone="warning">RETURN: SPARK-PROPOSED</Badge>
          {model.sourceLabel && <span className="text-xs text-slate-500">Source: {model.sourceLabel}</span>}
        </div>
      </div>

      <Alert tone="warning">
        <span data-testid="integration-banner">{model.integrationStatus}</span>
      </Alert>
      <Alert tone={model.banner.tone === "neutral" ? "info" : model.banner.tone}>{model.banner.text}</Alert>
      {model.stateError && <Alert tone="danger">{model.stateError}</Alert>}
      {done && (
        <div id="exchange-result">
          <Alert tone={done.code.startsWith("invalid") || done.code === "return-rejected" || done.code === "no-pending" ? "warning" : "success"}>
            <span data-testid="form-result">{done.text}</span>
          </Alert>
        </div>
      )}

      {!model.hasData ? (
        <EmptyState title="No data source is loaded" description="There is nothing to export or reconcile. No other data has been substituted." />
      ) : (
        <>
          {/* ---------------- A ---------------- */}
          <Panel>
            <PanelTitle>A. Outbound contract: the five Fast React import files</PanelTitle>
            <p className="mt-1 text-sm text-slate-600">
              Field codes are the vendor&apos;s (Evolve and Align v4.52.79 import reference pages, 2020). Applicability to the client&apos;s installed version is not confirmed. Every run sends the full current position of the selected orders; there are no add, amend or delete flags.
            </p>
            <div className="mt-3">
              <Table>
                <THead>
                  <TR>
                    <TH>File</TH>
                    <TH>Status</TH>
                    <TH>Records</TH>
                    <TH>Fields written</TH>
                    <TH>Fields not written</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.files.map((f) => (
                    <TR key={f.id}>
                      <TD>
                        <span className="font-mono">{fileName(f.id, opts.delimiter)}</span>
                      </TD>
                      <TD>
                        <Badge tone={FILE_TONE[f.status]}>{f.status.replace("_", " ")}</Badge>
                      </TD>
                      <TD>{f.rowCount}</TD>
                      <TD>
                        <span className={mono}>{f.coverage.filter((c) => c.state !== "not-mapped").map((c) => c.code).join(", ")}</span>
                      </TD>
                      <TD>
                        <span className={mono}>{f.coverage.filter((c) => c.state === "not-mapped").map((c) => c.code).join(", ") || "-"}</span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <details className="mt-3" data-testid="matrix">
              <summary className="cursor-pointer text-sm font-semibold">Field-contract matrix ({model.matrix.length} fields)</summary>
              <div className="mt-2">
                <Table>
                  <THead>
                    <TR>
                      <TH>File</TH>
                      <TH>Fast React field</TH>
                      <TH>Required</TH>
                      <TH>Source layer</TH>
                      <TH>Source field</TH>
                      <TH>Transformation</TH>
                      <TH>Validation</TH>
                      <TH>Evidence</TH>
                      <TH>Confidence</TH>
                      <TH>Note</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {model.matrix.map((m) => (
                      <TR key={`${m.file}-${m.code}`}>
                        <TD>{m.file}</TD>
                        <TD>
                          <span className={mono}>{m.code}</span> <span className="text-xs text-slate-500">({m.state})</span>
                        </TD>
                        <TD>{m.required}</TD>
                        <TD>{m.sourceLayer}</TD>
                        <TD>{m.sourceField}</TD>
                        <TD>{m.transformation}</TD>
                        <TD>{m.validation}</TD>
                        <TD>{m.evidence}</TD>
                        <TD>
                          <Badge tone={CONF_TONE[m.confidence]}>{m.confidence.toUpperCase()}</Badge>
                        </TD>
                        <TD>{m.note}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="mt-2 text-xs text-slate-600">
                Deliberately never written, because Fast React is the scheduling authority:{" "}
                {model.schedulingNotWritten.map((s) => `${s.code} (${s.why})`).join(" ")}
              </p>
            </details>
          </Panel>

          {/* ---------------- B ---------------- */}
          <Panel>
            <PanelTitle>B. Export preview and validation</PanelTitle>
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="export-readiness">
              <Badge tone={r.baseSetReady ? "success" : "danger"} dot>
                {r.baseSetReady ? "BASE FILE SET READY AND INTERNALLY CONSISTENT" : "BASE FILE SET NOT READY"}
              </Badge>
              <span className="text-xs text-slate-500">
                Encoding: {r.encoding}. Line ending: {r.lineEnding}. Dates: {opts.dateFormat}. These are our defaults; the client&apos;s import configuration is not confirmed.
              </span>
            </div>

            <h3 className="mt-4 text-sm font-semibold">Values the workbook does not hold (entered by the planner, stored locally, never inferred)</h3>
            <p className="mt-1 text-xs text-slate-600">The production orders in the workbook carry no customer and no delivery date, and the items carry no product type. A mandatory value left blank fails its file; nothing is substituted.</p>
            <div className="mt-2">
              <Post action="supplement-save" testid="supplement-form">
                <div className="w-full">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Order</TH>
                        <TH>Style</TH>
                        <TH align="right">Qty</TH>
                        <TH>Customer</TH>
                        <TH>Delivery date</TH>
                        <TH>Status (optional)</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {model.orders.map((o) => {
                        const s = supp.orders[o.orderNo];
                        return (
                          <TR key={o.orderNo}>
                            <TD>{o.orderNo}</TD>
                            <TD>{o.styleCode}</TD>
                            <TD align="right">{o.qty}</TD>
                            <TD>
                              <select name={`customer:${o.orderNo}`} defaultValue={s?.customer ?? ""} className={field} aria-label={`Customer for ${o.orderNo}`}>
                                <option value="">(not supplied)</option>
                                {model.customers.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </TD>
                            <TD>
                              <input type="date" name={`date:${o.orderNo}`} defaultValue={s?.deliveryDate ?? ""} className={field} aria-label={`Delivery date for ${o.orderNo}`} />
                            </TD>
                            <TD>
                              <select name={`status:${o.orderNo}`} defaultValue={s?.status ?? ""} className={field} aria-label={`Status for ${o.orderNo}`}>
                                <option value="">(none)</option>
                                {ORDER_STATUSES.map((st) => (
                                  <option key={st.code} value={st.code}>
                                    {st.code} = {st.meaning}
                                  </option>
                                ))}
                              </select>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    {model.styles.map((st) => (
                      <label key={st} className="flex flex-col gap-1 text-sm">
                        Product type for style {st}
                        <input name={`type:${st}`} defaultValue={supp.productTypes[st]?.code ?? ""} maxLength={15} className={`${field} w-36`} />
                      </label>
                    ))}
                    <button type="submit" className={btn}>
                      Save planner inputs
                    </button>
                  </div>
                </div>
              </Post>
            </div>

            <h3 className="mt-5 text-sm font-semibold">Export options and selection</h3>
            <div className="mt-2">
              <Post action="options-save" testid="options-form">
                <label className="flex flex-col gap-1">
                  Format
                  <select name="delimiter" defaultValue={opts.delimiter} className={field}>
                    <option value="tab">Tab-separated (.txt)</option>
                    <option value="csv">Quoted CSV (.csv)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Date format
                  <select name="dateFormat" defaultValue={opts.dateFormat} className={field}>
                    {DATE_FORMATS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Field names
                  <select name="headerStyle" defaultValue={opts.headerStyle} className={field}>
                    <option value="standard">Standard codes (O^DD:1)</option>
                    <option value="compliant">Compliant names (O2DD41)</option>
                  </select>
                </label>
                <fieldset className="flex flex-wrap items-center gap-3">
                  <legend className="text-sm">Orders to export</legend>
                  {model.orders.map((o) => (
                    <label key={o.orderNo} className="flex items-center gap-1">
                      <input type="checkbox" name="selected" value={o.orderNo} defaultChecked={selected.has(o.orderNo)} /> {o.orderNo}
                    </label>
                  ))}
                </fieldset>
                <button type="submit" className={btn}>
                  Save options
                </button>
              </Post>
            </div>

            <div className="mt-5 grid gap-3">
              {r.files.map((f, i) => (
                <FileCard key={f.id} f={f} base={i < 4} />
              ))}
            </div>

            <h3 className="mt-5 text-sm font-semibold">How these files would reach Fast React</h3>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-700" data-testid="supply-steps">
              <li>Place the files in the import directory set under Fast React&apos;s Setup, Configure, General. The importing workstation needs create, read, write and delete rights there.</li>
              <li>Fast React renames each file with a leading underscore before processing, then compares the full position with its own records and applies the changes.</li>
              <li>A missing or invalid essential field aborts that file&apos;s import with a fatal error; an order whose product or customer is unknown is rejected. This page applies the same checks first.</li>
              <li>By default Fast React leaves orders that are not in the file alone. Its optional synchronise setting would delete them: this demonstration never relies on it.</li>
            </ol>
            <p className="mt-2 text-sm text-amber-800">The import step is the client&apos;s Fast React. Toolbox has not performed it and cannot observe it.</p>
          </Panel>

          {/* ---------------- C ---------------- */}
          <Panel>
            <PanelTitle>C. Proposed return feed</PanelTitle>
            <Alert tone="warning">
              <span data-testid="return-label">{model.returnLabel}</span>. Fast React has not supplied a return layout; this is Spark&apos;s proposal, built from the factory-schedule layout as the Rev2 clarification (MFG-08) accepts. It is not a Fast React specification.
            </Alert>
            <div className="mt-3">
              <Table>
                <THead>
                  <TR>
                    <TH>Field</TH>
                    <TH>Required</TH>
                    <TH>Type</TH>
                    <TH>Meaning</TH>
                    <TH>Basis</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.returnFields.map((f) => (
                    <TR key={f.code}>
                      <TD>
                        <span className={mono}>{f.code}</span>
                      </TD>
                      <TD>{f.required ? "Yes" : "Optional"}</TD>
                      <TD>{f.type}</TD>
                      <TD>{f.meaning}</TD>
                      <TD>{f.basis}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Not included because their meaning and mapping are not established: material-readiness dates for the two manufacturers and the planning, prints and stock-order dates. Statuses: {model.returnStatuses.join(", ")}. A newer timestamp is required for a row to change what is stored.
            </p>
            {model.sampleText !== "" && (
              <>
                <h3 className="mt-4 text-sm font-semibold">Synthetic example (invented values for these order codes; not from Fast React)</h3>
                <pre data-testid="sample-return" className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{model.sampleText.split("\r\n").join("\n")}</pre>
                <a data-testid="download-sample" href="/api/fast-react/download?file=SAMPLE" className="text-sm font-semibold text-primary hover:underline">
                  Download the synthetic sample
                </a>
              </>
            )}
          </Panel>

          {/* ---------------- D ---------------- */}
          <Panel>
            <PanelTitle>D. Import and reconciliation (local demonstration state only)</PanelTitle>
            <p className="mt-1 text-sm text-slate-600">
              A return file is validated and previewed first. Applying it changes only this machine&apos;s demonstration state, outside Git. Nothing is written to Cin7 Core, Fast React, Xero or the workbook, and no finished-goods receipt is created. Limits: {model.limits.maxReturnBytes / 1024} KB and {model.limits.maxReturnRows} rows.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <Post action="return-upload" multipart testid="upload-form">
                <label className="flex flex-col gap-1">
                  Return file (.txt or .csv)
                  <input type="file" name="file" accept=".txt,.csv,text/plain,text/csv" required className={field} />
                </label>
                <button type="submit" className={btn}>
                  Validate and preview
                </button>
              </Post>
              <Post action="return-sample" testid="sample-form">
                <button type="submit" className={btn}>
                  Load the synthetic sample
                </button>
              </Post>
            </div>

            {pending && (
              <div data-testid="pending-preview" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning" dot>
                    PREVIEW: NOT YET APPLIED
                  </Badge>
                  <Badge tone="neutral">{pending.sourceKind === "synthetic-sample" ? "SOURCE: SYNTHETIC SAMPLE (SPARK-PROPOSED FORMAT)" : "SOURCE: LOCAL FILE (SPARK-PROPOSED FORMAT)"}</Badge>
                  <span className="break-all text-xs text-slate-600">SHA-256 {pending.fileHash}</span>
                </div>
                {pending.plan.fileErrors.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-sm text-red-800">
                    {pending.plan.fileErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
                {pending.plan.alreadyApplied && <p data-testid="already-applied" className="mt-2 text-sm text-slate-700">This exact file was already applied. Applying it again would change nothing.</p>}
                <p data-testid="plan-summary" className="mt-2 text-sm">
                  {pending.plan.summary.rows} row(s): <strong>{pending.plan.summary.accepted} would be accepted</strong>, {pending.plan.summary.rejected} rejected, {pending.plan.summary.duplicates} duplicate, {pending.plan.summary.stale} stale, {pending.plan.summary.conflicts} conflicting, {pending.plan.summary.superseded} superseded within the file.
                </p>
                <div className="mt-2">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Line</TH>
                        <TH>Order</TH>
                        <TH>Outcome</TH>
                        <TH>Changes if applied</TH>
                        <TH>Reasons and warnings</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {pending.plan.rows.map((row) => (
                        <TR key={row.line}>
                          <TD>{row.line}</TD>
                          <TD>{row.order}</TD>
                          <TD>
                            <span data-testid="plan-outcome" data-outcome={row.outcome}>
                              <Badge tone={OUTCOME_TONE[row.outcome]}>{row.outcome}</Badge>
                            </span>
                          </TD>
                          <TD>
                            {row.outcome === "NEW" && row.record
                              ? `New: ${row.record.status}, ${row.record.qtyDone} done, ${row.record.line}`
                              : row.changes.length === 0
                                ? "-"
                                : row.changes.map((c) => `${c.field}: ${c.from} to ${c.to}`).join("; ")}
                          </TD>
                          <TD>{[...row.reasons, ...row.warnings].join(" ") || "-"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {pending.plan.fileErrors.length === 0 && (
                    <Post action="return-apply" testid="apply-form">
                      <input type="hidden" name="hash" value={pending.fileHash} />
                      <button type="submit" className={`${btn} border-emerald-700 text-emerald-900`}>
                        Confirm: apply to local demonstration state
                      </button>
                    </Post>
                  )}
                  <Post action="return-discard">
                    <button type="submit" className={btn}>
                      Discard
                    </button>
                  </Post>
                </div>
              </div>
            )}

            <h3 className="mt-5 text-sm font-semibold">Production orders with returned planning information</h3>
            <div className="mt-2">
              <Table>
                <THead>
                  <TR>
                    <TH>Order</TH>
                    <TH>Style</TH>
                    <TH align="right">Ordered</TH>
                    <TH>Workbook line</TH>
                    <TH>Returned line</TH>
                    <TH>Planned start</TH>
                    <TH>Expected completion</TH>
                    <TH>Achievable delivery</TH>
                    <TH>Status</TH>
                    <TH align="right">Completed</TH>
                    <TH>Last update (UTC)</TH>
                    <TH>Source</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.orders.map((o) => (
                    <TR key={o.orderNo}>
                      <TD>{o.orderNo}</TD>
                      <TD>{o.styleCode}</TD>
                      <TD align="right">{o.qty}</TD>
                      <TD>{o.workbookLine || "-"}</TD>
                      {o.returned ? (
                        <>
                          <TD>{o.returned.line}{o.returned.section ? ` / ${o.returned.section}` : ""}</TD>
                          <TD>{o.returned.start}</TD>
                          <TD>{o.returned.end}</TD>
                          <TD>{o.returned.delivery || "-"}</TD>
                          <TD>
                            <span data-testid={`returned-status-${o.orderNo}`}>
                              <Badge tone={o.returned.status === "COMPLETE" ? "success" : o.returned.status === "HELD" ? "warning" : "info"}>{o.returned.status}</Badge>
                            </span>
                          </TD>
                          <TD align="right">
                            <span data-testid={`returned-qty-${o.orderNo}`}>
                              {o.returned.qtyDone} ({o.percentComplete}%)
                            </span>
                          </TD>
                          <TD>{o.returned.updatedAt}</TD>
                          <TD>
                            <span className="text-xs">
                              {o.returned.sourceKind === "synthetic-sample" ? "Synthetic sample" : "Local file"}, Spark-proposed format, applied locally {o.returned.appliedAt}. Integration status: demonstration, not live.
                            </span>
                          </TD>
                        </>
                      ) : (
                        <TD>
                          <span className="text-slate-500">No return applied</span>
                        </TD>
                      )}
                      {!o.returned && (
                        <>
                          <TD />
                          <TD />
                          <TD />
                          <TD />
                          <TD />
                          <TD />
                          <TD />
                        </>
                      )}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <p data-testid="variance-note" className="mt-2 text-sm text-slate-700">
              <strong>Scenario B production variance is unchanged.</strong> The return carries a completed quantity and a status but no actual labour minutes or material usage, and none are inferred from a planning status, so the approved variance calculation has nothing new to recalculate from. Returned progress is shown here separately.{" "}
              <Link href="/scenario-b" prefetch={false} className="text-primary hover:underline">
                Open Scenario B
              </Link>
            </p>

            <h3 className="mt-5 text-sm font-semibold">Reconciliation report: applied batches</h3>
            {model.history.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600" data-testid="no-history">
                No return file has been applied.
              </p>
            ) : (
              <div className="mt-2">
                <Table>
                  <THead>
                    <TR>
                      <TH>Applied (UTC)</TH>
                      <TH>Source</TH>
                      <TH>File SHA-256</TH>
                      <TH align="right">Rows</TH>
                      <TH align="right">Accepted</TH>
                      <TH align="right">Rejected</TH>
                      <TH align="right">Duplicate</TH>
                      <TH align="right">Stale</TH>
                      <TH align="right">Conflict</TH>
                      <TH align="right">Superseded</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {model.history.map((h) => (
                      <TR key={`${h.fileHash}-${h.appliedAt}`}>
                        <TD>{h.appliedAt}</TD>
                        <TD>{h.sourceKind === "synthetic-sample" ? "Synthetic sample" : "Local file"}</TD>
                        <TD>
                          <span className={mono}>{h.fileHash.slice(0, 16)}</span>
                        </TD>
                        <TD align="right">{h.rows}</TD>
                        <TD align="right">{h.accepted}</TD>
                        <TD align="right">{h.rejected}</TD>
                        <TD align="right">{h.duplicates}</TD>
                        <TD align="right">{h.stale}</TD>
                        <TD align="right">{h.conflicts}</TD>
                        <TD align="right">{h.superseded}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
            <div className="mt-3">
              <Post action="returns-clear" testid="clear-form">
                <button type="submit" className={btn}>
                  Clear applied returns (rehearsal reset; planner inputs kept)
                </button>
              </Post>
            </div>
          </Panel>

          {/* ---------------- E ---------------- */}
          <Panel>
            <PanelTitle>E. Operational ownership</PanelTitle>
            <div className="mt-2" data-testid="ownership">
              <Table>
                <THead>
                  <TR>
                    <TH>System</TH>
                    <TH>Owns</TH>
                  </TR>
                </THead>
                <TBody>
                  {model.ownership.map((o) => (
                    <TR key={o.system}>
                      <TD>
                        <strong>{o.system}</strong>
                      </TD>
                      <TD>{o.owns}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <p className="mt-2 text-sm text-slate-700">Toolbox does not schedule. Fast React remains the scheduling authority, and nothing returned here is written back to Cin7 Core.</p>
            <h3 className="mt-4 text-sm font-semibold">Before production use, the vendor must confirm</h3>
            <ul data-testid="vendor-dependencies" className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {model.vendorDependencies.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}
