# Plan: entering the Notion migration — #127, #152, #124, #174, and the board

**Status: proposal.** Written after reading `notion-to-website-plan.md`, the current Notion
integration and the live `/activities` path.

---

## 0. The finding that reframes #127

#127 asks for "a read-only view of the Notion Events/Meetings data source". **Most of that
already exists**, and not knowing it would have produced a duplicate implementation:

- `neiist.activities` already mirrors the Notion source: `title`, `type`, `teams`, `attendees`,
  `location`, `start`/`end`, `last_edited_time`.
- `syncNotionEventsToDb` (`src/utils/eventsUtils.ts:116`) already pulls it and upserts.
- `/activities` already renders it, with the #118 guard so an unconfigured Notion cannot 500.
- **The public boundary is already enforced**, and enforced well: the sync filters
  `notionEvents.filter((e) => e.public)` and *deletes* any non-public event that was previously
  synced (`:170-172`). An internal meeting cannot reach the public page through this path.

So the acceptance criterion "public events render for anonymous visitors" is met today, and
"an event with `Public = false` never appears in the anonymous response" is met today.

**What genuinely does not exist is the other half:** internal events and meetings are not
visible to members *anywhere*, because the sync deletes them rather than storing them. That is
the real content of #127, and it is also the part that validates the Phase 1 model against real
data — which the issue says is the point.

### The one defect found in the existing path

`parseNotionPageToEvent` (`:79`) does `public: props.Public?.checkbox ?? true`.

`?? true` is **fail-open on a privacy boundary**. A Notion checkbox is present on every page
once the property exists, so this default is only reached when the property itself is absent —
i.e. if someone renames or deletes the `Public` property in Notion. At that moment *every event
in the workspace silently becomes public*, including internal meetings.

That is a small change with a large blast radius, so it is called out rather than slipped in.

---

## 1. #127 — internal events for members

### Constraint from the issue: no new tables, no schema change

That rules out storing internal events. They must be read from Notion per request and **cached**,
which the issue also requires ("do not add a second uncached third-party call on a page render").

### Design

```
src/utils/notion/internalEvents.ts
  getInternalNotionEvents()   cached, returns ONLY non-public events
```

- Cached with Next's `unstable_cache`, `revalidate: 300`, tagged so it can be invalidated.
  The page render never blocks on a live Notion call after the first miss.
- Returns `[]` — never throws — when Notion is unconfigured or failing, following #118. A
  third-party outage must not take `/activities` down.
- Reuses the existing `@notionhq/client` instance and `parseNotionPageToEvent`. No new
  dependency, no second parser to drift.

### Authorization

A new permission in the catalogue from #156, rather than an inline role array:

```
"activities.viewInternal": [_ADMIN, _COORDINATOR, _SHOP_MANAGER, _MEMBER]
```

`_GUEST` is absent, so an anonymous or external visitor cannot receive internal events. The
equivalence test in `permissions.test.ts` is updated in the same commit, deliberately, per the
practice that file exists to enforce.

**The check happens on the server, before the fetch.** Not "fetch then filter in the component"
— an internal event must never enter the anonymous response payload at all, which is the failure
mode the issue names.

### UI

A second section on `/activities`, rendered only when the permission holds: *"Eventos internos"*,
showing name, type, date, location, owning team. Same page, because the issue says "feeding the
existing `/activities` page" and a separate route would be another thing to find.

**Attendees are deliberately not rendered.** The Notion property holds workspace **email
addresses** (`parseNotionPageToEvent:76`). Displaying a list of members' emails is a PII
decision, not a display detail, and it is not needed to validate the data model.

### Fail-closed default

`?? true` → `?? false`, with a warning logged when the property is missing, so a renamed Notion
property produces "no public events, and a loud log line" instead of publishing everything.

---

## 2. #152 — make it one command instead of a chore

I cannot run this: it needs production credentials, which I must not have. What I *can* do is
remove every excuse not to run it.

`scripts/schema-diff.mts`:

1. Starts a throwaway `postgres:15` container.
2. Builds a reference database from `docker/schema.sql`.
3. `pg_dump --schema-only` both it and the target.
4. Normalises both dumps and prints a unified diff.

```bash
yarn db:schema-diff "postgresql://…"      # target read-only; never written to
```

The script must be **read-only against the target** and say so loudly. That is the whole risk
surface.

---

## 3. #174 — the order deadline

Recommendation: **enforce the deadline for every stock type**, not only `on_demand`.

The counter-argument is "limited stock is already bounded by stock". It does not hold: stock is
replenishable and the deadline is a separate promise about *when the núcleo will place the
production order*. The field is per-product and shown to students, so a limited-stock sweat
advertising "encomenda até 20/08" accepting orders on 21/08 is a commitment the núcleo then has
to honour or refund.

`p_stock_override` continues to bypass it, so POS sales are unaffected — that is correct and
stays.

---

## 4. #124 — identity, recommendation rather than an open question

Two decisions, both now more pressing because #126 makes members assignees and approvers:

1. **Account linking on a verified alternative email.** Recommend: link only on an email that
   has been *verified* through the existing `email_token` flow, and never automatically —
   present it as "this address belongs to an existing account, sign in with Fenix to link".
   Auto-linking on an unverified address is account takeover.
2. **Which Técnico domains must use Fenix.** Recommend: reject the whole
   `*.tecnico.ulisboa.pt` suffix on the Google path, not just the exact `@tecnico.ulisboa.pt`,
   because subdomain addresses are still Técnico identities and should not create a second,
   parallel account.

Both are cheap to state and expensive to get wrong later, once ten tables reference members.

---

## 5. The board

39 backlog items obscure what is actually in flight. **18 of them are the original product
roadmap** (job board, QR ticketing, i18n, pagination, search, dashboard), created on one day and
never started.

Proposal: **remove those from the board, keep the issues open.** `gh project item-delete` detaches
an item without touching the issue, so nothing is lost — they stay searchable in the repo and are
listed by number in `project-status.md`. The board then shows the Notion epic plus real remaining
work, which is what a board is for.

Not proposed: closing them. They are legitimate future work, and closing would be a lie.

---

## 6. Order of work

1. #127 — the visible one, and it validates the Phase 1 model.
2. `schema-diff` tooling for #152 — unblocks the human task.
3. #174 — small, decided above.
4. Board cleanup + docs.
5. #124 recorded as a decision.

## 7. What this plan does NOT do

- **No new tables.** Phase 0 (#128) is where the schema starts, and it should not start before
  #152 is answered.
- **No writes to Notion.** Read-only, per #127.
- **No Tier C content migration** (long-form prose stays in Notion/Drive, per plan §5.1).
