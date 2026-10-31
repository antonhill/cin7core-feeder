# Slice 1B: customer-level Rep isolation

Branch `feature/newquip-rep-customer-isolation`, **stacked on PR #127** (`feature/newquip-rep-customer-assignments` @ `1af7c48`, itself stacked on PR #126). Migration **0119** (additive, NOT applied to hosted Supabase). **Enforcement is OFF by default** and is switched on per organisation only by an owner/admin action after a read-only preflight. This slice builds no Rep UI.

Dependency notes: 0119 needs 0112 (`org_functional_roles`), 0110 (approvals) and 0118 (assignments, for the app boundary). A trial merge of this branch with the current #126 branch (which includes the #128 hardening) is conflict-free (checked with `git merge-tree`; no file of this slice was touched by #128 except `src/lib/authorization.ts`/`approvals/actions.ts` in non-overlapping hunks). Nothing here changes PR #126 or #127.

## 1. The rule

> A Rep may access all quotations belonging to customers currently assigned to that Rep. Managers and Estimators keep organisation-wide visibility. Reassignment changes Rep access without touching quotation ownership or history.

When isolation is **ON** for an organisation, an actor has **organisation-wide** quotation access if (and only if) they are

1. an organisation **owner/admin** (`org_members.role` in `owner`, `admin`), or
2. holders of an **EXPLICIT** `org_functional_roles` assignment of **ESTIMATOR** or **MANAGER**.

Everybody else is **assigned-scoped** and sees a quotation only when its **current customer** (the latest `newquip_quote_customers` snapshot; a "(cleared)" marker or none = no customer) is one of their **active** assignments - whoever created it, every revision, document and response included - **or** when it is their **own quotation that has NEVER had a customer** (so a Rep can start work). A quotation whose customer was **cleared** is not the creator's enquiry: it is visible to organisation-wide roles only (clearing must not hand a reassigned customer's history back to the previous Rep). A Rep may create a quotation, but can search for, and select, only their assigned customers.

### Role precedence decision (and the evidence)
`effectiveRoles()` gives a member with **no explicit role** the tier defaults `REP + ESTIMATOR` while strict roles are off. Treating that implicit ESTIMATOR as organisation-wide would make every plain member an "Estimator" and nothing would be isolated. **Decision: only explicit assignments (`org_functional_roles`) confer organisation-wide visibility; tier defaults never do.** Consequences, all covered by tests:

| Person | Isolation OFF | Isolation ON |
|---|---|---|
| owner/admin | all | all |
| explicit MANAGER / ESTIMATOR (with or without REP) | all | all |
| explicit REP only | all (as today) | assigned customers + own customer-less drafts |
| member with **no** explicit role (tier defaults) | all | assigned customers + own drafts (usually none) |
| explicit ADMINISTRATOR / PROCUREMENT / PROJECT_MANAGER only | all | assigned-scoped for quotations (Projects: PM and Procurement keep Projects) |
| Demo Mode | the **effective** user's tier and roles are evaluated, never the owner's | same |

Cost and margin are unchanged and independent: `canSeeCosts` (owner/admin or explicit ESTIMATOR/MANAGER). The Administrator role alone never sees cost. An assigned Rep gets the existing cost-free view.

## 2. Access-boundary inventory (every path, and how it is enforced)

Application boundary = `src/lib/newquip-assignments/access.ts` (`quoteScope`, `guardQuote`, `visibleQuoteIds`, `visibleAmong`, `canSeeApprovalRequest`, `filterApprovalRequests`, `filterNotifications`, `assertCustomerSelectable`, `assertProjectsAccess`). All of them: identity from the session, organisation scoping, authorisation **before** any protected read, one generic denial ("Quote not found." / "Approval request not found." / "Not found.") for "missing" and "not yours", fail closed. Static tests (`isolation-boundary.test.ts`) fail the build if a new quotation action/route omits the guard.

