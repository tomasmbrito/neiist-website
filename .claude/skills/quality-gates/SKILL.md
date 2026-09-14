---
name: quality-gates
description: The verification protocol for this repo — which checks to run before claiming work is done, what each catches, what it cannot catch, and the rules about never weakening a gate. Use before reporting completion, before committing, and before opening a PR.
allowed-tools: Bash(pnpm *), Bash(npx *), Bash(git *), Read
---

# Quality gates

Toolchain: **pnpm 12.3.4** on **Node 24.14.0** (`.nvmrc`). If `pnpm` fails to launch through
corepack, install it directly: `npm i -g --force pnpm@12.3.4`.

## The gates

```bash
pnpm next typegen   # regenerate route types first — next-env.d.ts is gitignored
pnpm type:check     # tsc --noEmit — zero errors
pnpm lint           # eslint       — zero errors
pnpm format:check   # prettier     — all formatted
pnpm build          # next build   — for anything non-trivial
```

Baseline: all four are **clean** on `main` as of the 2026-09-14 reset to upstream v3.0.0. So
any error you see is almost certainly yours. If you genuinely believe it is pre-existing,
prove it (`git stash && pnpm type:check`) before saying so.

**CI does not run `pnpm build`.** `.github/workflows/ci.yml` runs typegen, format, lint and
type-check only. A build break reaches `main` unnoticed unless you catch it — so run it.

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
   logging will fail lint.
6. **Do not use `git commit --no-verify`.** Husky runs `lint-staged` and commitlint; bypassing
   them just moves the failure to CI or to release-please.

## What the gates do not catch

This matters more than usual here, because **the repo has no tests at all** — no runner, no
test files, no test job. Green gates mean "it compiles and is formatted". They say nothing
about whether it *works*. In particular they cannot catch:

- wrong business logic, wrong totals, wrong discounts;
- missing authorization on a route — `tsc` compiles an open endpoint happily;
- SQL that is syntactically fine but semantically wrong, or a `$1` bound to the wrong column;
- **race conditions and torn multi-table writes — and this codebase has no transactions at
  all**, so every order, payment, stock decrement and discount redemption is exposed;
- schema drift: `docker/schema.sql` only runs on an empty database, so nothing here verifies
  that production's schema resembles it;
- missing translations — a string hardcoded in a component instead of `locales/{pt,en}.json`
  compiles and lints perfectly;
- React effect bugs, stale closures, and unmounted-component updates.

So for anything touching money, auth, or the database, gates are the floor, not the bar.
State explicitly what you exercised manually, and what you did **not** verify.

## Manual verification

```bash
pnpm dev     # boots docker postgres + next dev --turbopack  (needs port 5432 free)
```

Exercise the actual flow and say what you observed. For the risky areas:

- **Shop / checkout** — add to cart, apply a discount, check the total *arithmetically*,
  complete the flow, confirm the order row and stock decrement in the DB. Then ask what the
  data would look like if the process died between those two writes, because nothing prevents
  that.
- **Auth** — log in via Fenix; hit a protected route logged out; confirm the redirect returns
  you to the original URL.
- **Authorization** — the one that matters most: log in as a low-privilege user and request a
  higher-privilege resource *directly* (curl the API route, don't just check the UI hides the
  button). `src/proxy.ts` is an optimisation, not a boundary — the page's own `requireRoles()`
  is what must hold.
- **Both locales** — load the page at `/pt/…` and `/en/…`. A missing key is invisible to
  every gate.
- **Admin** — create, edit, delete; confirm the change persisted rather than trusting the toast.

## Reporting

```
Gates
  typegen       PASS
  type:check    PASS
  lint          PASS
  format:check  PASS
  build         PASS

Manually verified
  - <flow exercised> -> <what you observed>

Not verified
  - <what you could not check, and why>
```

The "Not verified" section is not optional and is not a weakness — it is the difference
between a report someone can trust and one they cannot.
