# NewQuip public customer portal (separate Vercel project) — design, inventory and activation

Status: **built and tested; NOT deployed.** Creating the Vercel project, attaching a hostname, adding credentials and turning off Deployment Protection for it all need the owner's approval (section 8).

## 1. Why a second project
Vercel Deployment Protection (Vercel Authentication) runs before Next.js middleware, so a customer opening a link on the internal project is sent to a Vercel login regardless of what the application does. The internal Toolbox must stay protected. The customer therefore needs a separately deployed, minimal application on its own project and hostname.

## 2. Architecture
```
repo
├─ src/                    internal Toolbox (Vercel project "cin7core-feeder", Deployment Protection ON, unchanged)
└─ portal/                 PUBLIC customer portal (new Vercel project, Root Directory = portal)
   ├─ app/layout.tsx                         bare root layout, NewQuip-only metadata, noindex, no-referrer
   ├─ app/quote-response/page.tsx            the response page (client; token read from the URL #fragment)
   ├─ app/quote-response/actions.ts          2 server actions: load (records nothing) and submit (explicit)
   ├─ app/api/quote-response/document/route.ts   token-checked PDF (POST only; GET = 405)
   ├─ proxy.ts                               empty proxy: guarantees the INTERNAL src/middleware.ts is never bundled (see 3)
   ├─ next.config.ts / vercel.json / package.json / tsconfig.json / postcss.config.mjs
src/lib/newquip-portal/    the shared, deliberately LEAN source the portal imports
   ├─ core.ts       pure: token parse/hash, environment rule, statuses, standing logic, messages (no I/O)
   ├─ store.ts      resolve a token, load the public quotation, read the PDF, record the response (reads/writes only the tables it needs)
   ├─ notify.ts     queues the Rep's in-app + email rows (QUEUE ONLY: no email provider in the portal)
   └─ rate-limit.ts best-effort per-IP limiter
```
One repository, no new quotation engine: the internal Toolbox imports the same `core.ts` / `notify.ts` (issue links, staff verification) so token rules, statuses and notification text exist once. The `@/` alias resolves to `../src`, and Turbopack's root is the repo root so the shared files compile into the portal.

The customer routes were **moved out of the internal app** (`src/app/quote-response`, `src/app/api/quote-response`): the internal Toolbox serves no customer URL any more, and its middleware `PUBLIC_PATHS` no longer lists them.