| Path | Enforcement |
|---|---|
| `listGrowerQuotesAction` | filtered to visible ids |
| `getGrowerQuoteAction`, `saveGrowerDraftAction`, `createProjectFromGrowerQuoteAction`, and every workflow step (`sendGrowerQuoteToEstimatorAction`, `returnGrowerQuoteToRepAction`, `signOffGrowerQuoteAction`, `returnGrowerQuoteToEstimatorAction`, `approveGrowerQuoteAction` via `step()`) | `guardQuote` first |
| `createGrowerQuoteAction`, `previewGrowerDraftAction`, `getGrowerViewerAction` | no stored quotation involved (creator keeps their own customer-less draft) |
| `customer-actions`: `getQuoteCustomerAction`, `selectQuoteCustomerAction`, `clearQuoteCustomerAction`, `chooseQuoteContactAction`, `refreshQuoteCustomerAction` | `guardQuote` (via `viewOf`/`editableQuote`); selection also `assertCustomerSelectable` |
| `searchQuoteCustomersForQuoteAction` | assigned-scoped: only the actor's assigned customers; org-wide: unchanged |
| `document-actions`: `getQuoteDocumentsAction`, `issueQuoteDocumentAction` | `guardQuote` |
| `delivery-actions`: view, send, retry, record response, review response, revoke links | `guardQuote` (view and each mutation) |
| `mapping-actions`: `getQuoteScopeAction` | `guardQuote`; mapping history/save are organisation configuration |
| `cost-actions` (all per-quotation actions) | `guardQuote` as defence in depth (they also require `canSeeCosts` = owner/admin or explicit Estimator/Manager, today exactly the organisation-wide set) |
| `GET /api/newquip-quote-documents/[id]` | document -> quotation -> `guardQuote` **before** the file is read; generic 404 |
| `GET /api/newquip-response-evidence/[id]` | evidence -> quotation -> `guardQuote` before the file is read; generic 404 |
| `POST /api/newquip-quote-responses` | `guardQuote` before any file is read or anything recorded |
| Approvals: dashboard, request detail, decide, reassign, document history, submit, notifications | filtered / `visibleRequest` / `visibleDocument`. QUOTE requests follow the quotation rule; CLAIM and VARIATION requests follow the **Project** rule (visible to explicit Project Manager / Procurement, not to a Rep). "Mark all read" touches only the rows the actor can see |
| **E-mail about a quotation** (customer-response and approval/reminder mail) | decided **when the mail leaves** (`deliverRows` -> `recipientMayReceive`): an organisation user who may no longer see the quotation (reassigned away, never assigned, a tier-default "Estimator") is not e-mailed and the row is marked suppressed. Org-wide users are mailed as before; claim/variation mail goes to Projects users (explicit Project Manager / Procurement, org-wide) and not to a Rep; an address that is **not a current organisation user** (removed member, failed lookup, differently spelled address) is mailed only if it is the configured approvals **escalation address**. One check per run caches the switch and the organisation's users; a failure of the check leaves that row as it is and never stops the batch |
| Approvals: settings, e-mail delivery, roles | administrators/managers only (unchanged) |
| Activity log (`listActivityAction`) | `newquip.` / `approvals.` / `projects.` entries follow the quotation scope (`projects.` entries also visible to explicit Project Manager / Procurement); Toolbox entries unchanged |
| Projects module (all 50 actions in `src/app/projects`) | `requireModuleAccess(PROJECTS_MODULE.href, { projectData: true })`: with isolation ON an assigned-scoped Rep is not a Projects user (generic "Not found."); owner/admin, Estimator, Manager, Project Manager, Procurement are. Static test: no Projects call omits the flag |
| Slice 1A Rep workspace (`src/app/newquip-rep`) | already assignment-scoped and cost-free regardless of the switch |
| Public customer portal | token-based, separate project; not user-scoped; unchanged |
| Direct database requests (`authenticated` role) | migration 0119 RLS (below) |
| Storage (`newquip-quote-documents`, evidence) | no `storage.objects` policy for `anon`/`authenticated` (0115/0117): only the guarded server routes read files; no signed URLs are issued |
| Cin7 customer master `customers`, templates, FX rates, package mappings, company profile | organisation configuration / Toolbox master data: deliberately NOT re-scoped (see section 6) |
| Older generic Quotes module (`src/app/quotes`) | different table, out of scope |

## 3. Database changes (migration 0119, `supabase/migrations/0119_newquip_rep_customer_isolation.sql`)

* `newquip_access_settings` (per-organisation switch, default OFF; no row = OFF) and append-only `newquip_access_setting_events` (who, when, why, the preflight shown).
* `newquip_set_rep_isolation(org, enabled, actor, reason, preflight)`: `SECURITY INVOKER`, `service_role` only; setting + audit event in **one** transaction, serialised per organisation (advisory lock). Clients cannot read or write either table.
* Helpers `newquip_isolation_on`, `newquip_quote_scope_ok`, `newquip_project_scope_ok` (`SECURITY DEFINER`, `search_path = public`, executable by `authenticated`/`service_role` only).
* Re-created **SELECT** policies (`is_org_member(org_id) and <scope test>`): `newquip_quotes`, `newquip_quote_customers`, `newquip_quote_documents`, `newquip_quote_sends`, `newquip_quote_responses`, `newquip_response_reviews`, `newquip_response_evidence`, `newquip_response_links`, `approval_requests` and `approval_events` **by document type** (QUOTE -> quotation scope; CLAIM/VARIATION -> project scope), the recipient policy on `approval_notifications` (recipient test + quotation scope - a Project Manager reads their notifications through the app, not directly); all `projects` + 17 `project_*` tables (project scope); and `activity_log` for `newquip.` / `approvals.` / `projects.` rows (`projects.` rows also follow the project scope).
* The scope helpers answer **false to a non-member** (no cross-organisation probing) and the raw `newquip_isolation_on` helper is not executable by clients. Each policy now makes a definer call per row: run `EXPLAIN` on `activity_log` and the larger tables before enabling on a large organisation.
* **Switch OFF: every re-created policy is `is_org_member(org_id)` in effect** - nothing changes for anyone, so installing the schema has no behavioural effect. **Switch ON:** a direct request reads these rows only as owner/admin or explicit Estimator/Manager (+ Project Manager/Procurement for Project tables).
* No write policy, grant to `service_role`, strict-role flag or existing function is changed. The application reads none of these tables through an RLS-subject client (Slice 1A section 6), so no application behaviour depends on the old organisation-wide policies.

