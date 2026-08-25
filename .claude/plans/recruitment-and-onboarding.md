# Plan: Recruitment pipeline and member onboarding (#134, expanded)

## Goal

A candidate applies to NEIIST **on the website** — picking several teams — instead of a Google
Form; the núcleo screens, schedules an interview that becomes a real `internal_events` meeting,
and records an **independent outcome per team**; an accepted candidate receives an email with a
single-use link to a Fenix-authenticated onboarding page that collects their phone and contact
email, tells them the `@neiist.pt` address reserved for them, and gives the WhatsApp links for
**exactly the teams that accepted them**; and an admin has a screen listing the `@neiist.pt`
addresses waiting to be created in Google Workspace. When this is done, candidate names,
interview notes and rejection decisions live behind `canForTeam` instead of being readable by
every member of the Notion workspace — which is the stated reason #134 exists.

## Context

### The premise checks out — none of this exists today

- `src/components/about-us/JoinsUs.tsx:4` — `const joinUsLink = "https://google.com";`. The
  "Candidata-te" button on the public site points at a placeholder. There is no application page,
  no applications table, no recruitment API route. Verified by grep: the only occurrences of
  "recrutamento" in `src/` are that component's copy.
- `docker/migrations/` ends at `017_workspace_tasks.sql`. **018 is the next free number.**
- `src/utils/db/errorMapper.ts` allocates NEI01–NEI17 (`NEI17` = tasks `UNKNOWN_TARGET`).
  **NEI18+ is free.**

### The access model is finished — consume it, do not extend it

`src/lib/auth/permissions.ts` is the whole policy:

- `PERMISSION_ROLES` (:29) — global permissions. `can()` (:134), `serverCheckPermission` /
  `requirePermission` (`src/utils/permissionUtils.ts:86,94`).
- `TEAM_PERMISSION_ROLES` (:205) + `canForTeam` (:354) — the per-team question, a **separate
  type on purpose** so a team question cannot be answered globally.
- `GRANTABLE_TEAM_PERMISSIONS` (:315) — **default-deny**. A new team permission is not grantable
  until someone adds it there deliberately.
- `isNeiistMember` (:460) — `scopes.length > 0`. **Not "is logged in".**
- Guards: `requireNeiistMember` (`permissionUtils.ts:144`), `requireTeamWorkspace` (:159),
  `getWorkspaceSession` (:109).

`src/app/api/workspace/tasks/route.ts` is the reference API route: session → resolve the owning
department **from the row, never from the body** → `canForTeam` → Zod → query → `throwIf*DbError`
→ `handleApiError`. Copy that shape exactly.

### The house SQL pattern, from #129/#130

`docker/migrations/017_workspace_tasks.sql` is the closest model to what this needs:

- one `plpgsql` `SECURITY DEFINER` function per operation, because `neiist_app_user` has **no
  table privileges** (`docker/schema.sql:11-16`) — a function touching tables directly fails with
  `aclcheck_error`;
- `GRANT EXECUTE ON FUNCTION … TO neiist_app_user` for every function, with the full signature;
- one plpgsql call is one implicit transaction, so multi-table writes are indivisible for *every*
  caller rather than the one who remembers `withTransaction`;
- **no reader without a scope argument.** `get_team_tasks(department)` and
  `get_user_tasks(istid)` exist; "all tasks" does not. That is structural, not disciplinary.
- teams are keyed by **name** (`neiist.departments.name VARCHAR(30)` PK), never an id, because
  `canForTeam` compares `departments.name` **exactly** (permissions.ts:367-378). A translation
  step between the value authorized and the value written is how #180 happened.

### Email

`sendEmail({to, subject, html})` — `src/utils/emailUtils.ts:63`. **It returns `false` when SMTP
is unconfigured and `false` on send failure; it does not throw.** Any code that records "message
sent" must check the boolean. Template helpers to imitate live in the same file
(`getDiscountCampaignEmailTemplate`, `renderItemsTable`, `getEmailVerificationTemplate`).

### The existing token pattern, and where we deliberately depart from it

`neiist.email_token` (`docker/schema.sql:85-91`) + `add_email_verification` /
`get_email_verification` / `delete_email_verification` (:867-897), driven from
`src/app/api/user/verify-email/request/route.ts:22-26`: `crypto.randomBytes(32).toString("hex")`,
30-minute expiry, link in the email.

Two things it does that we will **not** copy: it stores the token **in plaintext**, so a database
read yields working links; and it never expires the *row*, only compares `expires_at`. See
"The onboarding token" below.

### Identity

- Fenix login creates the `neiist.users` row on first `/api/auth/userdata` call
  (`src/app/api/auth/userdata/route.ts:85-89`) and issues the `session` JWT — so an applicant who
  logs in to claim an acceptance **already has a user row and a session**, holding `[_GUEST]`
  because roles derive from memberships.
- External Google accounts get `ext_${crypto.randomUUID()...}`
  (`src/app/api/auth/google/callback/route.ts:107`) and **cannot hold a membership**.
  `isTecnicoEmail` (`src/utils/identity/tecnicoEmail.ts`) is the domain check.