## 3. Isolation guarantees (and how they are enforced)
| Guarantee | Enforcement |
|---|---|
| The portal serves exactly 2 routes | `scripts/verify-portal-build.mjs` (CI step) checks the built route table; unit test lists `portal/app` files |
| Every other path (internal pages, APIs, `/login`, crons) is 404 | smoke-tested against `next start`: `/`, `/login`, `/projects`, `/newquip-grower`, `/settings`, `/api/*` all 404 |
| The internal session middleware is not bundled | `portal/proxy.ts` takes precedence (without it Next discovered `../src/middleware.ts`; the verifier fails the build in that case, proven by mutation) |
| No Cin7, costing, project, estimator or shell code is reachable | unit test walks the portal's runtime import graph; the verifier scans the server bundle for Cin7 endpoints and the browser bundle for credential names / internal markers |
| No crons | `portal/vercel.json` has `"crons": []` and the root `vercel.json` is not read by the portal project |
| Browser never talks to Supabase | CSP `connect-src 'self'`; all data goes through server actions (POST body) |
| No caching / referrer / indexing | `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, CSP `frame-ancestors 'none'` on every response |

## 4. Route inventory
**Public portal (new project):** `GET /quote-response` (page + static assets under `/_next/static`), the 2 server actions (POST to the same path), `POST /api/quote-response/document` (GET → 405). Nothing else.

**Internal Toolbox (unchanged, protected):** everything it served before **minus** `/quote-response` and `/api/quote-response/*`. Staff-only routes `/api/newquip-quote-responses` (evidence upload) and `/api/newquip-response-evidence/[id]` (download) stay internal and authenticated.

## 5. Data access and credentials
The portal needs to read link/quote/document/response rows and insert a response + audit + notification rows, so it uses the Supabase **service-role key**, server-side only:
- It is read in `createServiceRoleClient()` inside server actions/route only; never `NEXT_PUBLIC_`; the verifier fails the build if its name appears in the browser bundle.
- The reachable code is ~5 small files; every query is scoped by the link's `org_id`; there is no generic query surface. Compared with the internal app (hundreds of routes holding the same key) the blast radius of the key is much smaller, but it is still a service-role key.
- **Narrower option (recommended follow-up, needs owner approval, NOT done):** a dedicated Postgres role `newquip_portal` granted only SELECT on `newquip_response_links, newquip_quotes (3 columns), newquip_quote_documents, newquip_quote_responses, newquip_response_reviews, newquip_response_evidence`, INSERT on `newquip_quote_responses, activity_log, approval_notifications`, UPDATE (attempts) on links, and storage read of one bucket; reached through a signed JWT for that role. It needs a new migration and a JWT minted from the project JWT secret — a credential action — so it is deliberately not part of this change.
- **No email provider in the portal.** The Rep's in-app notification is immediate; the Rep's email is queued (`approval_notifications`, `PENDING`) and delivered by the internal outbox (production cron every 10 min; on Preview a manager uses "Send pending now"). The Preview allowlist and `[PREVIEW]` marking apply at delivery, unchanged. If the owner wants instant Rep emails from the portal it would have to hold `RESEND_API_KEY` — not recommended.
- No Cin7 credentials, no `ENCRYPTION_KEY`, no billing keys in the portal.

## 6. Vercel settings for the new project (when approved)
| Setting | Value |
|---|---|
| Git repository | `antonhill/cin7core-feeder` (same repo) |
| Root Directory | `portal` ("Include source files outside of the Root Directory": **enabled**, the default) |
| Framework | Next.js (from `portal/vercel.json`) |
| Install Command | `cd .. && npm ci` (from `portal/vercel.json`) |
| Build Command | `next build` (from `portal/vercel.json`) |
| Deployment Protection | **Vercel Authentication: disabled for this project only** (it serves only token-gated routes). The internal project stays protected. |
| Ignored Build Step (optional) | only build when `portal/**`, `src/lib/newquip-portal/**` or `package-lock.json` change |
| Domain | an owner-supplied hostname (e.g. `quote.<owner domain>`), added through the normal Vercel domain flow. **No domain is assumed to exist.** For the POC attach it to the branch `feature/newquip-completion` (Preview) so it serves the PR build. |
| Firewall (recommended) | a rate-limit rule on `/quote-response*` and `/api/quote-response*` (~20 req/min/IP), log-only for a week first |

Environment variables of the **portal** project (all server-side; none `NEXT_PUBLIC_`):
| Name | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | the existing project URL | |
| `SUPABASE_SERVICE_ROLE_KEY` | the existing service-role key | mark **Sensitive**; this is the credential decision in section 8 |
| `NEWQUIP_LINK_ENVIRONMENT` | `preview` while the POC runs on Preview data | pins which links this portal accepts; unknown values are ignored |
| `NEWQUIP_INTERNAL_APP_URL` | the internal Toolbox address (the existing branch alias) | only used for the "Open" link inside the Rep's notification |

Variable added to the **internal** project (Preview, branch `feature/newquip-completion`; later Production):
| Name | Value |
|---|---|
| `NEWQUIP_PUBLIC_PORTAL_URL` | `https://<the approved portal hostname>` (https, no path). Unset or invalid ⇒ emails carry **no** response links (fail closed). |

## 7. Previously issued links
Links already emailed point at the internal (protected) host, so customers cannot open them, and a token is shown only once (only its SHA-256 is stored), so the URL cannot be rebuilt. **They cannot be migrated: re-send.** Use "Send again" (with a reason) in Stage 4 once the portal is live: it issues a fresh link for the same issued document and withdraws every earlier link of the quotation (the old URLs then say "no longer active"). Responses already recorded are unaffected.

## 8. Owner approvals required to activate (nothing below has been done)
1. Create a new Vercel project from the same repository with Root Directory `portal` and the settings above.
2. Supply or approve a hostname and add it (DNS change on the owner's side); assign it to branch `feature/newquip-completion` for the POC.
3. Turn **off** Vercel Authentication for that new project only.
4. Add the four portal variables above, including the existing Supabase service-role key (credential decision; or approve the narrower-role follow-up first).
5. Add `NEWQUIP_PUBLIC_PORTAL_URL` to the internal project's branch Preview scope.
6. (Recommended) approve the Firewall rate-limit rule.
7. Re-send the test quotation to anton@sparkconsulting.co.za only; real customers are not emailed.

## 9. Browser acceptance after activation (for the owner)
Incognito window → open the Accept link from the new email: no login, only NewQuip branding, correct figures, "View quotation PDF" opens the exact issued PDF; submit; Stage 5 shows "verification pending"; the Rep's in-app notification appears (email after "Send pending now" on Preview); Stage 6 stays locked until a Rep/Manager verifies; a second use of the link, an expired/revoked link and a link from another environment are refused; the internal Toolbox URL still asks for Vercel/Toolbox login; `/login`, `/projects` and any `/api/...` on the portal hostname are 404.