**Design decision to confirm (owner):** at the database layer an assigned-scoped Rep gets **no** direct rows (not even for assigned customers). `newquip_quotes.draft` and `accepted_baseline` hold cost overrides and the frozen margin sheet, and Postgres RLS cannot hide columns per user, so allowing an assigned Rep raw row access would expose cost. The Rep's supported read path is the server boundary above, which applies the assignment **and** strips cost. The assignment-based rule is therefore enforced by the server boundary; the database layer is the deny-by-default backstop for direct requests.

## 4. Rollout (staged, owner-gated)

1. **Merge #126, then #127, then this slice** (stacked; this PR targets #127's branch and is retargeted as the earlier ones merge). Nothing changes in behaviour.
2. **Apply 0118, then 0119** to hosted Supabase (separate owner approvals). Still no behavioural change: the switch row does not exist = OFF.
3. **Prepare data:** assign customers to Reps (`assignRepToCustomerAction`), give an **explicit** Estimator/Manager role to anyone who must keep organisation-wide visibility.
4. **Read the preflight** (`getRepIsolationStatusAction`, owner/admin, read-only): customers with quotations and no Rep, who becomes assigned-scoped and what they would see, who relies on tier-default roles, and blockers (switch/assignments not installed; nobody organisation-wide).
5. **Owner enables** (`setRepIsolationAction({ enabled: true, reason, confirmation: "ENABLE REP ISOLATION" })`): refused on blockers; recorded with the preflight. Production activation is a separate owner decision.
6. **Verify** with a test Rep and Manager (UAT list in the PR). **Rollback = switch OFF** (`setRepIsolationAction({ enabled: false, reason })`): instant, restores today's behaviour, no data change; the audit keeps both changes.

Fail-closed: switch ON but assignments unavailable -> assigned-scoped actors get "Customer assignments are not available yet."; an unreadable switch -> "Access settings are unavailable." (never treated as OFF); organisation-wide actors are unaffected by the assignments being unavailable.

Full schema rollback (only if the migration itself must be reverted): re-create each policy listed above as `using (is_org_member(org_id))` (and `activity_log` as before), then `drop function newquip_set_rep_isolation(uuid, boolean, text, text, jsonb); drop function newquip_project_scope_ok(uuid); drop function newquip_quote_scope_ok(uuid); drop function newquip_isolation_on(uuid); drop function newquip_access_setting_events_guard(); drop table newquip_access_setting_events; drop table newquip_access_settings;`. The code treats a missing switch table as OFF, so the application runs unchanged either way.

## 5. What is intentionally NOT done here
No Rep UI; no strict functional roles; no default or bulk assignments (nothing creates assignments to make anything pass); no change to Cin7 write gates, e-mail, the portal, quotation values/hashes or any approval flow.

## 6. Limits and decisions for the owner
* **Plain members who relied on the implicit Estimator default lose organisation-wide visibility when isolation is ON**; the preflight lists them. Give them an explicit role first.
* **Projects are denied to assigned-scoped Reps** (no Rep Projects workflow exists yet); a per-customer Projects view for Reps is a later slice.
* **Customer-less drafts** are visible to their creator (so work can start); choosing a customer requires it to be assigned, after which the assignment governs.
* **Clearing a customer** on a quotation you did not create removes it from your view immediately (it becomes a customer-less draft of its creator).
* **Not covered, by design:** the synced Cin7 `customers` master table and the **Toolbox reports** that read Cin7 sales/invoices (including Project-posted invoices) remain organisation-wide under module access; so do the older generic **Quotes module** (`quotes`/`quote_lines`, a different table), organisation configuration tables, and the home-page activity count (a number only). A Rep can also still learn whether a customer *name* exists in Cin7 through the selection error. Review before onboarding multiple Reps if customer names or sales history themselves are sensitive.
* **Creator is matched by e-mail** (not user id) for own never-customered drafts; a reused or changed e-mail would move such drafts. Acceptable for the demo; store a creator id for commercial use.
* **Customer-response mail** goes to the quotation's creator / hand-off / link-sender addresses; after the switch is ON a person who is no longer a current organisation user (or whose login e-mail differs from the stored address) stops receiving it - by design (fail closed).
* The portal's broad credential, acceptance-verification separation of duties and notification environment tagging remain the tracked commercial-launch items in `docs/newquip-security-posture.md` (on the PR #126 branch).
