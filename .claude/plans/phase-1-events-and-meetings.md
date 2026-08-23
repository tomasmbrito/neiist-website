# Plan: Phase 1 — Events and meetings (#129)

## Goal

Give every team a place in `/workspace/[team]` where it creates, edits, lists and cancels its own
events and meetings, stored in Postgres and owned by the website — replacing the "As páginas do
Notion serão migradas para aqui" placeholder at `src/app/workspace/[team]/page.tsx:104-109`.
Access is decided by the access model that already exists (`canForTeam`, `requireTeamWorkspace`),
never by a new bespoke check. When the first slice is done, the Organização de Eventos coordinator
can plan an event on the site, a Visuais member cannot see it, and an anonymous request cannot
reach a non-public row **because the app role has no way to read the table except through
functions that either take a department or filter `is_public`**.

`/activities` and Google Calendar are deliberately *not* in the first slice. See §Slicing.

## Context

Everything below was read, not assumed.

### The access model is built — use it, do not extend it

- `src/lib/auth/permissions.ts`
  - `TEAM_PERMISSION_ROLES` (line 205) + `canForTeam(globalRoles, teamScopes, permission, departmentName)`
    (line 279). Separate type from `Permission` on purpose: a team question must not compile
    against the global `can()`.
  - `TeamAccess = { departmentName, access, source }` (line 239). `source` is **required**.
  - `GRANTABLE_TEAM_PERMISSIONS` (line 253) is a **default-deny allowlist**. A new team permission
    is *not* satisfiable by a temporary grant unless it is added there on purpose.
  - `ORGANISATION_WIDE = [_ADMIN]` short-circuits `canForTeam` before it looks at the department.
  - Department comparison is **exact** (line 297-303) — `neiist.departments.name` is a
    case-sensitive `VARCHAR(30)` primary key. Do not normalise anywhere.
- `src/utils/permissionUtils.ts`
  - `getWorkspaceSession()` (line 126) → `{ user, roles, scopes }`, used by routes.
  - `requireNeiistMember()` (line 159) — the layout guard.
  - `requireTeamWorkspace(departmentName, permission)` (line 174) — the per-page guard. **Every new
    page under `/workspace/[team]/...` must call it itself**: the layout cannot tell Visuais from
    Dev-Team, and layouts do not re-run on client navigation.
- `src/proxy.ts:27` — `workspaceRoutes = ["/workspace"]` already claims the whole prefix, so no
  proxy change is needed for a nested page. `/api/workspace/...` is covered by the generic
  `/api/` branch at line 150.
- `neiist.get_user_team_scopes` (`docker/migrations/010_team_access_grants.sql:399`) returns
  memberships UNION live grants, with `source`. Every guard therefore honours grants automatically.

### Teams are keyed by name, not by id — the issue's `owner_team_id` does not exist

`docker/schema.sql:94-119`:

```
neiist.departments (name VARCHAR(30) PRIMARY KEY, active, department_type CHECK IN ('team','admin_body'))
neiist.teams       (name VARCHAR(30) PRIMARY KEY REFERENCES departments(name), description)
neiist.admin_bodies(name VARCHAR(30) PRIMARY KEY REFERENCES departments(name))
neiist.membership  (user_istid, department_name, role_name, from_date, to_date)
neiist.users       (istid VARCHAR(50) PRIMARY KEY, ...)
```

There is **no `teams.id`**. Reconciliation, decided here:

- The column is `owner_department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name)`,
  **not** `teams(name)`. Referencing `departments` is what lets Direção and the Mesa da Assembleia
  Geral own meetings — they are `admin_body` rows, they are not in `neiist.teams`, and "Coord x Dir"
  is one of the busiest meeting sources in the Notion workspace.
- It is also exactly the value `canForTeam` compares against, so the authorization key and the
  storage key are the same string. Authorizing on one value and writing another is how #180 happened.
- Free property, worth stating: `create_team_access_grant` refuses non-`team` departments
  (010:150-153), so **no temporary grant can ever reach Direção's meetings.**
