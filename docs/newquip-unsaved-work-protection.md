# NewQuip unsaved-work protection

Status: D4 correction F-13. Scope: how the app protects typed-but-unsaved input, what it cannot protect, and the evidence.

## What the current Next.js App Router offers

Read from `node_modules/next/dist/docs` (this Next.js version):

- `<Link onNavigate>` runs only on client-side navigation of that one Link and can `preventDefault()`. It is per-Link, so it cannot cover Links the page does not own (header, nav, breadcrumbs) and it never fires for `router.push`, Back or Forward. It adds nothing over the existing document-level click guard, so it is not used.
- There are NO router events in the App Router and NO `router.beforePopState` (that is Pages Router only). `useRouter` has no "block navigation" option. `router.push/replace` cannot be intercepted by the page.
- `beforeunload` covers tab close, reload and address-bar navigation, and shows the browser's own generic dialog (custom text is ignored by browsers).
- Navigation API (`window.navigation`, `navigate` event): present in Chromium. Not available in the Firefox/Safari versions this project can assume; it is feature-detected and simply absent there (not tested in this work: Chrome only).

Known failure modes of the usual "Back blocker" (popstate plus a sentinel `pushState`), all reproduced below: an extra phantom history entry that survives after saving (user must press Back twice), forward-button traps, history length growth, and Next's own popstate handling racing the page's. It was therefore rejected.

## What is implemented

`src/lib/use-unsaved-guard.ts` (`useUnsavedGuard(dirty)`), active only while `dirty`, one shared set of listeners however many guards are dirty, all released on save/cancel/unmount:

1. `beforeunload` (tab close, reload, typed address).
2. Document capture-phase click on same-origin links, with `window.confirm`. A declined click never reaches the router.
3. NEW: browser Back/Forward via the Navigation API, `traverse` navigations only, only when the browser reports the event cancelable, never for hash changes. Declined: the traversal is cancelled and nothing in history changes.

Deliberately NOT done: cancelling `push`/`replace` navigate events. Demonstrated: when a `router.push` navigate event is cancelled the URL stays on the old page but the App Router has already rendered the new page (URL says /a, screen shows page B). That is a silent corruption, worse than no guard.

### Draft persistence: removed

An earlier D4 revision also kept the quotation draft in `sessionStorage` with a "Restore my edits" offer. It was removed: the quotation draft (`QuoteDraft`, `src/newquip/grower/draft.ts`) carries `estimator.costOverrides` (confidential cost), `estimator.unitPrices`, `charges` and the margin inputs, so persisting it would put cost and customer-sensitive pricing into browser storage, and stripping those fields reliably would also change what a "restore" means. Nothing is written to `sessionStorage`/`localStorage` by any NewQuip form now, no sign-out wipe is needed, and the editor no longer calls `auth.getUser()` on mount. Unsaved-change WARNINGS (the layers above) are unchanged.

## Browser evidence (Chrome, real `next build && next start`, driven by playwright-core)

A throwaway two-route lab app (not committed) using the repo's Next version and the SHIPPED `use-unsaved-guard.ts`. Headless Chrome via CDP. Honest limits: Back/Forward were driven with CDP history traversal (`page.goBack()`), NOT a physical click of the browser's Back button (macOS blocked synthetic keystrokes); the real button follows the same Navigation API path but was not exercised.

| Scenario (form dirty) | Result | Evidence |
|---|---|---|
| Link click, decline | stays; URL, screen, history length unchanged | browser |
| Link click, accept | navigates; history +1 | browser |
| Plain `<a>` click, decline | stays | browser |
| Tab close (`runBeforeUnload`) decline then accept | first close blocked, second closes | browser |
| Reload decline / accept | decline stays with state; accept reloads clean | browser |
| Address-bar style `goto` decline | blocked by beforeunload dialog | browser |
| Back, decline (same-document) | stays; URL, screen, history length unchanged | browser (CDP traversal) |
| Back, accept | leaves to previous page | browser (CDP traversal) |
| Back declined, Back again with no new click | second Back leaves with NO prompt (Chrome limits one cancelled traversal per user gesture): never a trap | browser |
| Back declined, then a click, then Back | prompts again, declinable again | browser |
| Back accept then Forward | returns to form; history length intact | browser |
| Back, cross-document entry (page reloaded earlier) | falls back to the browser's beforeunload dialog; decline/accept both clean | browser |
| Saved (clean), then Back | no prompt | browser |
| `router.push` / `router.replace` | NOT guarded (leaves with no prompt) | browser |
| Experiment: cancel `push`/`replace` navigate events | URL stays, screen shows new page: CORRUPTS, rejected | browser |
| Experiment: popstate + sentinel `pushState` | extra history entry (length +1), accept leaves user on same page, link clicks not covered: rejected | browser |
| Firefox, Safari, Back in a real UI, mobile | | NOT tested |