- **There is no `ext_` predicate helper anywhere** — the prefix is written as a literal in one
  place. Slice D needs one; add `isExternalIstid(istid)` next to `isTecnicoEmail`.

### Routing traps that will bite this feature specifically

1. **`src/proxy.ts:11-17` — a path claimed by no rule falls through to the public match, but only
   for anonymous callers.** `canAccess` (:87) is consulted only `if (isAuthenticated)` (:214) and
   returns `false` for an unlisted path. So a **new public page that is not added to
   `publicRoutes` works while logged out and redirects logged-in users to `/unauthorized`.** The
   application page must be added to `publicRoutes`; this is #97/#117 in mirror image.
2. **`/workspace/[team]` is a dynamic segment.** A literal `/workspace/recrutamento` page would
   shadow a team named "Recrutamento". None exists (`docker/init.sql:5-11` seeds eight
   departments), but the collision must be pinned by a test, not by hope.
3. `guestRoutes` (`proxy.ts:18`) means "authenticated, any access level **including `_GUEST`**".
   That is exactly the population the onboarding page serves.

### Scheduling exists

`node-cron` is already a dependency and `src/lib/autoCancelScheduler.ts` is the pattern: a
`globalThis` once-guard, skipped under `NEXT_PHASE === PHASE_PRODUCTION_BUILD`, imported from
`src/app/layout.tsx:18`. The retention purge reuses it — **no new dependency.**

### Rate limiting

`src/lib/rateLimitRules.ts` — `/api/*` defaults to 60/min per IP. A public write endpoint needs
its own, tighter rule, like `/api/user/verify-email/` already has.

## Approach

Model the application as **one row with a per-team child row that carries its own outcome**. That
is the only part of the request with real modelling risk, and every alternative is worse:

- *A single `outcome` column with a list of teams* (what Notion does, and what #134 sketches with
  `outcome` on `applications`) cannot express "accepted into Visuais, rejected by Dev-Team", which
  is the explicit requirement. Rejected.
- *One application row per team* loses that it is one person, one interview, one email — the
  interview would be scheduled three times and three acceptance emails would go out. Rejected.

So: `applications` 1—N `application_teams(application_id, department_name, outcome)`, outcome
defaulting to `pending`, and an application-level `status` that is a function of the parent
lifecycle only. `department_name VARCHAR(30) REFERENCES neiist.departments(name)`, matching
`internal_events.owner_department_name` and `tasks.owner_department_name`, so `canForTeam`
authorizes these rows with no translation step.

The interview reuses `neiist.create_internal_event(...)` from `012_internal_events.sql` and stores
the returned id in `applications.interview_event_id`. No second events table, no second attendee
table — the interviewers are `event_attendees`.

### Slicing — five PRs, and the first one precisely

| slice | what | why this boundary |
|---|---|---|
| **A** | Migration 018: editions, applications, per-team rows. Public form at `/candidatura`. Workspace pipeline list. Screening reject. | Everything downstream needs the table. Nothing here sends an email, creates an event, or touches auth beyond two new permissions. Independently shippable and immediately replaces the Google Form. |
| **B** | Interview scheduling → `create_internal_event`; interviewers as attendees; `application_notes`, team-restricted. | The `#134` acceptance criterion that matters most ("notes readable only by Coordenação and the relevant team lead"). Depends on A's tables, on nothing else. |
| **C** | Per-team outcomes; `@neiist.pt` reservation; the invite token; the acceptance email. | The first slice that sends mail and mints a credential. Both need the review UI from A and the interview state from B to be worth anything. |
| **D** | `/onboarding/[token]` — Fenix login, token redemption, phone + contact email capture, the address, per-team WhatsApp links (+ `teams.whatsapp_url` and its editor). | The new access case. Isolated in one route prefix so its guard can be reviewed on its own. |
| **E** | Address allocation on ordinary member creation; the "addresses to create in Workspace" admin screen; the retention purge job. | Independent of recruitment — it is the PO's separate request — but reuses C's allocator, so it must come after C. |

**Slice A is the deliverable of this plan.** B–E are sketched precisely enough to be planned from
here, but each gets its own plan file before implementation.

## Schema — migration `018_recruitment.sql` (HUMAN APPROVAL REQUIRED)

Slice A creates only what is listed below. B, C and D each add their own migration (019, 020,
021). `docker/schema.sql` is edited in the same PR, per CLAUDE.md §4a; the migration must be
idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT DO NOTHING`).

```sql
-- Editions are a first-class row, not a date-range filter (#134 acceptance criterion). It is
-- also the on/off switch the public form needs: no open edition, no form.
CREATE TABLE IF NOT EXISTS neiist.recruitment_editions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),   -- '1ª edição 2025/26'
  opens_at   TIMESTAMPTZ NOT NULL,
  closes_at  TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT edition_closes_after_open CHECK (closes_at > opens_at)
);
-- "Open" is derived from the clock, never a boolean anyone can forget to unset.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recruitment_edition_name ON neiist.recruitment_editions (lower(name));

