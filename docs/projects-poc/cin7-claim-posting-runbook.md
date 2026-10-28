# Cin7 claim posting — runbook (branch `feature/cin7-claim-posting`, migration 0104)

**What it does.** Links a Project to ONE existing Cin7 *Advanced Sale* (a single read), then posts each APPROVED claim as ONE DRAFT
commercial invoice on that Sale (`POST /sale/invoice`, no stock lines, charges in `AdditionalCharges`, Memo `NEWQUIP-PROJECTS:<project>:<claim>`).
No fulfilment, stock or COGS. Mirrors the hand-proven P5 request (INV-00019 on SO-00015).

**Off by default.** `NEWQUIP_CIN7_WRITES_ENABLED` must be exactly `true`, the org must be the rollout org, the caller a manager
(org owner/admin), the claim APPROVED, the Sale linked, the posting state safe, and the exact confirmation given — all server-side.

**State machine** (`project_claim_cin7_postings`, one row per claim): `NOT_SENT` (no row) → `PENDING` (intent persisted *before* the call)
→ `CREATED` → `RECONCILED`; failures: `FAILED_CONFIRMED_NO_WRITE` (Cin7 4xx; controlled retry, same key/memo) and `FAILED_UNCERTAIN`
(timeout / dropped connection / 5xx / 200 without our memo; **no retry until reconciliation**). Reconciliation reads the Sale back and matches
the EXACT memo and the frozen ex-VAT / VAT / total; a mismatch is surfaced, never silently reconciled.

**Known trade-offs.** One AdditionalCharge per claim line (stage) for traceability. Invoice date = today, due = +30 days. The revenue account
is entered by the manager at link time (not guessed). The claim's own `status` is not moved through its `CIN7_*` states; the posting table is
the source of truth for Cin7 state. Variations are not posted (no separate Sale).

## Rollout sequence
1. Review → CI green (clean bootstrap runs `supabase/tests/0104_*.test.sql`). Apply 0104 to hosted Supabase (owner approval; never `db push` blind).
2. **Phase 1 — disposable Sale.** Create a throw-away Advanced Sale in Cin7 (AUTHORISED, no existing progress invoices), a throw-away Project + approved
   claim, set `NEWQUIP_CIN7_WRITES_ENABLED=true` on a *preview*, link the Sale, post once. Verify in Cin7: exactly one DRAFT invoice, correct ex VAT / VAT /
   total, the memo, correct Sale, no fulfilment / stock movement / COGS. Click twice → no second invoice. Run *Reconcile* → RECONCILED.
3. **Phase 2 — uncertain write.** Simulate at the application boundary (never create a duplicate Cin7 document): state must become `FAILED_UNCERTAIN`,
   the UI must refuse retry, and *Reconcile* must be required.
4. **Phase 3 — the real claim `PRJ-NQ-Q-0001-C01`.** NOT without Anton's explicit instruction.