## Coverage by form

| Form | Tab close/reload | In-app link click | Back/Forward (Chromium) | router.push |
|---|---|---|---|---|
| Quotation configuration (newquip-grower/[id]) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Project Details edit form | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Partial claim selection (ProjectWorkspace, claims tab) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Approval reason / override (approvals/[id]) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Variation raise / re-price / reject (VariationsPanel) | yes (jsdom only) | yes (jsdom only) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Variation billing schedule editor + amend reason (VariationBillingPanel) | yes (jsdom only) | yes (jsdom only) | by the shared hook, lab-verified (form itself not run in a browser) | no |
| Approvals admin settings | yes (jsdom only) | yes (jsdom only) | by the shared hook, lab-verified (form itself not run in a browser) | no |

Evidence levels: the hook's tab-close, link-click and Back/Forward behaviour is browser-demonstrated (table above, a lab app using the shipped hook). The three rows added by the wiring workstream are covered by jsdom tests only: they assert the `beforeunload` guard is on when the form differs from its saved/initial value and off when clean, reverted, cancelled, saved, or read-only. Those forms were not driven in a real browser (they need an authenticated session and data). The in-app link-click column for those rows is the same shared hook, not separately asserted in their tests.

What is dirty, per form (a guard exists only while true):

- VariationsPanel: the raise form (project ACTIVE) has any typed field; a DRAFT variation's re-price differs from its current price; a manager has typed a reject reason on a DRAFT variation. A successful raise, re-price or reject clears the field. Decided variations and non-managers' reject (absent) never guard.
- VariationBillingPanel: an editable schedule's rows differ from the saved schedule, compared normalised (trimmed names, numeric percents; so "50.0" equals a saved "50"). A successful save or amend discards the typed rows (reverting, Remove last, or a successful save which reloads the schedule releases it); or an amendment reason is typed on a non-DRAFT variation (a successful amend clears it). Locked schedules (billing started, or a non-manager on an approved variation) never guard.
- Approvals settings: manager on the settings tab and the four fields differ from the values last loaded from the server; a successful save reloads them.

Back/Forward protection comes automatically with the existing wiring; no per-form change was needed. Firefox and Safari get layers 1 and 2 only.

## Recommendations

1. Keep this layered approach; do not add a popstate/sentinel Back blocker or cancel push/replace navigate events.
2. (Done: the remaining forms are wired; jsdom-tested only.)
3. Where a form's main risk is a programmatic `router.push` (e.g. "Save and go"), make sure the code saves first or confirms inline before calling it; the platform offers no safe interception.
4. Run the lab scenarios with a physical Back button, Firefox and Safari before claiming more than the table states.

## Which navigation methods have been tested, exactly

| Method | Real application (authenticated forms) | Lab app with the shipped hook (Chromium, CDP) | jsdom tests |
|---|---|---|---|
| Tab close / reload / address bar (`beforeunload`) | NOT tested | yes | yes (guard on/off) |
| In-app link click | NOT tested | yes | yes (hook and some forms) |
| Back / Forward | NOT tested | yes, via CDP history traversal, not a physical button | no |
| `router.push` / `router.replace` | NOT protected | confirmed unguarded | n/a |
| Firefox, Safari, mobile browsers | NOT tested | NOT tested | n/a |

So: NO navigation method has been exercised in the real, signed-in application (it needs a Supabase session and data). Back/Forward protection exists only in Chromium. Do not describe the forms as fully protected; the owner's browser UAT must run: edit, then leave via a link, via Back, and by closing the tab, on each form.