CREATE TABLE IF NOT EXISTS neiist.applications (
  id                 SERIAL PRIMARY KEY,
  edition_id         INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE RESTRICT,
  candidate_name     TEXT NOT NULL CHECK (btrim(candidate_name) <> ''),
  email              TEXT NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  phone              TEXT,                        -- optional here, required at onboarding
  course             TEXT,
  curricular_year    SMALLINT CHECK (curricular_year IS NULL OR curricular_year BETWEEN 1 AND 8),
  motivation         TEXT CHECK (motivation IS NULL OR length(motivation) <= 5000),
  -- Informational only: whoever happened to be logged in when the form was posted. The
  -- authoritative identity binding happens at token redemption (slice D), into a DIFFERENT
  -- column, so "who applied" and "who claimed it" can never be silently conflated.
  submitted_by_istid VARCHAR(50) REFERENCES neiist.users(istid),
  status             TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
                       'submitted','screening_rejected','interview_scheduled','interview_done',
                       'no_show','ghosted','decided','onboarded','withdrawn')),
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- slice B
  interview_event_id INT REFERENCES neiist.internal_events(id) ON DELETE SET NULL,
  -- slice C
  decided_at           TIMESTAMPTZ,
  result_email_sent_at TIMESTAMPTZ,               -- Notion's 'Mensagem enviada?'
  -- slice D
  onboarded_istid    VARCHAR(50) REFERENCES neiist.users(istid),
  onboarded_at       TIMESTAMPTZ,
  -- retention: set by every terminal transition, read by the purge job (slice E)
  purge_after        DATE
);

