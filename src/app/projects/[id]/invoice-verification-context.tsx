"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { InvoiceVerification } from "@/lib/projects/invoice-verification";
import { invoiceAuthorisation, type InvoiceAuthorisation, type VerifiedRef } from "@/lib/projects/invoice-authorisation";
import type { ClaimCin7Status } from "@/lib/projects/claim-cin7-status";

// UX-006g1. The result of the manual, read-only "Verify invoice statuses" (UAT-028), shared IN MEMORY so that every screen that shows an invoice status can say what was
// verified and when, instead of presenting the recorded cin7_status snapshot as if it were current.
//   - Owned by ProjectWorkspace (one provider per mounted workspace). An embedded variation workspace has its own provider NESTED in the base one: whatever it verifies (its own
//     Sale) is also published UP to the parent, so the base Overview / Journey see it. The parent drops a child's entries when the child's postings change or it unmounts
//     (e.g. leaving the Variations tab). A base verification never claims a variation's invoices (a different Sale lists only its own postings).
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
  /** The last Verify failed for the workspace that owns this claim (this one, or a nested variation workspace). */
  errorFor(claimId: string): string | null;
  set(result: InvoiceVerification, signature: string): void;
  fail(message: string, signature: string): void;
  clear(): void;
  /** Internal: a nested provider publishes its CURRENT (non-stale) state here; `unpublish` on unmount. */
  publish(id: string, entry: ChildEntry | null): void;
}
interface ChildEntry { verification: InvoiceVerification | null; error: string | null; claimIds: ReadonlyArray<string> }

const NOOP: InvoiceVerificationApi = { verification: null, stale: false, error: null, verifiedFor: () => null, errorFor: () => null, set: () => {}, fail: () => {}, clear: () => {}, publish: () => {} };
const Ctx = createContext<InvoiceVerificationApi | null>(null);

/** `signature` = postingsSignature of the postings the workspace is showing now; `claimIds` = this workspace's claims (so a failed read can be attributed to them in a parent). */
export function InvoiceVerificationProvider({ signature, claimIds = [], children }: { signature: string; claimIds?: ReadonlyArray<string>; children: ReactNode }) {
  const parent = useContext(Ctx);
  const id = useId();
  const [stored, setStored] = useState<Stored | null>(null);
  const [err, setErr] = useState<StoredError | null>(null);
  const [kids, setKids] = useState<Record<string, ChildEntry>>({});
  const set = useCallback((result: InvoiceVerification, sig: string) => { setStored({ result, signature: sig }); setErr(null); }, []);
  const fail = useCallback((message: string, sig: string) => setErr({ message, signature: sig }), []);
  const clear = useCallback(() => { setStored(null); setErr(null); }, []);
  const publish = useCallback((cid: string, entry: ChildEntry | null) => setKids((k) => {
    if (entry === null) { if (!(cid in k)) return k; const { [cid]: _gone, ...rest } = k; void _gone; return rest; }
    return { ...k, [cid]: entry };
  }), []);
  const claimKey = claimIds.join("|");
  const api = useMemo<InvoiceVerificationApi>(() => {
    const current = stored && stored.signature === signature ? stored.result : null;
    const error = err && err.signature === signature ? err.message : null;
    const byClaim = new Map((current?.invoices ?? []).map((i) => [i.claimId, i]));
    const own = new Set(claimKey ? claimKey.split("|") : []);
    return {
      verification: current, stale: !!stored && !current, error,
      verifiedFor: (claimId) => {
        const mine = byClaim.get(claimId);
        if (current && mine) return { verifiedAt: current.verifiedAt, invoice: mine };
        for (const k of Object.values(kids)) {
          const inv = k.verification?.invoices.find((i) => i.claimId === claimId);
          if (k.verification && inv) return { verifiedAt: k.verification.verifiedAt, invoice: inv };
        }
        return current ? { verifiedAt: current.verifiedAt, invoice: undefined } : null;
      },
      errorFor: (claimId) => (own.has(claimId) ? error : Object.values(kids).find((k) => k.error !== null && k.claimIds.includes(claimId))?.error ?? null),
      set, fail, clear, publish,
    };
  }, [stored, err, signature, kids, claimKey, set, fail, clear, publish]);
  // Publish this workspace's CURRENT (stale-filtered) state to a parent provider; withdraw it on unmount.
  const publishUp = parent?.publish;
  useEffect(() => {
    publishUp?.(id, { verification: api.verification, error: api.error, claimIds: claimKey ? claimKey.split("|") : [] });
  }, [publishUp, id, api.verification, api.error, claimKey]);
  useEffect(() => () => publishUp?.(id, null), [publishUp, id]);
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
  return invoiceAuthorisation(recorded, v.verifiedFor(claimId), v.errorFor(claimId) !== null);
}
