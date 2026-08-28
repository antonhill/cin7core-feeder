# Corefeeder — development governance

**Read this section before making any change. It governs *where* and *how* work happens.
The project-specific instructions imported at the bottom of this file govern *what* the code
must do — nothing here weakens, overrides, or replaces them.**

## Parallel-development principles

1. **Never develop directly on `main`.** All implementation happens on a feature/fix branch in
   its own worktree.
2. **One independent Claude session = one named worktree = one feature/fix branch.** Do not
   share a stream.
3. **Never allow two independent Claude sessions to write to the same worktree.** If ownership
   of a worktree is unclear, treat it as owned by someone else.
4. **Never switch branches in another active worktree.** Create your own instead.
5. **No `reset`, `restore`, forced checkout, force push, or other destructive Git operations
   without explicit approval.** This includes `git checkout -f`, `git clean -fd`,
   `git push --force`, `git branch -D`, and discarding uncommitted work of any kind.
6. **Always fetch `origin` and verify freshness against `origin/main` before implementation.**
   See the mandatory preflight below.
7. **If the worktree is stale, dirty, ambiguous, or overlaps another active stream, stop and
   report before coding.** Do not "just clean it up" and continue.
8. **Commit stable checkpoints early.** Small, reviewable commits beat one large final commit.
9. **Keep each worktree scoped to its assigned feature/fix.** Unrelated work belongs in its own
   stream.
10. **Surface cross-cutting changes before expanding scope** — anything touching auth, security,
    database structure, architecture, shared infrastructure, or APIs. Report first, then proceed
    on direction.
11. **Database/schema migrations must have a single stream owner.** Two streams adding
    migrations concurrently will collide on numbering and on function rebuilds. Confirm
    ownership before writing a migration.
12. **Finish through PR review, not direct merge into `main`.**

## Checkout roles

`/Users/antonhill/cin7core-feeder` is the **main/admin checkout only**.

**Permitted there:**

```
fetch
review
PR/merge administration
worktree creation
worktree cleanup
read-only investigation
```

**Not permitted there:**

```
feature implementation
bug-fix implementation
experimental coding
```

## Mandatory preflight

Run this in full before any implementation work, and act on what it reports:

```bash
R=/Users/antonhill/cin7core-feeder

git -C "$R" fetch origin
git -C "$R" status
git -C "$R" branch --show-current
git -C "$R" rev-parse HEAD
git -C "$R" rev-parse origin/main
git -C "$R" log --oneline HEAD..origin/main
git -C "$R" worktree list
```

Then verify the feature worktree you have been assigned. For the current feature worktree
`/Users/antonhill/Toolbox New Feature Tree`:

```bash
W="/Users/antonhill/Toolbox New Feature Tree"

git -C "$W" status
git -C "$W" branch --show-current
git -C "$W" rev-parse HEAD
git -C "$W" rev-parse origin/main
```

A worktree whose `HEAD` is behind `origin/main`, or whose status is not clean, is **not ready** —
stop and report (principle 7).

## Branch naming

```
feature/<specific-feature>
fix/<specific-fix>
investigation/<topic>
security/<topic>
```

Names must be specific to the work. **`feature/new-features` must not become a permanent
catch-all** — it is a generic name, and unrelated substantial features accumulating on it defeat
principles 2 and 9. When unrelated substantial work emerges, give it its own named branch and
its own worktree rather than adding it to an existing general-purpose stream.

## Completion requirements

Before reporting work complete, all of the following must hold:

```
relevant tests pass
build/type/lint checks pass where applicable
git diff --check passes
full diff reviewed against origin/main
no unrelated changes
all intended work committed
working tree clean
stop at PR-ready
```

Note that this project's own standing rules add a requirement these generic checks do not
cover: a `"use server"` file must be verified with a real production request, because
`next build` passing does **not** prove it loads at runtime. See the standing rules in the
imported project notes.

## Final report

Every completed piece of work must report:

```
branch
worktree
starting SHA
final SHA
files changed
diff summary
confirmation docs-only (where applicable)
confirmation main untouched
PR readiness
```

**Do not merge directly into `main`. Stop at PR-ready.**

---

# Project-specific instructions

@AGENTS.md
@docs/PROJECT-NOTES.md
