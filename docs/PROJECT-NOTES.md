# Project notes — retired

**This file is no longer the current product/architecture knowledge source for this repository.**
It served that purpose from the project's origin through 2026-09-03, when its content was fully
migrated into a verified, independently-checked institutional knowledge base. Do not read it, or
any of its git history, as current instructions or current product knowledge.

## Where things live now

- **GitHub / code is implementation truth** — what the software actually does. When this file and
  the code disagree, the code wins.
- **Spark Knowledge (Obsidian) is institutional/product truth** — why the product is built the way
  it is, its architecture, its accepted decisions, and its history.

**Entry points into Spark Knowledge:**

| Kind | Note |
|---|---|
| Product map | `02 Products/Cin7 Core Toolbox/Cin7 Core Toolbox.md` |
| Current, verified product state | `Cin7 Core Toolbox Current State.md` |
| Durable rules across every feature | `Cin7 Core Toolbox Global Principles.md` |
| Accepted decisions (ADRs) | `Decisions/` — indexed in `Decisions/Cin7 Core Toolbox Decisions.md` |
| Why current controls exist | `History/` |
| Architecture, features, external integrations | `Architecture/`, `Features/`, `Integrations/` |
| Unresolved matters | `Open Questions.md`, and the Deferred Decisions section of the Decisions index |
| Terminology | `Glossary.md` |

`CLAUDE.md`'s own "Spark Knowledge" section explains how to load this selectively, and the
`/spark-context`, `/spark-preflight`, `/record-decision` and `/spark-close` commands do it in
practice. Everything this file used to hold — what shipped, why, the four security re-audit
rounds, every "gotcha," every scoped-but-unbuilt idea — was independently re-verified against
current code, live database state, and CI evidence before being migrated; nothing here was copied
across unread.

**Do not append new product memory to this file.** It is retired, not paused. A new standing
repository rule belongs in `CLAUDE.md` or `AGENTS.md`; a new piece of product knowledge belongs in
Spark Knowledge, written the same way the rest of it was — from current evidence, not from this
file.

The full prior content of this file remains available in git history, for anyone tracing exactly
when and why a piece of institutional memory moved.
