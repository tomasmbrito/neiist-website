---
description: Run the full plan → implement → review → deliver pipeline for a task
argument-hint: "<what to build or fix>"
---

# /ship — full delivery pipeline

Task: **$ARGUMENTS**

Current state:

- Branch: !`git rev-parse --abbrev-ref HEAD`
- Uncommitted: !`git status --porcelain | wc -l` file(s)

You are the orchestrator. Run the pipeline below, delegating each stage to its agent. Do not
do the stages yourself — the separation is what makes the review meaningful.

## 1. Plan
Delegate to **planner** with the task above. It returns a path to a plan file.

**Show the human the plan and get approval before continuing.** This is a real stop, not a
formality. If the plan says a schema, auth, payment, or dependency change is needed, the human
must approve that specifically.

If the task is genuinely trivial (a typo, a one-line copy change), say so and skip to step 5
rather than ceremonially running six agents.

## 2. Implement
Delegate to **implementer**, passing the plan file path. For work that is primarily SQL,
schema, transactions, or data-layer, delegate to **data-layer-architect** instead.

## 3. Review — in parallel
Launch these together in one message, all read-only:

- **quality-reviewer** — correctness, house patterns, reuse, dead code
- **security-reviewer** — always, if the change touches API routes, auth, payments, uploads,
  or DB access; otherwise use judgement
- **test-engineer** — coverage assessment (note: this repo has no test runner, so expect a
  gap report rather than a pass/fail)

Pass each the plan path and the diff range.

## 4. Fix
Give the findings back to the **implementer** to resolve. Reviewers do not fix their own
findings.

Re-review if a Blocker or a Critical/High security finding was fixed. Loop at most twice — if
findings persist after two rounds, stop and bring the human in; something is wrong with the
approach, not the code.

## 5. Deliver
Delegate to **delivery**: gates → branch → Conventional Commit → PR on
`tomasmbrito/neiist-website` → board update.

Do **not** merge unless the human asks.

## Report back

```
Plan       <path>
Changed    <n> files
Reviews    quality: <verdict> | security: <verdict> | tests: <verdict>
Gates      type:check <r> | lint <r> | format <r> | build <r>
PR         <url>
Board      #<issue> -> In review
```

Then state plainly: what you verified, what you did **not** verify, and anything the human
needs to decide. If the pipeline stopped early, say where and why — a blocked report is more
useful than a smooth-sounding one that hides a failure.
