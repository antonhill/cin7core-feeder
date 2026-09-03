---
description: On completion of material work, check whether durable Spark Knowledge changed and write back only the affected notes — with human approval for decisions/history. Supports a dry-run (report only) mode.
argument-hint: [dry-run] <what was implemented>
---

At the end of material work (after normal tests/review), check whether the change altered
**durable knowledge**, and write back **only** the notes that genuinely changed. If the argument
begins with `dry-run`, do the full analysis and report but **write nothing**.

Work completed: $ARGUMENTS

## Resolve the vault root

Read the root from `.claude/spark-knowledge.path` (a `~`-relative path — expand `~` to `$HOME`;
fallback: `~/Obsidian/Spark Knowledge/02 Products/Cin7 Core Toolbox`). Call it `ROOT`.

## Steps

1. **Re-read the notes `/spark-context` (or `/spark-preflight`) loaded for this task** — the same
   minimal set, not a fresh sweep of the vault.
2. **Compare BEFORE-knowledge vs AFTER-implementation** — did the *durable* behaviour, decision,
   risk or architecture change, or only the implementation?
3. **Classify the result** (pick the one that fits; more than one may apply — handle each):
   - **A — NO KNOWLEDGE CHANGE.** Implementation changed, durable behaviour did not. Write
     nothing; say so.
   - **B — CURRENT KNOWLEDGE UPDATE.** Current behaviour changed; an existing feature,
     integration, architecture, or Current State note must be updated to match. Update only those
     notes.
   - **C — ARCHITECTURAL DECISION REQUIRED.** The change would alter an accepted ADR or an
     architectural principle. **Do not update the ADR automatically.** Stop and report it as
     architecture drift / a decision needed; a new ADR only via `/record-decision` with explicit
     human approval.
   - **D — NEW CURRENT RISK.** A real current weakness was found. **Report it explicitly first**,
     then (with acknowledgement) add it to the appropriate feature/integration note's
     `## Current risks and limitations` — keep it distinct from a design trade-off, and never
     conflate two different risks.
   - **E — HISTORICAL EVENT.** An incident or a material correction occurred (see
     `Cin7 Core Toolbox Global Principles.md` / `History/` for what already qualifies as
     preservation-worthy). **Do not rewrite older history notes.** Extend `History/` only with
     approval, preserving what was known then and linking current status rather than
     back-writing history.
4. **If a write-back is appropriate** (B, or D after reporting, or E/C after explicit approval):
   - update **only** the affected notes — never touch unrelated notes opportunistically;
   - refresh provenance: `verified: <today>`, `verified_against: <current full git HEAD>`, and
     `sources:` if the grounding changed;
   - **targeted writeback does NOT automatically advance a note's whole-note `verified_against`.**
     If only one section of a note was reverified, either leave the whole-note pin as-is and add a
     local, inline correction note (the pattern already used throughout this vault's own
     consolidation history), or advance the pin only if the *entire* note was genuinely
     reverified — never advance it as a side effect of a narrow edit;
   - preserve the `## Current` vs history split and the note's `status` frontmatter (`current` /
     `historical` / `accepted`);
   - validate every wikilink, and that no basename collision or secret was introduced;
   - report **every** note changed, with a one-line reason each.
5. **Dry-run mode:** if the argument starts with `dry-run`, output the classification and the
   exact proposed edits (which notes, what would change) but make **no** file changes — to
   Obsidian or code.

## Output

```
SPARK CLOSE — <work> [DRY-RUN if applicable]

Notes reviewed: <the spark-context/spark-preflight set>
Classification: <A / B / C / D / E, with a sentence each where it applies>

Proposed / applied knowledge changes:
<per note: what changed and why — or "none (A)">

verified_against handling:
<per changed note: pin retained with local correction note, or pin advanced because the whole
 note was reverified — never both implied at once>

Requires human decision: <C architectural drift, or E history — described; or "none">
New current risk reported: <D — described; or "none">

Notes changed: <list, or "none — dry-run / no change">
Repository: <untouched — this workflow edits only Obsidian>
```

## Hard boundaries

- Never silently rewrite an accepted ADR (C is report-and-stop, not auto-edit).
- Never rewrite a historical note to match current truth; add a "current status" pointer forward
  instead, never back-write history.
- Never promote an Open Question or a Deferred Decision to an Accepted one, or turn either into a
  backlog.
- Never update unrelated knowledge while closing a task; never sweep the vault.
- Never copy a secret or credential into a note.
- Never advance a note's whole-note `verified_against` for a narrow, targeted change — see step 4.
- This workflow modifies **only** Obsidian notes (never repository files).
