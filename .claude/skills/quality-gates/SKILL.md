---
name: quality-gates
description: The verification protocol for this repo — which checks to run before claiming work is done, what each catches, what it cannot catch, and the rules about never weakening a gate. Use before reporting completion, before committing, and before opening a PR.
allowed-tools: Bash(yarn *), Bash(npx *), Bash(bash scripts/ai/*), Bash(git *), Read
---

# Quality gates

## The gates

```bash
yarn type:check     # tsc --noEmit — zero errors
yarn lint           # eslint       — zero errors
yarn format:check   # prettier     — all formatted
yarn build          # next build   — for anything non-trivial
bash scripts/ai/secret-scan.sh
```

Baseline: `type:check` and `lint` are **clean** on `main`. So any error you see is almost
certainly yours. If you genuinely believe it is pre-existing, prove it
(`git stash && yarn type:check`) before saying so.

`scripts/ai/validate-local.sh` runs all five in sequence.

## The rules

1. **A gate you did not run is a gate that failed.** Do not infer, predict, or assume. Run it.
2. **Paste the real output.** "Type check passes" without evidence is not a report.
3. **Never weaken a gate to make it pass.** Adding `any`, `@ts-expect-error`,
   `eslint-disable`, or deleting an assertion converts a visible failure into an invisible
   one. If you cannot fix the cause, stop and report the blocker — that is a successful
   outcome, not a failure.
4. **Never report work complete with a red gate.** Say FAIL, show the output, say what you
   tried. Scaling the work down is the human's call.
5. `console.log` is an **ESLint error** here (`warn`/`error` are allowed). Leftover debug
   logging will fail the build.

## What the gates do not catch

This matters more than usual here, because **the repo has no tests and no CI**. Green gates
mean "it compiles and is formatted". They say nothing about whether it *works*. In particular
they cannot catch:

- wrong business logic, wrong totals, wrong discounts;
- missing authorization on a route (`tsc` is happy to compile an open endpoint);
- SQL that is syntactically fine but semantically wrong, or a `$1` bound to the wrong column;
- race conditions and non-atomic multi-table writes;
- runtime failures in code paths that never execute at build time — notably anything under
  `src/lib/db/repositories/`, which **has zero call sites and has never run**;
- React effect bugs, stale closures, and unmounted-component updates.

So for anything touching money, auth, or the database, gates are the floor, not the bar.
State explicitly what you exercised manually, and what you did **not** verify.

## Manual verification

```bash
yarn dev     # boots docker postgres + next dev
```

Exercise the actual flow and say what you observed. For the risky areas:

- **Shop / checkout** — add to cart, apply a discount, check the total *arithmetically*,
  complete the flow, confirm the order row and stock decrement in the DB.
- **Auth** — log in via Fenix and via Google; hit a protected route logged out; confirm the
  redirect returns you to the original URL.
- **Authorization** — the one that matters most: log in as a low-privilege user and request a
  higher-privilege resource *directly* (curl the API route, don't just check the UI hides the
  button). Middleware is not sufficient here — several server pages fetch privileged data
  without their own role check.
- **Admin** — create, edit, delete; confirm the change persisted rather than trusting the toast.

## Reporting

```
Gates
  type:check    PASS
  lint          PASS
  format:check  PASS
  build         PASS
  secret-scan   PASS

Manually verified
  - <flow exercised> -> <what you observed>

Not verified
  - <what you could not check, and why>
```

The "Not verified" section is not optional and is not a weakness — it is the difference
between a report someone can trust and one they cannot.
