"use client";

import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { claimNextStep } from "@/lib/projects/claim-next-step";
import { claimCin7Status, type ClaimCin7Status, type ClaimPostingRow } from "@/lib/projects/claim-cin7-status";
import type { InvoiceAuthorisation } from "@/lib/projects/invoice-authorisation";
import { useInvoiceAuthorisation } from "./invoice-verification-context";

// UX-006g1. How one claim's invoice is shown on the Claims card and in the posting panel: A (Toolbox posting / reconciliation), B (Cin7 authorisation: verified, or the
// RECORDED snapshot labelled as such), C (payment, never inferred). Presentation only; it reads the in-memory verification and never reads Cin7.

export function InvoiceAuthorisationLines({ auth, claimId }: { auth: InvoiceAuthorisation; claimId: string }) {
  return (
    <div data-testid={`invoice-auth-${claimId}`} data-auth-state={auth.state}>
      <p className="text-xs text-slate-700" data-part="posting">{auth.posting.text}</p>
      {auth.state !== "NO_INVOICE" && (
        <>
          <p className="mt-1"><Status tone={auth.tone}>{auth.chip}</Status></p>
          <p className="mt-1 text-xs text-slate-700" data-part="authorisation">{auth.text}</p>
          {auth.recorded && (auth.recorded.historical || auth.state === "VERIFIED") && <p className="mt-0.5 text-xs italic text-slate-600" data-part="recorded-historical">{auth.recorded.text}</p>}
          {auth.state === "VERIFIED" && auth.readFailed && <p className="mt-0.5 text-xs text-amber-800" data-part="read-failed">The latest Verify failed; the verification above is from the earlier read.</p>}
          <p className="mt-0.5 text-xs text-slate-600" data-part="payment">{auth.payment}</p>
        </>
      )}
    </div>
  );
}

/** The Cin7 cell of a claim row. */
export function ClaimInvoiceStatus({ claimId, cin7Status }: { claimId: string; cin7Status: ClaimCin7Status }) {
  const auth = useInvoiceAuthorisation(claimId, cin7Status);
  if (auth.state === "NO_INVOICE") {
    return (
      <>
        <Status tone={cin7Status.tone}>{cin7Status.label}</Status>
        {cin7Status.invoiceNumber && <span className="ml-1.5 font-mono text-xs text-slate-700">{cin7Status.invoiceNumber}</span>}
      </>
    );
  }
  return (
    <>
      {cin7Status.invoiceNumber && <p className="font-mono text-xs font-medium text-slate-800">{cin7Status.invoiceNumber}</p>}
      <InvoiceAuthorisationLines auth={auth} claimId={claimId} />
    </>
  );
}

/** The "Next:" line: it never states the current Cin7 status as fact unless it was verified. */
export function ClaimNextStepText(props: { claimId: string; cin7Status: ClaimCin7Status; status: string; stageRole?: string | null; canApproveHere?: boolean; canAct?: boolean }) {
  const auth = useInvoiceAuthorisation(props.claimId, props.cin7Status);
  return <>{claimNextStep({ status: props.status, cin7Kind: props.cin7Status.kind, stageRole: props.stageRole, canApproveHere: props.canApproveHere, canAct: props.canAct, invoiceAuth: { state: auth.state, verifiedStatus: auth.verifiedStatus } })}</>;
}

/** The posting panel's per-claim invoice line, from the posting row it already loaded. */
export function PostingInvoiceLines({ posting }: { posting: ClaimPostingRow }) {
  const recorded = claimCin7Status(posting);
  const auth = useInvoiceAuthorisation(posting.claim_id, recorded);
  return <InvoiceAuthorisationLines auth={auth} claimId={posting.claim_id} />;
}

/** The Overview's per-claim Cin7 cell (Financial reconciliation): verified when verified, otherwise the recorded label. */
export function ReconCin7Cell({ claimId, cin7Status, label, tone }: { claimId: string; cin7Status: ClaimCin7Status; label: string; tone: BadgeTone }) {
  const auth = useInvoiceAuthorisation(claimId, cin7Status);
  if (auth.state === "NO_INVOICE") return <Status tone={tone}>{label}</Status>;
  return (
    <div data-testid={`recon-auth-${claimId}`} data-auth-state={auth.state}>
      <Status tone={auth.tone}>{auth.chip}</Status>
      <p className="mt-1 text-xs text-slate-700">{auth.text}</p>
      {auth.recorded?.historical && <p className="mt-0.5 text-xs italic text-slate-600">{auth.recorded.text}</p>}
    </div>
  );
}
