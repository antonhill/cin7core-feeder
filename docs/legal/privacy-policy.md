# Privacy Policy — Cin7 Core Toolbox

**Status: DRAFT — see [README.md](README.md) before using this. Not legal
advice. Requires attorney review before publishing or sending to a client.**

*Last drafted: 2026-07-07. Replace with the actual publish date once
reviewed and approved.*

## 1. Who we are

Cin7 Core Toolbox ("the App") is operated by Spark Consulting
("Spark Consulting", "we", "us"), based in South Africa. This policy is
written primarily to comply with South Africa's Protection of Personal
Information Act (POPIA). If a client's own data processed through the App
includes personal information of individuals in the European Union or
United Kingdom, the GDPR/UK GDPR may also apply to that data — see
section 8.

Contact for privacy matters: anton@sparkconsulting.co.za.

## 2. What the App does

The App connects to a client's own Cin7 Core account(s) to help the client
import, validate, audit, migrate, and report on their own inventory,
sales, and product data. Clients provide their own Cin7 API credentials;
the App uses those credentials only to act on the client's Cin7 account, at
the client's direction.

## 3. What information we process

- **Account data**: your name/email, used for login (one-time email code —
  we do not store passwords) and to identify who performed which action.
- **Organization data**: the organization(s) you belong to, and which App
  features ("modules") are enabled for your organization.
- **Cin7 credentials**: your Cin7 Core account ID and application key,
  encrypted at rest (AES-256-GCM) before storage, decrypted only in server
  memory when making a request to Cin7 on your behalf. Not stored or logged
  anywhere in plaintext.
- **Your Cin7 business data**: whatever product, sales, purchase,
  assembly/production, customer, and supplier records you import, or that
  the App pulls live from your connected Cin7 instance(s) to run a report,
  audit, or health scan. This may include personal information about your
  own customers or suppliers (e.g. contact names, emails, addresses) if
  present in your Cin7 data.
- **Activity log**: a record of every write the App makes back to your
  Cin7 instance(s) — what changed, which user triggered it, and when — kept
  for your own auditability.
- **Basic technical logs**: standard hosting-provider request logs (see
  Sub-processors), used only for operating and debugging the App.

We do not sell personal information, and we do not use client data for
advertising.

## 4. Why we process it (lawful basis)

Processing is necessary to perform the service you've engaged Spark
Consulting to provide (contract), and in some cases our legitimate interest
in operating, securing, and improving the App. Where your own Cin7 data
contains personal information of your customers/suppliers, you (the client)
remain the responsible party/controller for that data under POPIA/GDPR, and
Spark Consulting acts as an operator/processor on your behalf — see the
Data Processing Agreement.

## 5. Where data is stored and processed

- Application hosting: Vercel (see Sub-processor list for region details).
- Primary database: Supabase (Postgres), hosted in the `eu-west-1` (Ireland)
  region as of this drafting — confirm current region before publishing.
- Data may transit through infrastructure located outside South Africa as a
  result of this hosting setup. [Placeholder — if any client data subjects
  are outside South Africa, or if this matters to a specific client
  contract, this section needs a real cross-border-transfer justification
  under POPIA section 72 before publishing.]

## 6. Data isolation between organizations

The App is multi-tenant: multiple organizations use the same underlying
database, but Postgres Row-Level Security policies enforce that a user can
only ever query their own organization's data — this is enforced at the
database layer, not just in application code.

## 7. Retention and deletion

[Open question — not yet resolved in the product. As of this drafting,
there is no automated retention or deletion schedule: data persists until
manually deleted by Spark Consulting on request. Do not publish this
section as-is; decide a real retention commitment (e.g. "data is retained
for the duration of the engagement plus 30 days after termination, after
which it is deleted on request") and either build the automation or commit
honestly to the manual process.]

## 8. GDPR (conditional)

This section only applies to the extent a specific client's own Cin7 data
includes personal information of individuals located in the EU/UK. In that
case, the client is the data controller for that information, and this
paragraph, together with the Data Processing Agreement, is intended to
serve as the Article 28 processor terms. [Placeholder — a GDPR-specific
clause set, including EU representative details if required, should only be
added once a client actually triggers this scenario; do not carry boilerplate
GDPR language for South African clients with no EU data subjects.]

## 9. Your rights

Under POPIA, you (or, where applicable, the individuals whose personal
information appears in your Cin7 data) have the right to request access to,
correction of, or deletion of personal information held about you, and to
object to processing, subject to the exceptions in POPIA. To exercise these
rights, contact anton@sparkconsulting.co.za.

## 10. Security

- Cin7 credentials are encrypted at rest (AES-256-GCM) and never logged in
  plaintext.
- Login uses a one-time email code rather than a password.
- Database access is enforced per-organization via Row-Level Security.
- All writes the App makes to your Cin7 instance are recorded in an
  auditable activity log.
- [Placeholder — add any additional commitments once actually true:
  incident notification timeline, penetration testing cadence, etc. Don't
  assert anything not yet in place.]

## 11. Sub-processors

See [subprocessors.md](subprocessors.md) for the current list.

## 12. Changes to this policy

[Placeholder — state a real commitment, e.g. "We will notify registered
users by email of material changes to this policy at least 30 days before
they take effect."]
