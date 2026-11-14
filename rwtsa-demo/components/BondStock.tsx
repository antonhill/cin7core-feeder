import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { BondLoad } from "@/rwtsa-demo/bond/load";
import type { BondReportData } from "@/rwtsa-demo/bond/report-schema";

const STATUS_TONE: Record<string, BadgeTone> = { CLEARED: "success", PARTIALLY_CLEARED: "warning", NOT_CLEARED: "danger", NO_BOND_STOCK: "neutral", VERIFIED: "success", UNVERIFIED_NOT_CLEARED: "danger", WITHDRAWN: "neutral", OPEN: "info", PARTLY_COMPLETED: "warning", COMPLETED: "success" };
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const day = (iso: string) => iso.slice(0, 10);

function Tile({ label, value, tone = "neutral" }: { label: string; value: number; tone?: BadgeTone }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd data-testid={`tile-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`} className={`mt-1 text-2xl font-semibold ${tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-slate-900"}`}>{num(value)}</dd>
    </div>
  );
}
const Status = ({ code }: { code: string }) => <Badge tone={STATUS_TONE[code] ?? "neutral"}>{code}</Badge>;

function Report({ report }: { report: BondReportData }) {
  const synthetic = report.dataClass === "SYNTHETIC_DEMONSTRATION";
  const s = report.summary;
  const rowsWithProposals = report.proposals;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Bond stock availability and clearance controls</h1>
        <span data-testid="data-class"><Badge tone={synthetic ? "warning" : "info"} dot>{synthetic ? "SYNTHETIC DEMONSTRATION" : "REAL CIN7 SNAPSHOT"}</Badge></span>
      </div>
      {synthetic ? (
        <Alert tone="warning">
          SYNTHETIC DEMONSTRATION: every value on this page is invented to show how the controls work. A synthetic clearance is not a real customs event and is not RWTSA data.
        </Alert>
      ) : (
        <Alert tone="info">This page shows an owner-selected local report built from a saved, identity-verified Cin7 snapshot and the owner-maintained clearance register. It makes no Cin7 call and creates no Cin7 transaction.</Alert>
      )}
      <ul data-testid="statements" className="list-disc space-y-1 pl-5 text-sm text-slate-700">{report.statements.map((t, i) => <li key={`${i}-${t}`}>{t}</li>)}</ul>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Summary">
        <Tile label="Physical Bond stock" value={s.bondUnits} />
        <Tile label="Verified-cleared quantity" value={s.verifiedClearedUnits} tone="success" />
        <Tile label="Unverified claimed (NOT CLEARED)" value={s.unverifiedClaimedUnits} tone="danger" />
        <Tile label="Eligible for release" value={s.eligibleUnits} tone="success" />
        <Tile label="Proposed transfers (units)" value={s.proposedUnits} />
        <Tile label="Clearance exceptions" value={s.exceptionCount} tone={s.exceptionCount > 0 ? "danger" : "neutral"} />
        <Tile label="SKUs not cleared" value={s.notClearedSkus} tone={s.notClearedSkus > 0 ? "danger" : "neutral"} />
        <Tile label="SKUs with Bond stock" value={s.skusWithBondStock} />
      </dl>

      <Panel>
        <PanelTitle>Stock by SKU</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Eligible = the lesser of physical Bond stock and verified-cleared quantity not yet released. Operational usable is Cin7&apos;s own figure; the projection assumes the proposed transfers complete and is not a fact.</p>
        <div className="mt-3">
          <Table>
            <THead><TR><TH>SKU</TH><TH align="right">Bond</TH><TH align="right">Verified cleared</TH><TH align="right">Unverified</TH><TH align="right">Released</TH><TH align="right">Eligible</TH><TH>Status</TH><TH align="right">Proposed</TH><TH align="right">Usable now</TH><TH align="right">If proposed done</TH><TH>Exceptions</TH></TR></THead>
            <TBody>
              {report.rows.map((x) => (
                <TR key={x.sku}>
                  <TD>{x.sku}</TD><TD align="right">{num(x.bondPhysical)}</TD><TD align="right">{num(x.verifiedCleared)}</TD><TD align="right">{num(x.unverifiedClaimed)}</TD><TD align="right">{num(x.released)}</TD>
                  <TD align="right"><strong>{num(x.eligible)}</strong></TD><TD><Status code={x.clearanceStatus} /></TD><TD align="right">{num(x.activeProposed)}</TD>
                  <TD align="right">{x.operationalUsable === undefined ? "-" : num(x.operationalUsable)}</TD><TD align="right">{x.projectedUsableIfProposedCompleted === undefined ? "-" : num(x.projectedUsableIfProposedCompleted)}</TD>
                  <TD>{x.exceptions.length ? x.exceptions.map((c) => <div key={c}><Badge tone="danger">{c}</Badge></div>) : "-"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Evidence provenance</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Only VERIFIED evidence counts. An owner statement can be recorded but can never be verified. A stock transfer, posted customs duty or a freight invoice is never clearance evidence.</p>
        <div className="mt-3">
          <Table>
            <THead><TR><TH>Entry</TH><TH>Shipment / PO</TH><TH>Clearance ref</TH><TH>Cleared on</TH><TH>Provenance</TH><TH>Attributed to</TH><TH>Status</TH><TH>Verified by / on</TH><TH>Document ref</TH><TH>SKU quantities</TH></TR></THead>
            <TBody>
              {report.evidence.map((e) => (
                <TR key={e.id}>
                  <TD>{e.id}</TD><TD>{e.shipmentRef}</TD><TD>{e.clearanceRef}</TD><TD>{e.clearanceDate}</TD><TD>{e.provenance}</TD><TD>{e.attributedTo}</TD>
                  <TD><Status code={e.status} />{e.withdrawnReason ? <div className="mt-1 text-xs text-slate-500">{e.withdrawnReason}</div> : null}</TD>
                  <TD>{e.verifiedBy ? `${e.verifiedBy} / ${e.verifiedOn}` : "not verified"}</TD><TD>{e.verificationDocumentRef ?? e.documentRef ?? "-"}</TD>
                  <TD>{e.lines.map((l) => `${l.sku}: ${num(l.quantity)}`).join("; ")}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Proposed transfers</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">Drafts only. Nothing here moves stock; a transfer is completed by hand in the warehouse system and only then observed in a later snapshot.</p>
        <div className="mt-3">
          {rowsWithProposals.length === 0 ? <p className="text-sm text-slate-600">No transfers have been proposed.</p> : (
            <Table>
              <THead><TR><TH>Proposal</TH><TH>SKU</TH><TH align="right">Quantity</TH><TH>To</TH><TH>Status</TH><TH align="right">Completed</TH><TH>Proposed by / on</TH><TH>Reason</TH></TR></THead>
              <TBody>{rowsWithProposals.map((p) => <TR key={p.id}><TD>{p.id}</TD><TD>{p.sku}</TD><TD align="right">{num(p.quantity)}</TD><TD>{p.destination}</TD><TD><Status code={p.status} /></TD><TD align="right">{num(p.completedQuantity)}</TD><TD>{p.proposedBy} / {p.proposedOn}</TD><TD>{p.reason}</TD></TR>)}</TBody>
            </Table>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Observed movements and exceptions</PanelTitle>
        <p className="mt-1 text-sm text-slate-600">A Bond decrease beyond what was eligible when it happened is reported as TRANSFER_WITHOUT_CLEARANCE_EVIDENCE. A transfer is a stock movement, never proof of customs clearance; a later verification does not erase it.</p>
        <div className="mt-3">
          {report.observed.length === 0 ? <p className="text-sm text-slate-600">No previous snapshot was supplied, so no movements were compared.</p> : (
            <Table>
              <THead><TR><TH>SKU</TH><TH align="right">Bond decrease</TH><TH align="right">Bond increase</TH><TH align="right">Eligible before</TH><TH align="right">Without clearance</TH><TH>Exceptions</TH></TR></THead>
              <TBody>{report.observed.map((o) => <TR key={o.sku}><TD>{o.sku}</TD><TD align="right">{num(o.bondDecrease)}</TD><TD align="right">{num(o.bondIncrease)}</TD><TD align="right">{num(o.eligibleBefore)}</TD><TD align="right">{num(o.uncleared)}</TD><TD>{o.exceptions.length ? o.exceptions.map((c) => <Badge key={c} tone="danger">{c}</Badge>) : "-"}</TD></TR>)}</TBody>
            </Table>
          )}
          {report.releases.length > 0 ? (
            <p className="mt-3 text-sm text-slate-600" data-testid="releases">Recorded releases: {report.releases.map((r) => `${r.id} ${r.sku} ${num(r.quantity)} on ${r.on}${r.voided ? " (voided)" : ""}${r.releasedBeforeCoverUnits > 0 ? ` (${num(r.releasedBeforeCoverUnits)} released before verified cover)` : ""}`).join("; ")}.</p>
          ) : null}
        </div>
      </Panel>

      <p className="text-xs text-slate-500" data-testid="report-meta">Snapshot taken {day(report.snapshotTakenAt)} · snapshot {report.snapshotHash.slice(0, 12)} · register entries {report.registerEvents} · register tip {report.registerTipHash.slice(0, 12)} · report generated {day(report.generatedAt)}</p>
    </div>
  );
}

export function BondStockView({ load }: { load: BondLoad }) {
  if (load.kind === "OK") return <Report report={load.report} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Bond stock availability and clearance controls</h1>
        <span data-testid="data-class"><Badge tone={load.kind === "INVALID" ? "danger" : "neutral"} dot>{load.kind === "INVALID" ? "REPORT INVALID" : "NO DATA"}</Badge></span>
      </div>
      {load.kind === "INVALID" ? (
        <Alert tone="danger">
          <p className="font-medium">REPORT INVALID: the selected report was not shown because it failed validation. Nothing has been substituted.</p>
          <ul data-testid="problems" className="mt-1 list-disc pl-5 text-sm">{load.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Alert>
      ) : (
        <Alert tone="info">
          <p className="font-medium">NO DATA: no Bond report has been selected.</p>
          <p className="mt-1 text-sm">Build one offline with <code>npx tsx scripts/rwtsa-live/bond.ts report --snapshot &lt;snapshot&gt;</code>, then start this app with <code>RWTSA_BOND_REPORT_PATH</code> set to the report file. To see the invented example instead, start it with <code>RWTSA_BOND_SOURCE=synthetic</code>.</p>
        </Alert>
      )}
    </div>
  );
}