- Seeded department names (`docker/init.sql`): `Controlo & Qualidade`, `Contacto`, `Dev-Team`,
  `Divulgação`, `Fotografia`, `Organização de Eventos`, `Visuais`, `Direção`,
  `Mesa da Assembleia Geral`, `Conselho Fiscal`. Note `Controlo & Qualidade` here vs
  `Controlo e Qualidade` in Notion — a data-import problem for Phase 10, not for this issue.

### The data layer and its hazards

- `src/utils/db/*` is the data layer; `dbUtils.ts` is gone. `db_query` and `withTransaction` live
  in `dbClient.ts`.
- `neiist_app_user` **has no table privileges** (`schema.sql:11-16`) and only `EXECUTE` on
  functions. Every new function must be `SECURITY DEFINER` with an explicit
  `GRANT EXECUTE ... TO neiist_app_user`. This is also the property the `is_public` boundary rests on.
- `::VARCHAR(50)` for istid, `::VARCHAR(30)` for department names at every call site. A
  `::VARCHAR(10)` cast silently truncates.
- Most query functions still `catch { return null }`. Inside a transaction that silently discards
  writes; `withTransaction` throws on the `ROLLBACK` command tag as a backstop (`dbClient.ts:139`).
- Model to copy for a write function that must report *why* it refused:
  `createTeamAccessGrant` (`userQueries.ts:670`) — no try/catch, errors propagate, `errorMapper`
  turns the SQLSTATE into a domain error.
- Model to copy for the route: `src/app/api/workspace/grants/route.ts` — Zod parse,
  `getWorkspaceSession`, `canForTeam`, `throwIf…DbError` then `handleApiError`.

### Migrations and SQLSTATEs

- `docker/migrations/` is at **010** on `main`; **011 is claimed by open PR #195**. Take the next
  free number at branch time — this plan assumes **012**.
