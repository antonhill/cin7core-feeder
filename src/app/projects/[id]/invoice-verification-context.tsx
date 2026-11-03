"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { InvoiceVerification } from "@/lib/projects/invoice-verification";
import { invoiceAuthorisation, type InvoiceAuthorisation, type VerifiedRef } from "@/lib/projects/invoice-authorisation";
import type { ClaimCin7Status } from "@/lib/projects/claim-cin7-status";

// UX-006g1. The result of the manual, read-only "Verify invoice statuses" (UAT-028), shared IN MEMORY so that every screen that shows an invoice status can say what was
// verified and when, instead of presenting the recorded cin7_status snapshot as if it were current.
//   - Owned by ProjectWorkspace (one provider per mounted workspace; an embedded variation workspace has its own).
//   - Written ONLY by InvoiceStatusSection after the manager presses Verify. Mounting, opening a project or reading the context never reads Cin7.
//   - A verification belongs to the postings as they were when Cin7 was read: when `signature` (the current postings, see postingsSignature) differs from the one stored, the
//     verification is no longer returned (it is `stale`). Nothing is persisted: a reload forgets it (accepted; persisting it needs an owner-approved column).
// API for consumers (Journey, Variation / Reconciliation screens): useInvoiceVerification() -> { verification (current or null), stale, error, verifiedFor(claimId) }
// and useInvoiceAuthorisation(recorded) -> the display model for one claim.

interface Stored { result: InvoiceVerification; signature: string }
interface StoredError { message: string; signature: string }

export interface InvoiceVerificationApi {
  /** The verification for the CURRENT postings; null when none was run, or when the postings changed since. */
  verification: InvoiceVerification | null;
  /** A verification exists but the postings changed since, so it is hidden. */
  stale: boolean;
  /** The last Verify failed (for the current postings). An older successful verification, if still current, remains in `verification`. */
  error: string | null;
  /** The current verification's entry for a claim (null if none / not listed). */
  verifiedFor(claimId: string): VerifiedRef | null;
  set(result: InvoiceVerification, signature: string): void;
  fail(message: string, signature: string): void;
  clear(): void;
}

const NOOP: InvoiceVerificationApi = { verification: null, stale: false, error: null, verifiedFor: () => null, set: () => {}, fail: () => {}, clear: () => {} };
const Ctx = createContext<InvoiceVerificationApi | null>(null);

/** `signature` = postingsSignature of the postings the workspace is showing now. */
export function InvoiceVerificationProvider({ signature, children }: { signature: string; children: ReactNode }) {
  const [stored, setStored] = useState<Stored | null>(null);
  const [err, setErr] = useState<StoredError | null>(null);
  const set = useCallback((result: InvoiceVerification, sig: string) => { setStored({ result, signature: sig }); setErr(null); }, []);
  const fail = useCallback((message: string, sig: string) => setErr({ message, signature: sig }), []);
  const clear = useCallback(() => { setStored(null); setErr(null); }, []);
  const api = useMemo<InvoiceVerificationApi>(() => {
    const current = stored && stored.signature === signature ? stored.result : null;
    const byClaim = new Map((current?.invoices ?? []).map((i) => [i.claimId, i]));
    return {
      verification: current, stale: !!stored && !current, error: err && err.signature === signature ? err.message : null,
      verifiedFor: (claimId) => (current ? { verifiedAt: current.verifiedAt, invoice: byClaim.get(claimId) } : null),
      set, fail, clear,
    };
  }, [stored, err, signature, set, fail, clear]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Outside a provider (a stand-alone panel) nothing is verified. */
export function useInvoiceVerification(): InvoiceVerificationApi { return useContext(Ctx) ?? NOOP; }
/** True when a provider exists (InvoiceStatusSection falls back to local state without one). */
export function useHasInvoiceVerificationProvider(): boolean { return useContext(Ctx) !== null; }
export function useInvoiceVerified(claimId: string): VerifiedRef | null { return useInvoiceVerification().verifiedFor(claimId); }

/** The display model for one claim's invoice, from the recorded posting plus whatever is currently verified. */
export function useInvoiceAuthorisation(claimId: string, recorded: ClaimCin7Status): InvoiceAuthorisation {
  const v = useInvoiceVerification();
  return invoiceAuthorisation(recorded, v.verifiedFor(claimId), v.error !== null);
}
