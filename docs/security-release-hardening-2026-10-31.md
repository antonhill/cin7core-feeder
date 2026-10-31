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
