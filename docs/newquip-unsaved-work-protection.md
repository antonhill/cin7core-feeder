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

`src/lib/form-draft.ts` + `src/lib/use-form-draft.ts`: DRAFT PERSISTENCE for form input. Wired ONLY to the quotation editor (`src/app/newquip-grower/[id]/page.tsx`).

- sessionStorage only (per tab, gone when the tab closes; nothing in localStorage, so a shared computer keeps nothing after the tab is closed).
- Key `nq-draft:v1:<authUserId>:<kind>:<recordId>`: another signed-in user in the same tab never sees it; record ids are per-organisation UUIDs.
- Envelope stores the server `draft_hash` it was based on. If the server copy has changed (another person saved), the draft is STALE: it is removed, never restored over newer saved work, and the user is told.
- 12 hour TTL, 200k character cap, versioned, shape-validated, every storage access try/caught.
- Written 400 ms after the last edit while dirty; cleared when the editor returns to clean (Save, reload from server, discard). Restore is explicit (a banner with "Restore my edits" / "Discard"), never automatic.
- Only the form value is stored (the quotation draft the editor already holds). No tokens, no passwords.
- Residual risk: the quotation draft includes cost overrides when the user may see commercials; they sit in that tab's sessionStorage until the tab closes, the draft is saved/discarded, or 12 hours pass. `clearAllDrafts()` exists for a sign-out hook but is NOT wired (sign-out is outside this change); recommend wiring it in the sign-out action's client handler.

## Browser evidence (Chrome, real `next build && next start`, driven by playwright-core)

A throwaway two-route lab app (not committed) using the repo's Next version and the SHIPPED `use-unsaved-guard.ts` / `form-draft.ts`. Headless Chrome via CDP. Honest limits: Back/Forward were driven with CDP history traversal (`page.goBack()`), NOT a physical click of the browser's Back button (macOS blocked synthetic keystrokes); the real button follows the same Navigation API path but was not exercised.

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
| Draft: reload keeps edits; other user key sees none; server version changed -> stale dropped; new tab sees none; cleared after save | as stated | browser (storage module only, in the lab page) |
| Draft restore banner and quotation editor wiring | | jsdom/unit only: the real editor needs an authenticated Supabase session and data and was not run in a browser |
| Firefox, Safari, Back in a real UI, mobile | | NOT tested |

## Coverage by form

| Form | Tab close/reload | In-app link click | Back/Forward (Chromium) | router.push | Draft restore |
|---|---|---|---|---|---|
| Quotation configuration (newquip-grower/[id]) | yes | yes | yes | no | yes |
| Project Details edit form | yes | yes | yes | no | no |
| Partial claim selection (ProjectWorkspace, claims tab) | yes | yes | yes | no | no |
| Approval reason / override (approvals/[id]) | yes | yes | yes | no | no |
| Variation raise / re-price / reject (VariationsPanel) | NOT WIRED | not wired | not wired | no | no |
| Variation billing schedule editor (VariationBillingPanel) | NOT WIRED | not wired | not wired | no | no |
| Approvals admin settings | NOT WIRED | not wired | not wired | no | no |

Back/Forward protection comes automatically with the existing wiring; no per-form change was needed. Firefox and Safari get layers 1 and 2 only.

## Wiring still needed (variations workstream owns those files)

In each component, one line once the dirty condition is known (`import { useUnsavedGuard } from "@/lib/use-unsaved-guard"`):

- `VariationsPanel.tsx`: `useUnsavedGuard(<raise form open with any field changed> || <re-price form open with changed lines> || <reject form open with a typed reason>)`.
- `VariationBillingPanel.tsx`: `useUnsavedGuard(<schedule editor open && rows differ from the saved schedule>)`.
- Approvals admin settings: `useUnsavedGuard(<form value differs from the loaded settings>)`.

Dirty must mean "differs from the saved record" so Cancel and a successful save release the guard. Draft persistence can be added to any of them with `useFormDraft` (needs a server `base` such as an updated_at/hash).

## Recommendations

1. Keep this layered approach; do not add a popstate/sentinel Back blocker or cancel push/replace navigate events.
2. Wire the three remaining forms above.
3. Wire `clearAllDrafts()` into sign-out.
4. Where a form's main risk is a programmatic `router.push` (e.g. "Save and go"), make sure the code saves first or confirms inline before calling it; the platform offers no safe interception.
5. Run the lab scenarios with a physical Back button, Firefox and Safari before claiming more than the table states.