- Four rules (CLAUDE.md §4a): edit `schema.sql` *and* write the migration; idempotent
  (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`); backward-compatible with the
  previous release; never edit an applied migration.
- Custom SQLSTATEs **NEI01–NEI12 are in `main`, NEI13 is taken by PR #195**. This work takes
  **NEI14** and **NEI15**. Every code added must be mapped in `errorMapper.ts` in the same PR, or
  `apiErrorHandler` echoes the raw `RAISE` text with a 500.
- `schema.sql` placement: append the new section at the **end of the file**. Upstream has inserted
  `voting_sessions`/`voting_nominees`/`votes`/`voting_results` immediately after
  `activities_sign_up`, so putting new tables there guarantees a conflict on the next sync wave.

### What already exists around events, and must not be disturbed

- `neiist.activities` (`schema.sql:153`) is the **public** calendar, filled by the Notion sync.
  `syncNotionEventsToDb` *deletes* rows whose Notion `Public` checkbox is cleared
  (`eventsUtils.ts:170-172`). Anything written into that table by us gets destroyed by the next
  sync. **Do not write to `neiist.activities`.**
- `src/utils/notion/internalEvents.ts` (#127) reads internal Notion events read-only through
  `unstable_cache`, and `/activities` renders them behind `can(roles, "activities.viewInternal")`
  (`src/app/activities/page.tsx:60`). The decision log says this module is expected to be deleted
  in Phase 1 — that deletion belongs to **slice C**, not slice A.
- `src/utils/db/eventQueries.ts` owns the `neiist.activities` calendar. Internal events get a
  **new sixth module**, `src/utils/db/internalEventQueries.ts`. Mixing them would put a function
  with no `is_public` filter one screen away from functions a public page calls, which is precisely
  the confusion this plan is trying to make structurally impossible.
- `src/utils/googleCalendar.ts` exists and is Notion-shaped (`buildICalDatesFromNotion`,
  `syncEventToCalendar(event: NotionEvent, ...)`). Slice D will need an adapter; slice A must not
  touch it.

## Approach

**Smallest change that fully solves the first vertical slice**, built on three decisions:

1. **The multi-table write is one plpgsql function, not a `withTransaction` block.**
   `neiist.create_internal_event(...)` takes `TEXT[]` locations and `VARCHAR[]` attendees and does
   all three INSERTs itself. A single function call from the pool is a single implicit transaction,
   so it is atomic by construction — and it never touches the ~58 query functions that
   `catch { return null }`, which is the failure mode `withTransaction` has to defend against.
   It is also the house pattern (`new_order`, `create_team_access_grant`).
   *Rejected:* `withTransaction(async (q) => { … })` threading three TS query functions. It works,
   but it needs three new functions that must be written to throw, and it puts the atomicity
   guarantee in application code for a write that never leaves the database.

2. **Authorization stays in TypeScript (`canForTeam`); SQL enforces data invariants plus a coarse
   backstop.** #184 put its rules in SQL because those rules are about *creating authority*. Events
   are ordinary content, and the precise rule depends on `GRANTABLE_TEAM_PERMISSIONS`, which is a
   TypeScript artefact — an SQL copy would be the same policy written twice, free to drift, which
   is the shape of #97/#117/#180. So SQL checks only what cannot drift: **the actor has *some* live
   scope in the owning department, or is organisation-wide `admin`.** That is strictly weaker than
   the TS check, needs no knowledge of the allowlist, and means a route that forgets its guard
   still cannot let a Visuais member create Dev-Team events.
   *Rejected:* full policy in SQL (drift), and no SQL check at all (a forgotten route guard becomes
   a cross-team write).

3. **The `is_public` boundary is enforced in SQL, by function inventory, and pinned by an
   introspection test.** See §The `is_public` boundary.

### Slicing — four PRs, and the first one precisely

| Slice | Contents | Touches |
|---|---|---|
| **A — foundation + team events in the workspace** (this plan's Steps) | tables `internal_events`, `event_locations`, `event_attendees`; create/update/cancel/list SQL; new team permissions; one API route; the team page section + a `/workspace/[team]/events` page with a create/edit form | migration, schema.sql, permissions.ts, new query module, one route, two pages/components, tests |
| **B — meeting detail: agenda, attendance, documents, related events** | `event_documents`, `event_relations`, `event_attendees.response` writes, per-event detail page | new migration, no change to A's boundary |
| **C — `is_public` drives `/activities`** | `get_public_internal_events`, `/activities` reads it, retire `src/utils/notion/internalEvents.ts` and decide the fate of the Notion→`activities` sync | `/activities`, eventsUtils, Notion |
| **D — push to Google Calendar** | `google_event_id`/`synced_at` columns, an adapter for `googleCalendar.ts`, push **after** commit, public → public calendar, internal → team calendar | googleCalendar.ts, deploy secrets |

**The first PR is slice A**, exactly as scoped in §Steps. It is visible in the workspace on day one,
touches neither `/activities` nor Google Calendar, and carries the whole security surface
(`is_public` storage, team scoping, atomicity) so those get reviewed once, early, on a small diff.

`event_sponsors` is **not in any slice here**: the issue itself says the FK target
`neiist.businesses` arrives in Phase 5 (#138). Building a table whose only column of interest is a
nullable FK to a table that does not exist is not worth a migration now.

### What slice A must NOT do, to keep C and D possible

- **Must not write to, read from, or alter `neiist.activities`.** The two tables stay separate until
  slice C decides how the public calendar is composed. The Notion sync deletes rows it does not
  recognise.
- **Must not delete or modify `src/utils/notion/internalEvents.ts`, `eventsUtils.ts`, or
  `/activities`.** They keep working unchanged; slice C retires them deliberately.
- **Must not call Google Calendar, or add sync columns.** Slice D owns `google_event_id`/`synced_at`
  and the reconciliation semantics; adding the columns speculatively now means designing them twice.
- **Must not put `is_public` behind a nullable/defaulted column that reads as public.** `is_public`
  is `BOOLEAN NOT NULL DEFAULT FALSE`. The #127 decision ("`Public` fails closed") applies here too.
- **Must not add a function that returns internal-event rows without either a department parameter
  or `WHERE is_public`.** Slice C adds the one public reader, on purpose, with tests.

## Schema (human approval required)

`docker/migrations/012_internal_events.sql` + the same DDL appended to `docker/schema.sql`.

```sql
CREATE TABLE IF NOT EXISTS neiist.internal_events (
  id                     SERIAL PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('event','meeting')),
  name                   TEXT NOT NULL CHECK (btrim(name) <> ''),
  description            TEXT,
  starts_at              TIMESTAMPTZ NOT NULL,
  ends_at                TIMESTAMPTZ,
  all_day                BOOLEAN NOT NULL DEFAULT FALSE,
  is_public              BOOLEAN NOT NULL DEFAULT FALSE,
  owner_department_name  VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),
  created_by             VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at           TIMESTAMPTZ,
  cancelled_by           VARCHAR(50) REFERENCES neiist.users(istid),
  CONSTRAINT internal_events_end_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT internal_events_cancellation_complete CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL) OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS neiist.event_locations (
  event_id INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  location TEXT NOT NULL CHECK (btrim(location) <> ''),
  PRIMARY KEY (event_id, location)
);

