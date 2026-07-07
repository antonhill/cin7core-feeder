# Data Processing Agreement (DPA) — Cin7 Core Toolbox

**Status: DRAFT — see [README.md](README.md) before using this. Not legal
advice. Requires attorney review before this is executed with any client.**

*Last drafted: 2026-07-07.*

This Data Processing Agreement ("DPA") forms part of the agreement between
Spark Consulting ("Operator", "we") and [Client name] ("Responsible Party",
"Client") for Client's use of the Cin7 Core Toolbox ("the App"). Terms not
defined here have the meaning given in POPIA (and, where applicable, the
GDPR).

## 1. Roles

Client is the Responsible Party (POPIA) / Controller (GDPR, where
applicable) for any personal information contained within its own Cin7 Core
data that is processed via the App (e.g. personal information about
Client's customers or suppliers). Spark Consulting is the Operator (POPIA) /
Processor (GDPR, where applicable), processing that personal information
solely on Client's documented instructions, as set out in this DPA.

For personal information about Client's own authorized users of the App
(name, email, login activity), Spark Consulting acts as Responsible
Party/Controller in its own right, as described in the Privacy Policy.

## 2. Subject matter and duration

- **Subject matter**: processing of personal information contained in
  Client's Cin7 Core data, to the extent that data passes through the App
  in the course of import, validation, migration, reporting, audit, or
  system-health functionality that Client uses.
- **Duration**: for as long as Client has an active engagement with Spark
  Consulting for use of the App, plus any retention period stated in
  section 7 of the Privacy Policy [placeholder — align once that section is
  finalized].

## 3. Nature and purpose of processing

The App reads and writes Client's own Cin7 Core data (products, sales,
purchases, assemblies/production, customers, suppliers) strictly to perform
the functions Client selects — importing CSV data, validating and
bulk-fixing data quality issues, migrating data between Client's own Cin7
instances, and generating reports/health scorecards. Spark Consulting does
not use this data for any purpose beyond providing these functions to
Client.

## 4. Categories of data subjects and personal information

- Client's own authorized App users (name, email).
- Where present in Client's Cin7 data: Client's customers, suppliers, and
  their contacts (names, emails, phone numbers, addresses) — only to the
  extent Client has already recorded this information in its own Cin7
  account.

## 5. Operator/Processor obligations

Spark Consulting shall:
- Process personal information only on Client's documented instructions
  (including instructions given via Client's ordinary use of the App's
  features), unless required otherwise by law.
- Ensure Cin7 credentials are encrypted at rest (AES-256-GCM) and any
  personnel with system access are bound by confidentiality.
- Implement the technical measures described in the Privacy Policy section
  10 (Row-Level Security data isolation, encrypted credential storage,
  auditable activity log of all writes back to Cin7).
- Not engage a new sub-processor without providing notice per the
  Sub-processor list's change-notice commitment [placeholder — align once
  that commitment is finalized].
- Assist Client, to a reasonable extent, in responding to data subject
  requests (access, correction, deletion) concerning personal information
  processed via the App.
- Notify Client without undue delay upon becoming aware of a personal
  information breach affecting Client's data. [Placeholder — state a
  specific notification timeframe, e.g. "within 72 hours," once agreed.]
- On termination, delete or return Client's data per section 7's retention
  commitment [placeholder — align once finalized], unless retention is
  required by law.

## 6. Sub-processing

Spark Consulting may engage the sub-processors listed in
[subprocessors.md](subprocessors.md) to provide the App. Spark Consulting
remains responsible for each sub-processor's compliance with obligations
equivalent to those in this DPA.

## 7. Cross-border transfers

Client's data is processed using infrastructure that may be located outside
South Africa (see Privacy Policy section 5 — Vercel and Supabase's
`eu-west-1`/Ireland region as of this drafting). [Placeholder — this needs a
real POPIA section 72 justification (e.g. adequate protection in the
destination country, or Client's consent) confirmed by counsel before
execution, and a GDPR Article 46 transfer mechanism if Client's data
includes EU/UK personal information.]

## 8. Liability, indemnity, governing law

[Placeholder — deliberately left blank. These are commercial/legal
judgment calls for Anton and counsel, not something to draft from
first principles: liability caps, indemnification scope, governing law and
jurisdiction (South Africa, presumably), dispute resolution mechanism.]

## 9. Audit rights

[Placeholder — decide what's actually offered, e.g. "Client may request a
summary of Spark Consulting's security measures annually" vs. a fuller
on-site/documentation audit right. What's realistic for a small
consultancy operating a SaaS tool should shape this, not a boilerplate
enterprise clause.]

## Signatures

[Placeholder — standard signature block once finalized.]
