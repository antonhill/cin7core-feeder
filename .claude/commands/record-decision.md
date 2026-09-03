---
description: Record an EXPLICITLY human-approved architectural/product decision as a CCT-ADR in the Spark Knowledge vault. Does not decide architecture autonomously; refuses to record without approval.
argument-hint: <the decision to record (must already be human-approved)>
---

Record a decision in the Spark Knowledge vault. **This workflow does not decide architecture.** It
only *records* a decision a human has **explicitly approved**, and only when the matter is
genuinely an architectural/product decision.

Matter to record: $ARGUMENTS

## Resolve the vault root

Read the root from `.claude/spark-knowledge.path` (a `~`-relative path — expand `~` to `$HOME`;
fallback: `~/Obsidian/Spark Knowledge/02 Products/Cin7 Core Toolbox`). Call it `ROOT`.

## Steps

1. **Classify the matter first** — do not assume it is an ADR. Decide which it is:
   - **Accepted decision** — a real architectural/product choice with lasting consequences → a
     `CCT-ADR-00NN` *if and only if* a human has explicitly approved it;
   - **Current risk** — a known implementation weakness, no durable policy change → belongs in
     the relevant feature/integration note's `## Current risks and limitations`, not an ADR;
   - **Deferred decision** — a decision consciously postponed, with a reason if known → the
     "Deferred Decisions" section of `ROOT/Decisions/Cin7 Core Toolbox Decisions.md`, not a new
     file;
   - **Open question** — a decision not yet made, no evidence it was consciously postponed →
     `ROOT/Open Questions.md`;
   - **Ordinary implementation detail** — no durable-knowledge change → record nothing here.
   State the classification and stop if it is not an approved Accepted decision. Do **not**
   invent an ADR to fit an idea, a bug, or an unresolved question.
2. **Require explicit approval.** If the human has not clearly approved this specific decision, do
   not write an ADR — report what you would record and ask for approval. Never promote an Open
   Question or a Deferred Decision to an Accepted one on your own.
3. **Follow the existing conventions.** Read a recent `Decisions/CCT-ADR-00NN *.md` file for the
   established section pattern (`## Status`, `## Decision`, `## Context`, `## Rationale`, and
   further sections such as `## Invariants` / `## Consequences` / `## Evidence` / `## Related` as
   the existing ADRs use them) and match it — do not invent a new template. Read
   `ROOT/Decisions/Cin7 Core Toolbox Decisions.md` for the current accepted-ADR list and **derive
   the next number from it** (the highest `CCT-ADR-00NN` present, plus one) — never hardcode a
   number from memory, since the count changes as decisions are accepted.
4. **Write the ADR** as `ROOT/Decisions/CCT-ADR-00NN <Title>.md` with provenance frontmatter:
   `status: accepted`, `repository: cin7core-feeder`, `verified: <today>`,
   `verified_against: <current full git HEAD>`, and `sources:` listing only files actually used to
   ground it (never `docs/PROJECT-NOTES.md` — it is retired). Record the human-approval evidence
   explicitly (who approved it, when, and — if available — the exact instruction), the same way
   existing ADRs distinguish original/historical approval from a later ratification.
5. **Update the index** — add the new ADR to the Accepted list in
   `ROOT/Decisions/Cin7 Core Toolbox Decisions.md`, and remove it from Deferred Decisions / Open
   Questions if it was listed there. Change nothing else in that file, and change no other note.
6. **Validate** — every wikilink resolves; only the new ADR and the index changed; the repository
   is untouched (this command edits Obsidian only).

## Hard boundaries

- **Never rewrite an already-accepted ADR** merely because the current implementation appears to
  violate it. If implementation and an accepted ADR disagree, that is architecture drift — report
  it, and if a human decides to change the decision, supersede the ADR through a new, explicitly
  approved decision rather than editing history.
- Never classify an ordinary bug, a current risk, or an unresolved choice as an accepted decision.
- Never copy secrets or credentials into the vault.
- Never modify repository files from this workflow — decisions are recorded in Obsidian only.
- Never create the next ADR "in advance" or speculatively — only when approval for that specific
  decision has actually been given in this conversation.