CREATE TABLE IF NOT EXISTS neiist.event_attendees (
  event_id   INT NOT NULL REFERENCES neiist.internal_events(id) ON DELETE CASCADE,
  user_istid VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  response   TEXT NOT NULL DEFAULT 'invited'
             CHECK (response IN ('invited','accepted','declined','attended','absent')),
  PRIMARY KEY (event_id, user_istid)
);

CREATE INDEX IF NOT EXISTS idx_internal_events_owner_start
  ON neiist.internal_events (owner_department_name, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_events_public
  ON neiist.internal_events (starts_at) WHERE is_public AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_attendees_user ON neiist.event_attendees (user_istid);
```

Choices, argued:

- **`kind` and `response` are CHECK-constrained TEXT, not enums.** `ALTER TYPE … ADD VALUE` is
  awkward inside a migration transaction and cannot be used in the same transaction that adds it;
  a CHECK is replaceable idempotently. The repo already does this for
  `departments.department_type` and `discount_codes.discount_type`.
- **`location` is free text with a non-blank CHECK, not an enum of the five Notion values.** Rooms
  and campuses change; a CHECK list means a migration to book V1.32's neighbour. The five known
  values are offered as suggestions in TypeScript (`src/types/internalEvents.ts`) and rendered as a
  `<datalist>`, so the data stays tidy without the schema having an opinion.
- **Cancellation is soft.** Tasks (#130) and requerimentos (#131) will reference events; a hard
  delete would either cascade their history away or be blocked by an FK. There is no delete path.
- **No `owner_team_id`.** See §Context.

### SQL functions (all `SECURITY DEFINER`, all `GRANT EXECUTE … TO neiist_app_user`)

| Function | Notes |
|---|---|
| `neiist.assert_actor_may_touch_department(a_istid VARCHAR(50), a_department VARCHAR(30))` | Internal helper. Raises **NEI14** unless the actor has a live scope in that department (the `get_user_team_scopes` rule) or holds `access='admin'` by membership. The coarse backstop from decision 2. |
| `neiist.create_internal_event(e_actor, e_department, e_kind, e_name, e_description, e_starts_at, e_ends_at, e_all_day, e_is_public, e_locations TEXT[], e_attendees VARCHAR[]) RETURNS INT` | Backstop, then INSERT event + `unnest`-INSERT locations (trimmed, `DISTINCT`) + attendees. Raises **NEI15** with the offending istid when an attendee is not a `neiist.users` row, rather than surfacing a raw FK violation. Atomic: one function call, one implicit transaction. |
| `neiist.update_internal_event(e_actor, e_id, e_department, …same…)` | `WHERE id = e_id AND owner_department_name = e_department`; zero rows → **NEI01**. Replaces locations and attendees wholesale (DELETE + re-INSERT) inside the same call. Sets `updated_at = NOW()`. **Does not allow the owning department to change** — a move would be an authorization change and belongs to its own function if it is ever wanted. |
| `neiist.cancel_internal_event(e_actor, e_id, e_department)` | Idempotent: already cancelled → return. |
| `neiist.get_team_internal_events(e_department VARCHAR(30), e_from TIMESTAMPTZ, e_to TIMESTAMPTZ)` | Rows for **one** department. Returns locations and attendees as aggregates so the page is one round-trip. There is no "all departments" variant. |
| `neiist.get_internal_event(e_id INT, e_department VARCHAR(30))` | Department is a **required** argument and part of the WHERE. A caller therefore cannot fetch by id alone, which means it cannot fetch before it knows — and has authorized — the department. |

## The `is_public` boundary — where it is enforced, and why it is hard to get wrong later

Enforced in **SQL**, structurally, in three layers:

1. **The app role cannot read the tables at all.** `neiist_app_user` holds no table privileges
   (`schema.sql:11-16`); every read goes through a `SECURITY DEFINER` function we wrote. There is no
   `SELECT * FROM neiist.internal_events` available to application code, so "someone forgets the
   filter in an ad-hoc query" is not a reachable state.
2. **No function reachable by an anonymous path can return a private row.** In slice A *every*
   reader takes a `department` argument, and a department argument is useless to an anonymous
   caller: `canForTeam` refuses it before the route calls the function. In slice C exactly one
   function is added without a department — `get_public_internal_events` — and it hardcodes
   `WHERE is_public AND cancelled_at IS NULL`.
3. **A pg_proc introspection test pins rule 2 forever.** New file
   `src/utils/db/internalEventsBoundary.test.ts`:
   - assert `has_table_privilege('neiist_app_user', 'neiist.internal_events', 'SELECT')` is false
     (and the same for INSERT/UPDATE/DELETE, and for the two child tables);
   - enumerate `pg_proc` in schema `neiist` whose `pg_get_functiondef` mentions `internal_events`,
     and assert each one **either** declares a `VARCHAR(30)`/department parameter **or** contains
     `is_public` in its body. A future function that returns internal rows to nobody in particular
     fails `yarn test` in the PR that adds it.

Not enforced in the route, and not enforced in the query function: both are the layers most likely
to be copy-pasted by the next feature. The route still *authorizes* (`canForTeam`), but disclosure
does not depend on it remembering to.

## Atomicity — which functions must let errors throw

- The whole event + locations + attendees write happens **inside one plpgsql function**, so the
  database provides atomicity. Nothing in slice A opens a `withTransaction`.
- In `src/utils/db/internalEventQueries.ts`, **`createInternalEvent`, `updateInternalEvent` and
  `cancelInternalEvent` must have no `try/catch`** — same rule and same reason as
  `createTeamAccessGrant` (`userQueries.ts:670-688`): the SQLSTATE is how the refusal reaches the
  user, and `catch { return null }` turns "NEI15: attendee ist1234 does not exist" into a 500 with
  no message. The read functions may return `[]` on failure, since nothing depends on their errors.
- All three write wrappers take an **optional trailing `q: Querier = db_query`**, matching
  `dbClient.ts`'s convention, so Phase 3 can compose "create event + N requerimentos" in one
  `withTransaction` without rewriting them. They already throw, which is the precondition for that.
- **No Google Calendar, email or SumUp call may ever appear inside these functions or inside a
  future `withTransaction` around them.** In slice D the push happens *after* the write returns,
  and a failed push must leave the event committed.

## New permissions (human approval required — auth change)

Added to `TEAM_PERMISSION_ROLES` in `src/lib/auth/permissions.ts`. Nothing is added to the global
`PERMISSION_ROLES`: "may I manage Dev-Team's events" is not answerable globally, and making it so
would be #180 again.

| Permission | Roles | Grantable? |
|---|---|---|
| `team.events.manage` — create, edit and cancel a team's events and meetings | `[_ADMIN, _COORDINATOR]` | **Yes** — add to `GRANTABLE_TEAM_PERMISSIONS`. #184's stated use case is the board lending Dev-Team access so it can help a team with its workspace; internal event edits are reversible and confined to that team. `team.content.edit` is already grantable, so refusing here would be an inconsistency without a corresponding risk. |
| `team.events.publish` — set `is_public = true`, i.e. put the team's event on the public site and (slice D) the public Google Calendar | `[_ADMIN, _COORDINATOR]` | **No** — deliberately omitted from `GRANTABLE_TEAM_PERMISSIONS`. Same role list, different reach: publishing speaks to the public in NEIIST's name, and a temporary outsider must not be able to do it. This is exactly the case the default-deny allowlist exists for, and it is the reason to split the two rather than reuse `team.content.edit` for both. |

Reading a team's events reuses **`team.workspace.view`** — no new permission. Being in the team is
the whole requirement, which is what that permission already says.

Assumption recorded: **plain members cannot create meetings** in slice A. Notion has no such
distinction and it is plausible the núcleo wants members to be able to schedule their own team's
meetings. Narrower is the safe default and widening it later is a one-line change to
`TEAM_PERMISSION_ROLES`. Worth asking the product owner in the same round-trip as the approvals.

## Steps (slice A)

1. [ ] `docker/migrations/012_internal_events.sql` — the three tables, three indexes, six functions
       and their `GRANT EXECUTE`s, exactly as in §Schema. Idempotent throughout
       (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`).
       Confirm 012 is still free — 011 belongs to open PR #195.
