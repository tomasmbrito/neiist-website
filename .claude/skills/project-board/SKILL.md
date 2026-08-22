---
name: project-board
description: Create, update and query issues on the "Neiist website board" GitHub Project (tomasmbrito/projects/1). Use when tracking work as epics/user stories/tasks, moving items between columns, setting Priority or Size, or reconciling the board against the actual repo state. Contains the real project and field IDs.
allowed-tools: Bash(gh *), Bash(jq *), Read, Grep
---

# Project board

The Kanban board is a **GitHub Projects v2** board. Issues live in the fork
(`tomasmbrito/neiist-website`); the project is user-scoped.

## Identifiers (verified — use these, don't rediscover them)

```
Project number : 1
Owner          : tomasmbrito   (user-scoped, NOT the org)
Project ID     : PVT_kwHOBzxffs4BeUnd
Issue repo     : tomasmbrito/neiist-website
```

| Field | Field ID | Options |
|---|---|---|
| Status | `PVTSSF_lAHOBzxffs4BeUndzhYvuv0` | Backlog `f75ad846` · Ready `61e4505c` · In progress `47fc9ee4` · In review `df73e18b` · Done `98236657` |
| Priority | `PVTSSF_lAHOBzxffs4BeUndzhYvu4s` | P0 `79628723` · P1 `0a877460` · P2 `da944a9c` |
| Size | `PVTSSF_lAHOBzxffs4BeUndzhYvu4w` | XS `6c6483d2` · S `f784b110` · M `7515a9f1` · L `817d0097` · XL `db339eb2` |

If a command fails with "field not found", re-derive with
`gh project field-list 1 --owner tomasmbrito --format json` and update this file.

## Auth

`gh` is authenticated via keyring with the `project` scope. If a `gh project` command
fails with a scope error, an environment `GITHUB_TOKEN` is probably shadowing it — prefix
the command with `unset GITHUB_TOKEN &&`.

## Recipes

> **Use `--limit 300`, not 100.** The board passed 100 items in August 2026, and `item-list`
> silently truncates rather than warning — the newest issues are exactly the ones that vanish,
> so `item-edit` then reports "NOT ON BOARD" for an item that is on it.

### Read the whole board
```bash
gh project item-list 1 --owner tomasmbrito --limit 300 --format json \
  | jq -r '.items[] | "\(.status // "-")\t#\(.content.number // "-")\t\(.title)"'
```

### Create an issue and put it on the board
```bash
URL=$(gh issue create --repo tomasmbrito/neiist-website \
  --title "[US] Enforce order status transitions" \
  --body-file /tmp/body.md)          # --body-file avoids all shell-quoting problems
gh project item-add 1 --owner tomasmbrito --url "$URL"
```
Write the body to a file first. Bodies contain backticks, quotes and newlines; inlining
them into `--body` is how the existing issues #48–#52 ended up with literal `\n` in them.

### Set Status / Priority / Size
`item-edit` needs the **item ID** (`PVTI_…`), not the issue number:
```bash
ITEM=$(gh project item-list 1 --owner tomasmbrito --limit 300 --format json \
  | jq -r '.items[] | select(.content.number==42) | .id')

gh project item-edit --project-id PVT_kwHOBzxffs4BeUnd --id "$ITEM" \
  --field-id PVTSSF_lAHOBzxffs4BeUndzhYvuv0 --single-select-option-id 47fc9ee4   # In progress
gh project item-edit --project-id PVT_kwHOBzxffs4BeUnd --id "$ITEM" \
  --field-id PVTSSF_lAHOBzxffs4BeUndzhYvu4s --single-select-option-id 79628723   # P0
```

### Link a child to its parent epic
Projects v2 sub-issues are set through the GraphQL API, but the convention already used on
this board is simpler and works fine: put a line in the child's body —
`Part of https://github.com/tomasmbrito/neiist-website/issues/<epic>` — and list the children
in the epic body as a checklist.

## Conventions on this board

Titles carry their level as a prefix — keep it, the board depends on it for scanning:

| Prefix | Meaning | Body should contain |
|---|---|---|
| `[Epic]` | a theme spanning several stories | purpose, why it exists, expected outcome, children |
| `[US]` | one user-visible outcome | `Part of #<epic>`, context, tasks, acceptance criteria |
| `[Task]` | a single unit of work | usually a checklist item inside a US, not its own issue |

**Priority** — P0: security, money loss, data corruption, or production breakage.
P1: real user impact or a blocker for other work. P2: everything else.

**Size** — XS <1h · S ~half a day · M ~1–2 days · L ~a week · XL needs splitting.

## Writing a good issue body

Findings are worthless on the board if they are not actionable six weeks later. Include:

- **What is wrong** — with `file:line`, not a vague area.
- **Why it matters** — the concrete failure or attack, with inputs. "Two users checking out
  the last unit simultaneously both succeed" — not "possible race condition".
- **How to fix it** — the approach, enough that someone can start.
- **Acceptance criteria** — checkboxes that are objectively true or false.
- **Verification** — how to prove it, given that this repo has no tests.

Never paste a secret, token, or real customer data into an issue. Issues are cheap to create
and expensive to read — one precise issue beats five vague ones.

## Keeping the board honest

The board drifts from reality. When you touch it, check:
- Items marked **Done** whose code is not actually merged into `main`.
- Items describing work that is now obsolete or was superseded.
- Stories with no parent epic, or epics whose children are all closed but which stay open.
- Stale technical assumptions in bodies (e.g. issues #51/#52 say "Jest" while
  `docs/ai-workflow/decision-log.md` records the decision to use **Vitest**).

Report drift rather than silently "fixing" the board — the human may know why something is
where it is.
