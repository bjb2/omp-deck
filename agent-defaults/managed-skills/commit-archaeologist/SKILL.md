---
name: commit-archaeologist
description: "Use when investigating git history to answer \"when did X land\", \"who wrote Y\", \"why did Z change\", or to find the commit that introduced a bug. Pairs with bug investigation, refactor planning, and dead-code discovery."
---

# Commit Archaeologist

Use when git history is the answer: bug origins, authorship, regressions, when something changed, why it was refactored. Pair with bug investigation, refactor planning, and dead-code discovery.

## Triggers

- "When did this bug first appear?"
- "Who wrote this function?"
- "Find the commit that broke X"
- "What did this code look like N months ago?"
- "Why was this refactored?"

## Workflow

1. **Locate the symbol.** `lsp definition` or `grep` for the file/line.
2. **Blame the symbol.** `git log -L :symbol:path` shows every commit that touched that exact block — far more precise than `git blame` (per-line).
3. **Bisect when blame is noisy.** `git bisect start` + `git bisect run <test>` to binary-search the breaking commit, especially when the file has churned.
4. **Trace a regression.** `git log --oneline -- path` for file history; `git log -S "<string>"` (pickaxe) for when a literal was added/removed; `--diff-filter=D` for deletions.
5. **Map authorship.** `git shortlog -sn -- path` ranks authors by commit count for an area.

## Commands

```
git log -L :<symbol>:<file>          # history of one symbol/block
git log -S "<string>" --oneline      # pickaxe: commits touching a literal
git log --follow -- <path>           # follow renames
git log --since="6mo" --oneline -- <path>   # recent churn
git bisect start; git bisect bad; git bisect good <sha>; git bisect run <cmd>
git log --diff-filter=D --name-only  # when was a file deleted
git shortlog -sn -- <path>           # ownership map
```

## Pairing

- Bug found → run commit-archaeologist on the offending symbol to find the landing commit and its author/message.
- Dead code → find symbols with no callers, then blame to confirm always-dead vs. recently orphaned.
- Refactor → map recent churn (`git log --since="6mo"`) before deciding what's worth cleaning up.