2. [ ] `docker/schema.sql` — append the identical DDL in a new `-- INTERNAL EVENTS (#129)` section
       **at the end of the file**, not next to `neiist.activities` (upstream's voting tables sit
       there and will conflict).
3. [ ] `src/utils/db/errorMapper.ts` — add `EVENT_SQLSTATE = { NOT_IN_TEAM: "NEI14", UNKNOWN_ATTENDEE: "NEI15" }`
       and `throwIfEventDbError(error)`: NEI14 → `ForbiddenError`, NEI15 → `ValidationError`,
       NEI01 → `NotFoundError` ("Evento não encontrado."). Mapping in the same PR is mandatory —
       an unmapped code reaches the client as raw `RAISE` text with a 500.
4. [ ] `src/lib/auth/permissions.ts` — add `team.events.manage` and `team.events.publish` to
       `TEAM_PERMISSION_ROLES`; add **only** `team.events.manage` to `GRANTABLE_TEAM_PERMISSIONS`,
       with the comment explaining the omission of `publish`.
5. [ ] `src/types/internalEvents.ts` — `InternalEventKind`, `AttendeeResponse`, `InternalEvent`
       (camelCase, `departmentName` to match `TeamAccess`), `SUGGESTED_LOCATIONS = ["Online",
       "Alameda", "Taguspark", "Externo", "V1.32 (Edifício Civil)"]`.