-- One application per person per edition. Case-insensitive, because "Ana@..." and "ana@..."
-- are the same mailbox and a duplicate here means a second interview slot burned.
CREATE UNIQUE INDEX IF NOT EXISTS uq_application_per_edition
  ON neiist.applications (edition_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_applications_pipeline
  ON neiist.applications (edition_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_applications_purge
  ON neiist.applications (purge_after) WHERE purge_after IS NOT NULL;

-- The per-team decision. THE point of the whole model.
CREATE TABLE IF NOT EXISTS neiist.application_teams (
  application_id  INT NOT NULL REFERENCES neiist.applications(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name) ON DELETE CASCADE,
  -- 'challenge' is Notion's "Enviar desafio de Dev"/"Desafio Feito": still open, but the ball is
  -- with the candidate. It blocks 'decided' exactly as 'pending' does.
  outcome         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending','challenge','accepted','rejected')),
  -- Reviewers may ADD a team the candidate did not pick — Notion's "Convidar para Eventos ou
  -- Visuais". `invited` distinguishes it, so nobody later reads an invitation as an application.
  source          TEXT NOT NULL DEFAULT 'applied' CHECK (source IN ('applied','invited')),
  decided_at      TIMESTAMPTZ,
  decided_by_istid VARCHAR(50) REFERENCES neiist.users(istid),
  PRIMARY KEY (application_id, department_name),
  CONSTRAINT application_team_decided_matches CHECK (
    (outcome IN ('pending','challenge') AND decided_at IS NULL) OR
    (outcome IN ('accepted','rejected') AND decided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_application_teams_by_team
  ON neiist.application_teams (department_name, outcome);
```

SQL functions for slice A, all `SECURITY DEFINER`, all with an explicit `GRANT EXECUTE`:

| function | notes |
|---|---|
| `neiist.get_open_recruitment_edition()` | one row or none, by `NOW() BETWEEN opens_at AND closes_at`. Public read. |
| `neiist.submit_application(edition_id, name, email, phone, course, year, motivation, submitted_by, departments VARCHAR(30)[])` | inserts parent + children atomically. Raises **NEI18** on a malformed submission (blank name, no teams, more than 5 teams), **NEI19** if the edition is not open, **NEI20** if any department is not an `active` row with `department_type = 'team'`. Duplicate → the unique index's `23505`, which `handleApiError` already maps to 409. |
| `neiist.get_recruitment_pipeline(u_istid VARCHAR(50), p_edition_id INT)` | **takes the caller's istid.** Returns applications having at least one team in `neiist.get_user_team_scopes(u_istid)`, plus everything when the caller holds an organisation-wide role — mirroring `get_user_tasks` (017:167). Per-team rows are returned whole (a coordinator does see which other teams the candidate applied to; that is coordination, not leakage — notes are the restricted part and they are slice B). |
| `neiist.get_application(u_istid, p_id)` | same scoping, single row + its teams as JSONB. |
| `neiist.set_application_status(p_id, p_from TEXT, p_to TEXT, p_actor VARCHAR(50))` | the transition guard. `p_from` is optimistic concurrency, exactly like `set_order_state` in `003_order_transitions_and_cap.sql:52` — the caller states the status its decision was based on and a stale decision writes nothing. Illegal transition → **NEI21**. Sets `purge_after` on terminal states. |
| `neiist.is_valid_application_transition(from, to)` | `LANGUAGE sql IMMUTABLE`, the table below, so the machine is one readable expression and is directly testable. |

New SQLSTATEs, all mapped in `errorMapper.ts` in the same PR (an unmapped code makes
`apiErrorHandler` echo the raw `RAISE` text with a 500 — errorMapper.ts:10-13):

| code | meaning | maps to |
|---|---|---|
| NEI18 | the application is malformed | `ValidationError` (400) |
| NEI19 | no open edition / applications closed | `ConflictError` (409) |
| NEI20 | unknown or non-team department | `ValidationError` (400) |
| NEI21 | illegal status transition | `ConflictError` (409) |

Reserved for later slices, allocated now so they do not collide: **NEI22** (invite token invalid /
expired / already redeemed, slice C+D), **NEI23** (address allocation exhausted, slice C).

## The state machine

Application-level `status`. Per-team `outcome` is orthogonal and moves only in the `decided`
transition.

```
                  ┌─────────────────────────────────────────────┐
submitted ────────┤→ interview_scheduled → interview_done → decided → onboarded
    │             │        │  ↑                 │            │
    │             │        │  └── reschedule ───┘            └→ (terminal if no team accepted)
    │             │        ↓
    │             │   no_show | ghosted ──→ interview_scheduled | screening_rejected | decided
    ├→ screening_rejected  (terminal)
    └→ withdrawn           (terminal, from ANY non-terminal state)
```

Legal transitions, exhaustively — this is the `is_valid_application_transition` table:

| from | to |
|---|---|
| `submitted` | `interview_scheduled`, `screening_rejected`, `withdrawn` |
| `interview_scheduled` | `interview_scheduled` (reschedule), `interview_done`, `no_show`, `ghosted`, `withdrawn` |
| `interview_done` | `decided`, `withdrawn` |
| `no_show`, `ghosted` | `interview_scheduled`, `screening_rejected`, `decided`, `withdrawn` |
| `decided` | `onboarded` — **only if at least one `application_teams.outcome = 'accepted'`** |
| `screening_rejected` | `submitted` (reopen; `recruitment.editions.manage` only) |
| `onboarded`, `withdrawn` | nothing |

Two invariants the SQL enforces, not the UI:

1. `→ decided` requires **zero** `application_teams` rows in `pending` or `challenge`. A partial
   decision is not a decision, and it is the shape that would send "parabéns" to someone whose
   Dev-Team answer had not been given yet.
2. `→ onboarded` requires `onboarded_istid IS NOT NULL` and at least one accepted team.

`status = 'submitted'` with `from = 'submitted'` is **not** idempotent here (unlike orders): a
second "reject" click on a stale page must fail loudly, because the first one may have already
sent mail in slice C.

## Permissions (HUMAN APPROVAL REQUIRED — auth change)

**Global** (`PERMISSION_ROLES`, with `PERMISSION_LABELS` entries — the record is total, so a
missing label fails `type:check`):

| permission | roles | why |
|---|---|---|
| `recruitment.pipeline.view` | `_ADMIN`, `_COORDINATOR` | opens the pipeline at all. Scoping to *which* applications is `get_recruitment_pipeline`'s job, not this permission's. |
| `recruitment.applications.review` | `_ADMIN`, `_COORDINATOR` | screening-reject, schedule an interview, mark no-show. Application-level lifecycle, which is núcleo-wide business. |
| `recruitment.editions.manage` | `_ADMIN` | open/close an edition, reopen a rejected application. The board decides when recruitment runs. |

**Team-scoped** (`TEAM_PERMISSION_ROLES`):

| permission | roles | grantable? |
|---|---|---|
| `team.recruitment.decide` | `_ADMIN`, `_COORDINATOR` | **No.** |
| `team.recruitment.notes` (slice B) | `_ADMIN`, `_COORDINATOR` | **No.** |

**Who decides per team: that team's coordinators, or the board.** `canForTeam(roles, scopes,
"team.recruitment.decide", departmentName)` — which is precisely the question #180 built, and it
makes "the Visuais coordinator accepts into Visuais and cannot touch the Dev-Team row" true by
construction rather than by a bespoke check.

Neither is added to `GRANTABLE_TEAM_PERMISSIONS`, and that is the substantive call:
`team.recruitment.decide` creates a *permanent membership* downstream, exactly the authority that
`mayAssignAccess` (permissions.ts:434) refuses to lend to a grant-derived scope. Lending it here
would route around that filter. `team.recruitment.notes` reads assessments of a named person; a
two-week loan of a team must not come with its interview archive. Because the allowlist is
default-deny, **doing nothing is the correct action** — but the reasoning still gets written into
the permission's doc comment, or a future reader will "fix" the omission.

## The `@neiist.pt` address (slice C, used by D and E)

```sql
-- Slice C's migration. local_part is the primary key: uniqueness IS the requirement, so it is
-- the key, not an index someone can drop.
CREATE TABLE IF NOT EXISTS neiist.neiist_addresses (
  local_part     TEXT PRIMARY KEY CHECK (local_part ~ '^[a-z0-9]+(\.[a-z0-9]+)*$'),
  istid          VARCHAR(50) REFERENCES neiist.users(istid),
  application_id INT REFERENCES neiist.applications(id) ON DELETE SET NULL,
  state          TEXT NOT NULL DEFAULT 'reserved'
                 CHECK (state IN ('reserved','provisioned','released')),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provisioned_at TIMESTAMPTZ,
  released_at    TIMESTAMPTZ,
  CONSTRAINT address_has_an_owner CHECK (istid IS NOT NULL OR application_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_neiist_address_istid
  ON neiist.neiist_addresses (istid) WHERE istid IS NOT NULL AND state <> 'released';
```

**A released local part is never reused.** The row stays as a tombstone. Mail sent to a departed
member's address must not land in a new member's inbox, and Workspace aliases outlive people;
that risk is not worth the aesthetic win of recycling `ana.silva`.

**How the address is derived — policy in TypeScript, uniqueness in SQL.**
`src/utils/identity/neiistAddress.ts` exports a **pure** function
`addressCandidates(fullName: string): string[]` producing an ordered preference list:

1. normalise: NFD, strip diacritics (`/\p{Diacritic}/gu`), lowercase, drop everything outside
   `[a-z0-9 ]`, collapse whitespace, drop Portuguese particles (`de`, `da`, `do`, `dos`, `das`,
   `e`);
2. `first.last` → `ana.silva`;
3. `first.secondsurname.last` → `ana.costa.silva`;
4. `first.middle.last` → `ana.maria.silva`;
5. `first.m.last` (middle initials) → `ana.m.silva`;
6. numeric fallback `ana.silva2`, `ana.silva3`, … up to 20.

Pure, no I/O, so the naming policy is unit-testable without a database — including the cases that
matter: `"Ana Silva"` twice, `"João Peçanha D'Ávila"`, a single-word name, a name that normalises
to the empty string (falls back to the istid).

`neiist.reserve_neiist_address(p_candidates TEXT[], p_istid, p_application_id)` walks the array
and inserts the first free one, returning the local part; raises **NEI23** if all 20 are taken.
Atomic because it is one statement per attempt inside one function call — two simultaneous
acceptances of two people called Ana Silva cannot both get `ana.silva`; the second takes
`ana.costa.silva`. This is the concurrency case that gets a real test (see Verification).

**Reserved at acceptance, not at member creation.** Three reasons: the onboarding page must show
the *same* address on every refresh, and reserving at first view makes the value depend on who
opened the page first; the admin needs lead time to create it in Workspace, which is exactly what
"takes a few days to become active" is warning about; and slice E's screen is only useful if
addresses appear on it before the person shows up. The cost is that an accepted candidate who
never onboards holds a reservation — released by the retention job.

**Provisioning is manual and stays manual in this plan.** The site marks `reserved`; an admin
creates the mailbox in the Google Workspace console and ticks it `provisioned`. Automating it
means the Google Workspace Admin SDK, a service account with domain-wide delegation, and the
`admin.directory.user` scope — a **new dependency and a production credential**, both
stop-and-ask. Out of scope, noted below.

## The onboarding token (slice C mints it, D redeems it)

```sql
CREATE TABLE IF NOT EXISTS neiist.application_invites (
  application_id   INT PRIMARY KEY REFERENCES neiist.applications(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,     -- sha256 hex of the token. NEVER the token.
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  redeemed_at      TIMESTAMPTZ,
  redeemed_by_istid VARCHAR(50) REFERENCES neiist.users(istid)
);
```

Five properties, each with the failure it prevents:

1. **256 bits of `crypto.randomBytes(32)`, base64url**, generated in Node. Not guessable, not
   enumerable, not derived from the application id.
2. **Only the SHA-256 hash is stored.** `email_token` stores plaintext; a read of that table
   yields working links. A read of this one yields nothing usable. Lookup is by hash on a UNIQUE
   index, so it is a constant-shape query, not a scan.
3. **It expires — 14 days**, long enough for the "few days" the address takes and a slow reader,
   short enough that a forwarded email stops working. Checked in SQL (`expires_at > NOW()`), not
   in TypeScript.
4. **It is not a credential.** It authenticates nobody. `/onboarding/[token]` requires a **valid
   Fenix session first** and the token second; the token only names *which application* this
   session is claiming. A leaked link gets the finder a login prompt and then a refusal, because:
5. **It binds on first redemption and is single-use for the write.** `redeem_application_invite`
   sets `redeemed_at` + `redeemed_by_istid` and `applications.onboarded_istid` in one call, and
   refuses (NEI22) if already redeemed by a different istid. After redemption the candidate
   reaches their page through their **session** (`onboarded_istid = session.istid`), so the link
   expiring never locks them out of their own WhatsApp links.

Plus: `ext_` istids are refused (they cannot hold a membership at all, permissions.ts:424), the
route gets its own rate-limit rule, and re-sending the result email **reissues** a fresh token,
overwriting `token_hash` — so the old link dies rather than two links being live.

## PII and retention (needs the board's sign-off on the periods)

**Where it lives:** `neiist.applications` + `application_teams` + `application_notes`, in the same
Postgres, reachable only through `SECURITY DEFINER` functions that all take a scope argument. No
copy in Notion, no copy in a spreadsheet. CVs are **out of scope for every slice here** — the
Drive pattern in `src/app/api/user/cv-bank/route.ts` exists, but adding a candidate CV means
storing an unauthenticated stranger's document, which needs its own decision.

**Who can read what:**

| data | readable by |
|---|---|
| name, email, phone, course, motivation | `recruitment.pipeline.view` **and** scoped by `get_recruitment_pipeline` to applications naming one of the caller's teams; org-wide `_ADMIN` sees all |
| per-team outcome | same |
| interview notes (slice B) | notes tagged to a department: `canForTeam(…, "team.recruitment.notes", dept)`. Untagged notes: `recruitment.applications.review`. |
| the candidate's own data | themselves, after redemption, on the onboarding page |

**How long — proposed, and explicitly a policy decision to confirm:**

| state | retained |
|---|---|
| `screening_rejected`, `withdrawn`, all-teams-`rejected` | **6 months** after `status_changed_at` |
| accepted but never onboarded | **12 months** after `decided_at`, then purged and the address `released` |
| `onboarded` | the application row is kept as the record of how they joined; `motivation`, `phone` and all `application_notes` are **purged at 12 months**, because from then on `neiist.membership` is the authoritative record |

Mechanism: `applications.purge_after DATE`, set by every terminal transition, and
`neiist.purge_expired_applications()` run daily from a `node-cron` job following
`src/lib/autoCancelScheduler.ts` exactly (once-guard, skipped at build phase). **Purge is a hard
`DELETE`, not a flag.** Aggregate counts per edition are computed and stored on
`recruitment_editions` before deletion if the núcleo wants statistics — anonymous counts, not
retained rows.

Slice A ships the `purge_after` column and sets it; **the job itself is slice E.** A column that
is set but not yet swept is honest; a job that sweeps a schema still in flux is not.

## Steps — slice A only

Order chosen so the tree compiles between steps.

1. [ ] `docker/migrations/018_recruitment.sql` — new file, the three tables, the six functions and
       their `GRANT EXECUTE`s, exactly as specified above. Idempotent throughout. Header comment
       in the style of `017_workspace_tasks.sql`: what it ports, and the two departures from
       Notion's shape (per-team outcome rows; editions as rows).
2. [ ] `docker/schema.sql` — same objects appended, so a fresh database matches. Both files, one
       PR, per CLAUDE.md §4a.
3. [ ] `docker/init.sql` — seed one edition (`'1ª edição 2025/26'`) with dates in the past so the
       local form is closed by default; opening it is a deliberate act.
4. [ ] `src/lib/auth/permissions.ts` — add the three global permissions to `PERMISSION_ROLES`
       (:29) with their Portuguese `PERMISSION_LABELS` (:151), and `team.recruitment.decide` to
       `TEAM_PERMISSION_ROLES` (:205). **Do not touch `GRANTABLE_TEAM_PERMISSIONS`**; add the
       doc comment explaining why it is absent.
5. [ ] `src/utils/db/recruitmentQueries.ts` — **a new, seventh module** (CLAUDE.md §4: "If it fits
       none of them, that is a signal to add a sixth module"; `taskQueries.ts` is the precedent).
       Types `RecruitmentEdition`, `Application`, `ApplicationTeam`, `ApplicationStatus`,
       `TeamOutcome`; functions `getOpenEdition`, `submitApplication`, `getRecruitmentPipeline`,
       `getApplication`, `setApplicationStatus`. **Errors throw** — no `catch { return null }`,
       matching `taskQueries.ts`'s stated rule, because NEI18–NEI21 carry messages written to be
       read.
6. [ ] `src/utils/db/errorMapper.ts` — `RECRUITMENT_SQLSTATE` block + `throwIfRecruitmentDbError`,
       mapping NEI18/NEI20 → `ValidationError`, NEI19/NEI21 → `ConflictError`.
7. [ ] `src/schemas/recruitment.ts` — new file. `submitApplicationSchema` (name ≤ 120, email,
       **`portuguesePhoneSchema`**, course ≤ 120, year 1–8, motivation ≤ 5000, `departments`
       array min 1 max 5 of trimmed non-empty ≤ 30), `screeningDecisionSchema`.
8. [ ] `src/utils/identity/phone.ts` — `isPortuguesePhone` + a normaliser. **Accept `+351` or
       `00351` or bare, 9 digits, first digit `9` (mobile) or `2` (landline); store normalised as
       `+351XXXXXXXXX`.** The existing `user_contacts` CHECK (`docker/schema.sql:69`) is
       deliberately loose and stays that way — this is a stricter application-level rule, not a
       schema change.
9. [ ] `src/app/api/recruitment/applications/route.ts` — `POST`, **public, no session required**.
       Zod → `getOpenEdition` → `submitApplication` → 201. `GET` = the pipeline: session +
       `serverCheckPermission("recruitment.pipeline.view")` + `getRecruitmentPipeline(istid, …)`.
       Copy the error handling shape of `src/app/api/workspace/tasks/route.ts:64-72` verbatim.
10. [ ] `src/app/api/recruitment/applications/[id]/route.ts` — `PATCH` for the screening
        transitions. Resolve the application **first**, authorize on
        `recruitment.applications.review`, then `setApplicationStatus(id, from, to, actor)`.
        The `from` comes from the request as optimistic concurrency, never as authorization.
11. [ ] `src/lib/rateLimitRules.ts` — `if (pathname.startsWith("/api/recruitment/applications"))
        return { limit: 5, windowMs: 60 * MIN }` **before** the generic `/api/` rule. Per IP, not
        per user: the submitter is anonymous.
12. [ ] `src/proxy.ts` — add `"/candidatura"` to `publicRoutes` (:11). **Without this the page
        works logged out and redirects logged-in users to `/unauthorized`** (see Context).
13. [ ] `src/app/candidatura/page.tsx` — public Server Component. Reads the open edition and the
        active teams (`getAllDepartments`, filtered to `department_type === 'team' && active`);
        renders a closed-state message when there is no open edition. Client form component in
        `src/components/recruitment/ApplicationForm.tsx` using `src/components/ui/*` primitives.
        Copy is Portuguese.
14. [ ] `src/components/about-us/JoinsUs.tsx:4` — replace `"https://google.com"` with
        `/candidatura`, and make it an internal `next/link`.
15. [ ] `src/app/workspace/recrutamento/page.tsx` — the pipeline, guarded by
        `requirePermission("recruitment.pipeline.view")` **before any fetch**, then
        `getRecruitmentPipeline(session.user.istid, editionId)`. Grouped by status, with the
        per-team rows visible and the two screening actions.
16. [ ] `src/styles/pages/Recruitment.module.css` + `src/styles/components/recruitment/…` —
        mirroring the components tree, matching `Workspace.module.css`.
17. [ ] Tests (below).
18. [ ] `docs/ai-workflow/decision-log.md` — record the per-team outcome model, the non-grantable
        decision, and the retention periods. `problem-registry.md` gets nothing; nothing here is
        a bug.

## Out of scope — deliberately

- **Interview scheduling, notes, outcomes, emails, tokens, the onboarding page, WhatsApp links,
  the address allocator, the add-member screen and the purge job.** Slices B–E. Slice A must not
  half-build any of them; the columns they need exist and stay `NULL`.
- **CV upload.** Storing a stranger's document is its own decision.
- **Google Workspace API provisioning.** New dependency + production credential.
- **Migrating the two historical Notion editions.** A separate import script, after the shape has
  proven itself on a live edition. `edition_id` makes it possible later.
- **A captcha on the public form.** A new dependency, and the rate limit plus the per-edition
  unique index is the proportionate first answer.
- **Changing `requireNeiistMember`, `isNeiistMember` or `GRANTABLE_TEAM_PERMISSIONS`.** The
  applicant case is served by a *different route prefix*, not by loosening the workspace boundary.
- **Notifying teams that a candidate picked them.** Nice, and it is slice B or later.

## Risks, ranked

1. **A public write endpoint on a database that has never had one.** Every other write behind
   `/api/` requires a session. `submit_application` is `SECURITY DEFINER` and therefore runs as
   the owner: a defect in it is a defect an anonymous stranger can reach. Mitigations: it takes
   only scalars and a `VARCHAR(30)[]`, all parameterised; it validates the edition is open and
   every department is an active *team* **in SQL**, not only in Zod; rate limit 5/hour/IP; the
   unique index caps duplicates. **This function gets the most careful review in the PR.**
2. **Spam and impersonation.** Anyone can submit an application in anyone's name and email —
   there is no verification at submit time, by design (requiring login to apply would exclude
   people who have not logged into the site). Consequence: a stranger can cause a real person to
   receive a "parabéns" email in slice C. Accepted, because acceptance is a human decision after
   an interview, and because the token binds to whoever authenticates with Fenix — the impostor
   cannot complete onboarding. **Written down here so it is not rediscovered as a surprise.**
3. **`get_recruitment_pipeline` scoping is the whole point of #134 and is easy to get subtly
   wrong.** If the scope filter is written as "the caller is a coordinator somewhere" rather than
   "this application names one of the caller's teams", every coordinator reads every candidate —
   which is Notion's failure, reproduced. Guarded by SQL that filters through
   `get_user_team_scopes`, and by a test that asserts a Visuais coordinator gets zero rows for a
   Dev-Team-only application.
4. **The `/workspace/recrutamento` ↔ `/workspace/[team]` route collision.** A future team named
   "Recrutamento" becomes silently unreachable. Guarded by a test asserting no active department
   name matches a reserved workspace segment.
5. **Two identical names racing for one address** (slice C). Mitigated by the primary key doing
   the work, and pinned by a real concurrency test — two connections, one holding a transaction
   open, per the HANDOFF standard that `Promise.all` is not a concurrency test.
6. **An email sent for a decision that then rolls back** (slice C). Structurally prevented: the
   decision commits in its own plpgsql call, and `sendEmail` runs afterwards, in the route.
   `result_email_sent_at` is written by a *second* call, so "decided but not yet told" is a real,
   visible, resumable state rather than a lie.
7. **Retention that is documented but never happens** — the #134 note calls this out by name. The
   `purge_after` column ships in slice A precisely so the job in E has nothing to guess.

## Verification

`yarn type:check`, `yarn lint`, `yarn format:check` are the floor, not the evidence.

**Automated (Vitest; DB-backed suites need Postgres, per HANDOFF §3):**

- `src/utils/db/recruitment.test.ts` (new, DB-backed, modelled on `tasks.test.ts`):
  - an application to Visuais + Dev-Team is invisible to a **Fotografia** coordinator and visible
    to a **Visuais** one — the #134 criterion;
  - the same candidate email twice in one edition → `23505`; in a *different* edition → allowed;
  - `submit_application` refuses a department that is an `admin_body` (`Direção`), an inactive
    team, and an empty team array;
  - `submit_application` refuses when no edition is open;
  - every illegal transition in the table above raises NEI21; every legal one succeeds;
  - a stale `p_from` writes nothing and reports it (two callers, one wins).
- `src/lib/auth/permissions.test.ts` — extend: `team.recruitment.decide` is **absent** from
  `GRANTABLE_TEAM_PERMISSIONS`, and a grant-derived Visuais scope returns `false` for it while a
  membership-derived one returns `true`.
- `src/utils/identity/phone.test.ts` — pure. `+351912345678`, `912345678`, `00351912345678`
  accepted and normalised identically; `812345678`, `91234567`, `+34912345678`, and a
  9-digit-with-spaces landline handled as specified.
- `src/proxy.test.ts` (or the existing route-list test if one exists) — `/candidatura` is public
  for both an anonymous and a logged-in `_GUEST` caller.
- A schema-introspection test in the style of `schemaIntegrity.test.ts`: **no row-returning
  recruitment function lacks a scope parameter**, and no active `neiist.departments.name`
  collides with a reserved `/workspace/*` segment.

**Mutation testing, per the HANDOFF standard** — for each, break it, prove the test fails, restore:

- drop the `get_user_team_scopes` filter from `get_recruitment_pipeline` → the cross-team test
  must fail;
- add `team.recruitment.decide` to `GRANTABLE_TEAM_PERMISSIONS` → the grant test must fail;
- make `is_valid_application_transition` return `TRUE` unconditionally → the transition test must
  fail.

**Manual, in a browser, and stated in the PR:**

1. Logged out, `/candidatura` renders and submits. Submit again with the same email → a
   Portuguese 409 message, not a stack trace.
2. **Logged in as a plain shop customer**, `/candidatura` still renders (this is the proxy trap).
3. As a Visuais coordinator, `/workspace/recrutamento` lists the Visuais applicant and **not** the
   Dev-Team-only one. As a board admin, both.
4. As a plain member, `/workspace/recrutamento` → `/unauthorized`, and the response contains no
   candidate name (view source, not just the rendered page).
5. Reject an application from two browser tabs; the second reports a stale-state conflict.
6. Close the edition; `/candidatura` shows the closed message and the POST returns 409.

## Approvals needed

| what | why |
|---|---|
| **`docker/migrations/018_recruitment.sql` + `docker/schema.sql` + `docker/init.sql`** | schema change — CLAUDE.md §2.7. Also read §4a: 018 is the next free number and every statement must be idempotent. |
| **Three global + one team permission** | auth change — CLAUDE.md §2.7. Specifically: coordinators, not only the board, may review; and per-team acceptance is the *team's* coordinators. |
| **The retention periods** (6 / 12 / 12 months) | GDPR policy about people who are not and may never be members. A developer should not pick these numbers alone. |
| **Slice C, when it arrives**: sending automated email to candidates, and minting the invite token | first outbound mail to non-members; a credential-adjacent mechanism. |
| **Slice E, if it ever automates Workspace** | Google Admin SDK = new dependency + domain-wide-delegation credential. Not in this plan. |
| Nothing here touches SumUp, orders, or production data. | |

Open product questions to batch into one round-trip with the approvals above:

1. **Retention** — are 6/12/12 months right, and does the núcleo want anonymous per-edition
   statistics kept after the purge?
2. **Address format** — is `ana.silva@neiist.pt` the intended shape, and is the collision ladder
   (`ana.costa.silva` before `ana.silva2`) acceptable? Is there an existing convention already in
   use in Workspace that this must match?
3. **WhatsApp links** — one link per team, edited by whom: the board (`teams.manage`) or each
   team's own coordinators (`team.content.edit`)? Default assumption for slice D: **the team's
   coordinators**, since they are the ones who rotate the invite link.
4. **Does an accepted candidate become a member automatically at onboarding**, or does a
   coordinator still press "adicionar membro"? Default assumption: **manual** — `add_team_member`
   stays the single path by which memberships come into existence, and onboarding only collects
   details and reserves the address. Automating it would make a self-service page create
   authority, which is what #193 was about.
5. **Interviews** — one meeting per candidate, or one per team they applied to? Default
   assumption for slice B: **one**, owned by the department that scheduled it, with the other
   teams' interviewers added as `event_attendees`.

## Noticed but out of scope — candidate board items

- `src/components/about-us/JoinsUs.tsx:4` — `joinUsLink = "https://google.com"` is a live
  placeholder on a public page today. Step 14 fixes it, but if slice A slips, this is a one-line
  fix worth doing on its own.
- `neiist.email_token` stores verification tokens **in plaintext** (`docker/schema.sql:85-91`).
  Not exploited by anything here, and this plan does not copy the pattern, but the existing table
  is a standing "a database read yields working links" exposure. Worth an issue.
- `neiist.email_token` rows are never deleted on expiry — only compared against. It accumulates
  every alternative email anyone ever tried to verify, indefinitely. Same purge job could sweep it.
