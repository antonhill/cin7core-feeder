# NewQuip release hardening (2026-10-31)

Six targeted corrections from the pre-release review. No migration, no change to calculations, quotation values, approval flows or Project records.

| # | Change | Where |
|---|---|---|
| 1 | Cin7 writes only on a Vercel **Preview** deployment (`VERCEL_ENV === "preview"`) that is wired to the approved cin7toolbox project **and** has `NEWQUIP_CIN7_WRITES_ENABLED=true`. Production, local, test and unknown environments never write. `createCin7SaleAction` now also verifies the expected NewQuip POC Cin7 instance (as recovery and mapping already did). | `src/lib/projects/write-flag.ts`, `src/app/projects/cin7-actions.ts` |
| 2 | Approval detail returns internal cost and margin only to an organisation owner/admin or a Manager. The Administrator role alone no longer receives it (see `canSeeCosts`). | `src/app/approvals/actions.ts` |
| 3 | **Production email opt-in** `NEWQUIP_PRODUCTION_EMAIL_ENABLED=true` (default OFF). Without it Production suppresses every NewQuip email (approval delivery, scheduled worker, manager send/retry, quotation first send and retry); queued rows become terminally SUPPRESSED so they cannot be sent later. A `RESEND_API_KEY` does not enable it. Preview keeps its allowlist. (Ship-by and BOM alerts are other features and are not changed.) | `src/lib/approvals/email-policy.ts`, `src/lib/newquip-quotes/send-store.ts`, `delivery-actions.ts` |
| 4 | Staff-recorded acceptance with evidence is recognised as final at both call sites, so no contradictory acceptance/decline can be recorded and a link acceptance cannot be verified alongside it. | `src/lib/newquip-quotes/acceptance.ts` |
| 5 | A wrong secret against a link id never changes the link (it is indistinguishable from an unknown link), so knowing only the id cannot lock the real customer out. The holder's own repeated invalid input is still bounded; expiry, revocation, one-response-per-link and rate limiting are unchanged. | `src/lib/newquip-portal/store.ts` |
| 6 | Customer-supplied reason, name and company in internal notifications: links, web addresses and email addresses are replaced by a visible marker, control/zero-width/bidi characters become spaces, whitespace is collapsed, length capped. | `src/lib/newquip-portal/notify.ts` |

Operating notes: to turn Production email on later, set `NEWQUIP_PRODUCTION_EMAIL_ENABLED=true` **and** configure the provider, after notifications carry the environment that created them (see the incident document, section 8). Verification is by tests with fail-before-fix and mutation evidence in the PR.

## Independent review of this PR: what was fixed and what is deliberately deferred
Fixed in this PR after review: the link sanitiser also removes one-letter hosts (`t.co`, `x.com`), internationalised domains and dotted IPv4 addresses, and strips every invisible/format/private-use character plus blank-looking fillers and variation selectors (Unicode TAG characters can hide text).

Deferred (P2, none exploitable in the internal demo; record for commercial launch):
* **Stale backlog on Production email go-live.** The queue carries no environment tag, so rows left PENDING while Production is blocked could be sent when `NEWQUIP_PRODUCTION_EMAIL_ENABLED=true` is first set. Before enabling: suppress every PENDING/FAILED EMAIL row in `approval_notifications` and review `newquip_quote_sends`; then add an `origin_env` tag (migration).
* **Staff acceptance whose evidence upload failed** (`EVIDENCE_MISSING`) is not final until evidence is attached; `attachEvidence` and the portal/verify checks do not yet block a competing link acceptance in that window.
* **Invoice posting** (`postClaimToCin7Action`) does not re-check the Cin7 instance of the linked Sale (sale creation and recovery do). Production stays hard-off and the organisation has one active instance.
* **Local runs:** the write gate trusts the `VERCEL_ENV` string, so a local run with `VERCEL_ENV=preview` pulled from Vercel would pass it. Convention, not a guarantee.
* **Estimator in approval detail** still does not receive cost (unchanged behaviour); the quotation screens do.
* **Sanitiser false positives:** a missing space after a full stop (`expensive.Please`, `St.John`) is read as a host and replaced. Initials without a space (`J.Smith`, `P.O.Box`) are kept unless they carry a path/port or a known TLD. The sanitiser bounds its own input (about 4x the output cap, minimum 1,000 characters) so pattern cost never depends on a caller trimming first.