6. [ ] `src/schemas/internalEvents.ts` — `createInternalEventSchema` / `updateInternalEventSchema` /
       `cancelInternalEventSchema`, Portuguese messages, mirroring `src/schemas/grants.ts`. Bound
       `name` (1–200), `description` (≤ 5000), `locations` (≤ 10, trimmed, non-empty),
       `attendees` (≤ 200 istids), `startsAt`/`endsAt` as `z.iso.datetime({ offset: true })`.
7. [ ] `src/utils/db/internalEventQueries.ts` — new module. `createInternalEvent`,
       `updateInternalEvent`, `cancelInternalEvent` (no try/catch, optional trailing `Querier`),
       `getTeamInternalEvents`, `getInternalEvent`, and `getInternalEventDepartment(id)` (a
       one-column read used only for authorization, see step 8). Every parameter cast:
       `::VARCHAR(50)` istids, `::VARCHAR(30)` departments.
8. [ ] `src/app/api/workspace/events/route.ts` — GET (`?department=`), POST, PATCH, DELETE.
       Shape copied from `api/workspace/grants/route.ts`.
       **The authorization department for PATCH and DELETE is read from the stored event
       (`getInternalEventDepartment`), never taken from the request body** — otherwise a
       coordinator of Visuais passes `departmentName: "Visuais"` with a Dev-Team event id and the
       check passes against the wrong team. The stored value is then passed to the SQL function,
       which also requires it to match.
       `is_public: true` on POST/PATCH additionally requires `canForTeam(..., "team.events.publish", dept)`.
9. [ ] `src/app/workspace/[team]/page.tsx` — replace the placeholder section (lines 104-109) with
       "Próximos eventos e reuniões": the next few rows from `getTeamInternalEvents`, plus a link to
       the full list. Fetch **after** `requireTeamWorkspace`, as the roster already does.
