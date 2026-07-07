# Sub-processor list

**Status: DRAFT — see [README.md](README.md) before using this.**

Cin7 Core Toolbox ("the App") is operated by Spark Consulting. To provide the
App, Spark Consulting uses the following sub-processors, each of whom may
process personal information on our behalf strictly to deliver the
functionality described:

| Sub-processor | Purpose | Location of processing | Data involved |
|---|---|---|---|
| Vercel Inc. | Application hosting, serverless function execution, request logs | United States (with global edge network) | Whatever passes through the App at runtime — see Privacy Policy |
| Supabase Inc. (Postgres database, Auth) | Primary data store; authentication (OTP email codes) | `eu-west-1` (Ireland) — confirm current region in the Supabase project dashboard before publishing | All data described in the Privacy Policy: account data, org data, imported CSV data, encrypted Cin7 credentials, activity log |
| [Underlying cloud provider behind Supabase's `eu-west-1` region — confirm via Supabase's own published subprocessor list before publishing] | Infrastructure underlying Supabase's managed Postgres | Ireland | Same as above (encrypted at rest by Supabase; Cin7 credentials additionally application-level encrypted before storage) |
| [Email/SMTP provider for Supabase Auth OTP codes — confirm which provider is configured] | Delivery of one-time login codes | Varies by provider | Recipient email address, one-time code |

## Not a sub-processor: Cin7 Core

The client's own Cin7 Core account is **not** a sub-processor of Spark
Consulting. Cin7 is the client's pre-existing system of record; the App
connects to a Cin7 account the client already owns, using credentials the
client supplies, to read and write data at the client's direction. Spark
Consulting does not receive the client's Cin7 data as a controller — it acts
as a processor operating on data that lives in a system the client controls
independently of this App.

## Change notice

[Placeholder — decide and state a real commitment, e.g.: "Spark Consulting
will notify clients at least 30 days before adding or replacing a
sub-processor, via email to the account's registered contact."]
