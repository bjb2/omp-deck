---
name: workflowz
description: "Use when a task benefits from parallel coverage or independent verification across multiple subagents — design reviews with a judge panel, security audits across dimensions, migrations with per-site transformation, research sweeps across modalities. Decompose before fanning out."
---

# Workflowz — multi-subagent orchestration

Use when the task benefits from decomposition + parallel coverage or adversarial cross-checking before commit. Audit, review, migration, research sweep, design with judge panel.

Don't reach for it on a quick lookup or single-file edit. The overhead exceeds the win below that threshold.

## The shapes

### Decompose → parallelize → verify

```
scout (inline, fast) → list of independent slices
fan out: one subagent per slice → each returns its own artifact
verify: per-slice confirmation (refute unless proven), or cross-slice synthesis
```

Use when the task divides cleanly and slices are independent.

### Judge panel

```
fan out N times: each subagent attempts the design with a different lens
judge: rank outputs, score against criteria, graft the best of rest into the winner
```

Use for design tasks where perspective diversity improves quality.

### Adversarial verify

```
fan out: N finders report findings
for each finding: 3–5 refuters, each prompted "refute if you can, default refuted when unsure"
keep: findings where majority of refuters failed to refute
```

Use for code review, security audit, fact-checking. Bias toward false negatives — a missed finding is recoverable, a false positive wastes reviewer time.

### Loop until dry

```
seen = []
while len(new_this_round) > 0:
  fan out: finders, each searching differently
  new = findings - seen
  seen |= new
  log: round N, |new|, |seen|
```

Use when the discovery space is unknown size and dedup matters.

### Pipeline (when stage B needs all of stage A)

```
stage A: fan out, gather all results
barrier
stage B: fan out over aggregated stage A output
```

Use when downstream stage genuinely needs upstream aggregate (dedup, merge, cross-comparison). Don't add barriers for things that can stream.

## Mechanics

- **Shared context in `local://` URIs**, not inline text. Subagents start blank.
- **`schema=` on agents whose output you branch on** — force structured output, validate, branch on the object.
- **Independent reads in parallel; dependent reads sequential.** Two unrelated reads: one `parallel()`. Read-then-write: serial.
- **Cap total fan-out at session task concurrency.** Going wider just queues.
- **Skip per-slice lint/test.** Run once at the end. Mid-flight validation blocks agents on each other's edits.
- **Log rounds.** `log("round 1: 12 findings, total seen: 12")` so reviewers can see coverage.
- **No silent caps.** If you bounded the search (top-N, sampling, no retry), say so explicitly.

## Anti-patterns

- One subagent doing the whole task. That's a delegate, not a workflow.
- Fan-out for trivial single-file edits.
- "Cover everything" with no verify stage. Single-pass audit = confidence theater.
- Verify agents that try to confirm rather than refute. Default `refuted=true` unless proven.
- Silent coverage truncation — reads as "covered everything" when it didn't.

## Pairing

- Code review → fan out by dimension, then adversarial verify per finding.
- Migration → discover sites inline, then per-site transform in parallel.
- Research → multi-modal sweep → deep-read hits → synthesize.
- Design → judge panel → synthesis.
