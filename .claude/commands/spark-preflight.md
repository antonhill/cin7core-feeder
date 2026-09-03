---
description: Combined repository + Spark Knowledge preflight before implementing material work. Read-only; inspect only, no code changes until the preflight is complete and reported.
argument-hint: <description of the proposed change>
---

Produce a combined **repository + knowledge preflight** for the proposed change below, BEFORE
writing any code. This extends `CLAUDE.md`'s mandatory preflight (worktree governance, freshness
against `origin/main`) with the Spark Knowledge layer. **Do not modify any code until this
preflight is complete and reported.** Do not modify any Obsidian note at all.

Proposed change: $ARGUMENTS

## Steps

1. **Confirm the working context is safe**, per `CLAUDE.md`'s own mandatory preflight:
   - you are in a task worktree, not the canonical `~/dev/cin7core-feeder` checkout, and not on
     `main` (`git branch --show-current`); if on `main` or the canonical checkout, stop and
     establish a task worktree first (see `CLAUDE.md` "Task worktrees");
   - `git status` is understood (clean, or the in-progress changes are yours and expected);
   - `git fetch origin`, then confirm this worktree's `HEAD` is not behind `origin/main`
     (`git log --oneline HEAD..origin/main` should be empty); if it is behind, say so rather than
     proceeding on a stale base;
   - `git worktree list` shows no ownership collision with another active stream.
2. **Identify the task scope** — the smallest coherent version of the change, and its domain.
3. **Run `/spark-context`** for this task and carry its brief forward (relevant architecture,
   applicable ADRs, feature/integration behaviour, current risks, unresolved matters, hard
   constraints).
4. **From that context, pin down what governs this change:**
   - applicable **accepted ADRs** and the exact constraint each imposes;
   - **module / role / billing / AAL2 boundaries** the change must respect (see
     `Architecture/Authorization Model.md`) — in particular, if this change is a new or
     materially different ordinary-member Cin7-writing action family, note that
     [[CCT-ADR-0015 Ordinary-member Cin7 writes use action-specific assurance]] requires it to
     carry its **own explicit classification**; it does not inherit another family's rule by
     analogy, and it is not automatically permitted without assurance merely because no rule
     names it yet;
   - **source-of-truth rules** — which system (Cin7 or the Toolbox) is authoritative for each
     fact the change touches (`Architecture/Source of Truth Boundaries.md`,
     `Integrations/Integration Map.md`);
   - **known current risks** in the area, and any **history** note whose rule this change must
     respect (`History/`).
5. **Inspect the actual current implementation** — search the relevant `src/` domain (`cin7/`,
   `sync/`, `import/`, `export/`, `reports/`, `audit/`, `lib/`, or the relevant `src/app/**`
   route) before concluding anything is missing. GitHub/code is authoritative for what the system
   *does*.
6. **Reconcile code vs knowledge.** If the current code and a `current`-status knowledge note
   disagree: **stop and name the conflict** — decide whether code changed without a knowledge
   write-back, or the note is stale. Do not silently pick one; surface it for a human. (A
   `historical` note describing an older state is not a conflict.)

## Output

```
SPARK PRE-FLIGHT — <change>

Working context: <worktree path · branch · not-canonical-checkout/not-on-main confirmed ·
 git status · HEAD vs origin/main>

Intended behaviour:
<what the change should do — the smallest coherent version>

Current implementation:
<what exists today, found by searching — file/function references>

Proposed change:
<the smallest coherent implementation path>

Affected source-of-truth boundaries:
<which authoritative system (Cin7 or the Toolbox) each touched fact belongs to, and that the
 change respects it>

Applicable ADRs / authorization boundaries / history rules:
<ADRs and the constraint each imposes; module/role/billing/AAL2 boundary; any history-note rule
 that applies — in particular, whether a new/changed Cin7-write family needs an explicit
 ADR-0015-style classification before it can be considered fully specified>

Known current risks in scope:
<from /spark-context> (or "none")

Code ↔ knowledge conflicts:
<none, or the specific conflict(s) to resolve with a human before proceeding>

Tests required:
<the focused tests this change needs>

Knowledge notes potentially affected (for /spark-close):
<the current feature/integration/architecture notes that may need a write-back if this ships>

Likely needs a human decision (not automatic ADR):
<yes/no — if yes, what the decision point is; never auto-create it>

Non-goals:
<what this change deliberately will NOT do>
```

## Boundaries

- Inspect only — no code changes until this preflight is reported and (where a conflict exists)
  resolved with a human.
- Never convert a candidate/open decision into an accepted one here — that requires
  `/record-decision` with explicit human approval, never this command.
- Never treat passing tests as live external verification; never treat UI visibility as
  authorization; never assume Obsidian overrides code; never treat `docs/PROJECT-NOTES.md` as
  current knowledge.