10. [ ] `src/app/workspace/[team]/events/page.tsx` — new page. Calls
       `requireTeamWorkspace(team, "team.workspace.view")` itself, then renders the list and (when
       `canForTeam(..., "team.events.manage", team)`) the create/edit control.
11. [ ] `src/components/workspace/TeamEvents.tsx` — client component for the list + modal form,
       using `src/components/ui/{Button,Input,Select,Modal}` and
       `@/styles/pages/Workspace.module.css` (add classes there; `TeamAccessGrants.tsx` already
       shares that file). Portuguese copy throughout. The publish checkbox is rendered only when
       the server said `mayPublish`; the server re-checks regardless.
12. [ ] Tests — see §Verification.
13. [ ] `docs/ai-workflow/decision-log.md` — the four decisions: `owner_department_name` over
       `owner_team_id`; authorization in TS with a coarse SQL backstop; atomicity via one plpgsql
       function rather than `withTransaction`; `team.events.publish` deliberately non-grantable.
       `docs/ai-workflow/HANDOFF.md` — flip #129 to "slice A shipped, B/C/D open".

## Out of scope

- `/activities` — unchanged. It keeps reading `neiist.activities` and the Notion sync (slice C).
- Google Calendar — no call, no columns, no adapter (slice D).
- `src/utils/notion/internalEvents.ts` — stays, still read by `/activities` (slice C retires it).
- `event_sponsors` — needs `neiist.businesses` from Phase 5 (#138).
- `event_relations`, `event_documents`, agenda text and attendance marking — slice B.
- Importing the existing Notion events. Nothing is migrated; teams start with an empty list, and
  the Notion view stays available on `/activities` in the meantime.
- Tasks (#130) and the "Done" formula. `internal_events` has no task relation yet.
- Notifying attendees by email. That is a network call, it has no home yet, and it is not asked for.

## Risks

1. **A route authorizes against the department in the request body instead of the stored event.**
   The realistic path to a cross-team write, and the reason step 8 is spelled out. Mitigated twice:
   the route reads the owner first, and `update/cancel_internal_event` require the department to
   match the stored row (zero rows → NEI01, not a silent no-op).
2. **A later reader function forgets `is_public`.** Mitigated structurally (no table privileges) and
   by the `pg_proc` introspection test, which fails in the PR that adds the offending function.
3. **`SECURITY DEFINER` on a function that takes a department string.** The owner role bypasses all
   privilege checks, so a missing `WHERE owner_department_name = …` in any one of these functions is
   a full cross-team read. Reviewer checklist item; covered by the scoping tests.
4. **A temporary grantee publishes to the public site.** Prevented by leaving `team.events.publish`
   off `GRANTABLE_TEAM_PERMISSIONS`. If someone "tidies up" by adding it, the unit test in step 12
   fails. A grantee *can* unpublish (narrowing, reversible) — accepted.
5. **Two sources of truth for events during slices A–C.** Teams may create an event on the site
   while the Notion sync still owns `/activities`, so a public event created here does not appear
   publicly until slice C. This must be said in the UI ("ainda não aparece na página pública") and
   in the PR description, or the first user files it as a bug.
6. **`VARCHAR(30)` truncation.** Every department cast must be `::VARCHAR(30)`; the longest seeded
   name (`Mesa da Assembleia Geral`, 24) fits, but a cast to a shorter type truncates silently
   rather than erroring — the #142 trap.
7. **Concurrent edit of the same event.** Last write wins, and `update_internal_event` replaces
   locations/attendees wholesale, so two coordinators editing at once lose one set of changes.
   Acceptable for slice A (no money, no stock); note it, do not build optimistic locking yet.

## Verification

Beyond `yarn type:check`, `yarn lint`, `yarn format:check` — paste the actual output.

**Automated (`yarn test`, Postgres required for the DB suites):**

- `src/lib/auth/teamPermissions.test.ts` (pure) — `canForTeam` for the two new permissions:
  coordinator of Dev-Team gets `manage` in Dev-Team and not in Visuais; a member gets neither; an
  org-wide `_ADMIN` gets both anywhere; **a `source: "grant"` coordinator scope gets `manage` but
  is refused `publish`**. That last case is the one that proves the allowlist is doing work.
- `src/utils/db/internalEvents.test.ts` (DB) —
  - create with 2 locations and 3 attendees, then read back all three tables: exactly one event, two
    location rows, three attendee rows;
  - **atomicity mutation**: create with an attendee istid that does not exist → rejects with NEI15
    **and `SELECT count(*) FROM neiist.internal_events WHERE name = …` is 0**. Then temporarily move
    the attendee INSERT ahead of a deliberately failing statement and confirm the test still passes —
    i.e. prove the assertion is testing rollback, not ordering;
  - update replaces locations wholesale (3 → 1) and does not leave orphans;
  - `get_team_internal_events('Visuais', …)` never returns a Dev-Team event, public or not;
  - `update_internal_event(actor, id, 'Visuais', …)` on a Dev-Team event raises NEI01 and changes
    nothing;
  - a user with no scope in the department is refused NEI14 by `create_internal_event` even when the
    route check is bypassed (call the query function directly — this *is* the backstop test);
  - cancel is idempotent.
- `src/utils/db/internalEventsBoundary.test.ts` (DB) — the privilege assertions and the `pg_proc`
  introspection assertion from §The `is_public` boundary.
- **Mutation checks, recorded in the PR** (break it, watch the test fail, restore):
  1. delete `AND owner_department_name = e_department` from `get_team_internal_events` → the
     cross-team read test must fail;
  2. remove `team.events.publish` from the "not grantable" position (add it to
     `GRANTABLE_TEAM_PERMISSIONS`) → the grant test must fail;
  3. grant `SELECT` on `neiist.internal_events` to `neiist_app_user` → the boundary test must fail.

**By hand, against the local database** (`yarn dev`; note the port-5432 trap — the dev container may
be on 5433):

1. As a **Dev-Team coordinator**: open `/workspace/Dev-Team`, create a meeting with two locations and
   two attendees, edit it, cancel it. The team page section shows it.
2. As a **Dev-Team plain member**: the same page lists the meeting, and offers no create/edit control;
   `curl -X POST /api/workspace/events` with a valid body returns 403.
3. As a **Visuais member**: `/workspace/Dev-Team` still redirects to `/unauthorized`;
   `GET /api/workspace/events?department=Dev-Team` returns 403; a PATCH with
   `departmentName: "Visuais"` and the Dev-Team event's id returns 403 (**this is risk 1**).
4. **Anonymous**: `GET /api/workspace/events?department=Dev-Team` → 401. `/activities` renders
   exactly as before, with no internal-events row from the new table anywhere in the HTML —
   `curl -s localhost:3000/activities | grep -i "<the meeting's name>"` returns nothing.
5. `yarn db:migrate` twice in a row on the same database succeeds the second time as a no-op
   (idempotence), and `yarn db:migrate:status` shows 012 applied.

## Approvals needed

- **Schema** — new tables, indexes and functions in `docker/schema.sql` + `docker/migrations/012_*`.
  Required per CLAUDE.md §2.7. Production's real schema is still unmeasured (#152), but this
  migration only *adds* objects and touches nothing the order functions depend on, so #152 is not a
  blocker for it.
- **Auth** — two new team permissions and one change to `GRANTABLE_TEAM_PERMISSIONS`.
- **Product question, same round-trip:** should plain team members be able to create their team's
  *meetings* (as they can in Notion today), or is that coordinators-only as planned?
- **Dependencies** — none. **Payments** — untouched. **Production** — no deploy in this PR.

## Noticed but out of scope

- `src/app/layout.tsx:40-49` still has the blanket `catch` that #111 fixed in `serverCheckRoles`
  (#153, already tracked).
- Notion's team names do not match this database's: `Controlo e Qualidade` vs
  `Controlo & Qualidade`, and Notion's single `Team` select has a combined
  `Coordenação/Direção` value that maps to two departments here. Whoever writes the Phase 10 import
  needs an explicit mapping table and must fail loudly on an unmapped value.
- `src/utils/googleCalendar.ts` reads a service-account key from disk via
  `fs.readFileSync(process.cwd()/…)` at call time; upstream has already moved to env-loaded
  credentials. Slice D will run into this — worth a board item before then.
