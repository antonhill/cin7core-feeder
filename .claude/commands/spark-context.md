---
description: Load the minimum relevant Spark Knowledge context for a task and produce a short context brief. Read-only; modifies no code and no Obsidian note.
argument-hint: <short description of the task / domain>
---

Load the **minimum** relevant Spark Knowledge context for the task below and produce a short brief.
This is **read-only** — it must not modify any code file and must not modify any Obsidian note.

Task: $ARGUMENTS

## Resolve the vault root

Read the Spark Knowledge root from `.claude/spark-knowledge.path` (a one-line path). It uses a
leading `~` — **expand `~` to the user's home directory (`$HOME`)** when reading notes. If that
file is missing, fall back to `~/Obsidian/Spark Knowledge/02 Products/Cin7 Core Toolbox` and say
so. Call this `ROOT` below.

Notes live at `ROOT` top-level (`Cin7 Core Toolbox.md`, `Cin7 Core Toolbox Current State.md`,
`Cin7 Core Toolbox Global Principles.md`, `Cin7 Core Toolbox Environment and Validation
Constraints.md`, `Product Vision.md`, `Glossary.md`, `Open Questions.md`) **and** in subfolders
(`Architecture/`, `Features/`, `Integrations/`, `Decisions/`, `History/`, `Development/`). There
is no separate `Deferred/` folder — deferred (consciously postponed) decisions live inside
`Decisions/Cin7 Core Toolbox Decisions.md`'s own "Deferred Decisions" section, alongside the
accepted-ADR index. **Resolve a note by its name** (the `[[wikilink]]` basename) — locate it under
`ROOT` regardless of subfolder rather than assuming a path, since folder layout may change.

## Steps

1. **Always read the orientation core** (small, cheap): `ROOT/Cin7 Core Toolbox.md`,
   `ROOT/Cin7 Core Toolbox Current State.md`, `ROOT/Cin7 Core Toolbox Global Principles.md`.
2. **Determine the task domain** from the task text — e.g. Import & Sync, Migrate, one of the
   Reporting-family reports, Data Audit, Bulk Pricing, Quotes, Replenish, Purchase Planner,
   Stocktake Assistant, Picking Calendar, System Health, Cin7 Instances, Activity Log, or one of
   the six non-toggleable platform capabilities (Security, Diagnostics, Admin, Billing, Team,
   Notifications) — or a cross-cutting concern (authorization, source-of-truth, write integrity,
   the sync engine, or one of the five external integrations: Cin7 Core, Supabase, Lemon Squeezy,
   Resend, Vercel).
3. **Load only the notes that match that domain**, not the whole vault (resolve each by name
   under `ROOT`, whatever subfolder it is in):
   - the relevant **Architecture** note(s) and the specific **Feature** note(s) (`Features/`) for
     the domain, and the **Integration** note(s) (`Integrations/`) if the task touches an
     external service;
   - the applicable **accepted ADRs** — consult `Decisions/Cin7 Core Toolbox Decisions.md` as the
     index (Accepted ADRs, Deferred Decisions, Needs Explicit Product Ratification), then read
     only the ADRs that bear on this task;
   - the **Current risks and limitations** sections of the touched feature/integration notes;
   - `ROOT/Open Questions.md` **only if** the task could touch a genuinely unresolved decision;
   - `Authorization Model` (in `Architecture/`) whenever the task touches module access, role,
     billing/write-eligibility, AAL2, or the service-role boundary;
   - `Source of Truth Boundaries` (in `Architecture/`) whenever the task touches which system
     (Cin7 or the Toolbox) is authoritative for a fact.
4. **Consult a historical note only if** you need to understand *why* a current rule exists
   (`ROOT/History/Security Re-audit 2026.md`, `ROOT/History/Material Incidents and
   Corrections.md`). Treat these as what-was-known-then, never as current implementation truth —
   their frontmatter `status: historical` marks this.
5. Do **not** indiscriminately load every note. If unsure whether a note is relevant, prefer the
   specific feature/integration note over the whole vault, and say what you deliberately skipped.
6. **Never treat `docs/PROJECT-NOTES.md` as current knowledge.** It is retired — see its own
   retirement notice. If a code comment or old file references it, that is a lead to verify
   independently, never evidence on its own.

## Output — a short context brief

Keep it tight. Do not paste whole notes; summarise and cite the note name.

```
SPARK CONTEXT BRIEF — <task>

Vault root: <ROOT or fallback note>
Current verified baseline: <the SHA Cin7 Core Toolbox Current State.md is verified_against>
Domain: <the domain(s) identified>

Relevant current architecture:
<1–4 bullets, each citing its note>

Applicable accepted ADRs:
<CCT-ADR-00NN <title> — the constraint it imposes> (or "none directly applicable")

Relevant feature/integration behaviour:
<the current durable behaviour that governs this task, per the feature/integration note(s)>

Known current risks in this area:
<the Current Risks that touch this task> (or "none recorded")

Relevant unresolved / deferred matters:
<Open Questions / Deferred Decisions that bear on this task> (or "none")

Constraints that must not be violated:
<the hard rules for this task — source-of-truth boundary, module/role/billing/AAL2 boundary,
 write-integrity/idempotency rule, fail-closed, honesty-about-unknowns>

Notes loaded: <list>
Notes deliberately skipped: <list, with one-line reason>
```

## Boundaries

- Read-only: never edit a code file or an Obsidian note in this command.
- Never treat a `historical` note as current truth; never treat Obsidian as overriding current
  code; never treat `docs/PROJECT-NOTES.md` as current knowledge.
- If a `current` note and the code you glance at appear to conflict, **flag it** in the brief
  rather than resolving it silently — a full reconciliation is `/spark-preflight`'s job.
