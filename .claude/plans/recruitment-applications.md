# Plan: Recruitment applications on the site (replace the Google Form)

## Scope, agreed with Tomás before writing this

- **In scope:** a public application page on the site (replaces the Google Form), requiring
  Fenix login, and a basic admin/coordinator page to view and filter submissions.
- **Out of scope for this round** (this is the real content of `how-neiist-works.md` §4-5, and
  it is real, wanted work — just not this PR): dual approval (coordinator + board) with
  outcome per team, self-service interview scheduling, decision emails, onboarding token,
  `@neiist.pt` address reservation. Each needs its own plan when we get there — the data model
  below is shaped so none of it is precluded later.
- **Prerequisite decision, not yet executed:** renaming five `neiist.departments` rows to match
  this year's team names. See "Prerequisite" section — needs your explicit go-ahead before I
  write any DDL.

## What I verified, and how (so this isn't more of what the coordinator flagged)

- **The Google Form** (`.../1FAIpQLSf_XLoqJ2crdiySnrlIUzvna4V-QHBHDeSfhpCfh27DVIfdKQ/viewform`),
  opened live in Chrome, read field-by-field, not submitted. Full data model in "The Google
  Form" section below.
- **`docs/ai-workflow/how-neiist-works.md` §4-5** — the product owner's own words on dual
  approval and self-service interviews. This is why those are explicitly deferred, not
  forgotten.
- **The archived old-fork plan** (`archive/fase-1:.claude/plans/recruitment-and-onboarding.md`,
  653 lines) — read in full. Excellent data-modelling reasoning (per-team outcome as a child
  row, editions as explicit rows, token hashing, address tombstoning) that I'm reusing where it
  still applies. Its *architecture* (workspace permissions, `internal_events`,
  `docker/migrations/`) does not exist in this codebase and none of it is assumed below.
- **Current architecture**, read directly, not recalled: `src/lib/security/permissions.ts`
  (`canManageDepartment`), `src/lib/security/routePermissions.ts` (route tiers + the
  public-route trap), `docker/schema.sql` (`neiist_app_user` has zero table grants — everything
  goes through a function), `src/app/[locale]/team-management/page.tsx` (the existing
  coordinator-scoping pattern — filtered in the page, not in SQL), `src/app/api/shop/orders/`
  (the existing list+detail+status-transition pattern I already live-tested this session),
  `src/lib/db/errorMapper.ts` (plain message-substring matching, not the old fork's NEI-codes),
  `src/types/fenix.ts` (what Fenix actually hands back), `packages/ui/src/components` (41
  components available).
- **Notion**: searched (`Recrutamento`, `Recruiting`, `NEIIST`, `candidatura`, `Núcleo Estudantil
  Informática`) — nothing. The connected workspace is your personal one (ERASMUS, thesis notes),
  not a NEIIST team workspace. Confirmed with you — nothing further exists there beyond what
  `how-neiist-works.md` already captured and the Form itself shows.
- **Upstream**: `main` is even with `upstream/main`, and upstream has no recruitment code. No
  collision risk with what the coordinator is porting.

---

## The Google Form (source of truth for the data we collect)

**Page 1 — team selection**
- Up to 3 team checkboxes, each with a description paragraph: External Relations, Human
  Resources, Dev-Team, Marketing (sub-branch), Photography (sub-branch), Design (sub-branch),
  Logistics. ("Marketing & Design" is a section header for 3 separate checkboxes, not one team.)
- "Queres ficar no nosso radar?" Sim/Não (Sim is the default) — waitlist opt-in if none of the
  chosen teams have room.

**Page 2 — "Queremos conhecer-te melhor!"**
- Nome (first + last only)
- IST-ID (`IST1XXXXXXX`)
- Email Preferencial
- Número de Telemóvel
- Campus: Alameda / Taguspark
- Curso: LEIC/MEIC or free text ("Other")
- Ano: 1º–5º
- Experiência prévia (optional free text)
- Porque queres juntar-te ao NEIIST? (motivation, required)
- "Para além das aulas e do código, o que te apaixona?" (personality question, required)

No file upload anywhere. No per-team follow-up questions beyond the page-1 checkbox — one
motivation answer covers all chosen teams.

**What Fenix login removes from this list entirely:** Nome, IST-ID, Email institucional, Curso
are all in `FenixPersonResponse` (`src/types/fenix.ts`) and get pre-filled, read-only or
edit-if-different. What's left to actually type: Campus, Ano, Telemóvel (Fenix's phone field is
often empty in practice), Experiência, Motivação, "o que te apaixona", and the team picker. This
is the real UX win over the Form, not a cosmetic one.

---

## Prerequisite: the team-name mismatch

`neiist.departments` (current, seeded in `docker/init.sql`): **Contacto, Controlo & Qualidade,
Dev-Team, Divulgação, Fotografia, Organização de Eventos, Visuais.**

The Form (this year's actual branding, per Tomás): **External Relations, Human Resources,
Dev-Team, Marketing, Photography, Design, Logistics.**

Tomás confirmed the Form's names are the *current* ones and the database is what's stale. He
also confirmed he wants to keep the English names (not build a mapping layer) and expects the DB
will need updating — just unsure about timing.

**My recommendation: rename now, before writing any recruitment code against these names.**
Building recruitment against a temporary EN→PT mapping table, then deleting that mapping later,
is strictly more work than renaming once — and it's the exact "translation step between the
value authorized and the value written" bug class this project has already been burned by once
(#180, per the archived plan) and again this session (the duplicate-function-overload drift).
One source of truth, used everywhere, from the start.

**Proposed mapping** (please confirm — misassigning an existing coordinator's team is the
failure mode I most want to avoid):

| current (`neiist.departments.name`) | → new name |
|---|---|
| Contacto | External Relations |
| Controlo & Qualidade | Human Resources |
| Divulgação | Marketing |
| Fotografia | Photography |
| Visuais | Design |
| Organização de Eventos | Logistics |
| Dev-Team | *(unchanged)* |

**How it's safe to do** (checked — no `ON UPDATE CASCADE` on any of the four FKs into
`departments.name`, so a naive `UPDATE departments SET name = ...` fails immediately against
existing `teams`/`valid_department_roles`/`membership`/`department_role_order` rows): a new
`neiist.rename_department(old_name, new_name)` function that inserts the new department +
`teams` row first, repoints every dependent row from old → new, then deletes the old rows —
never touching FK deferrability, never touching who's a member of what. One new function, human
approval needed (`CLAUDE.md` §9), applied standalone the same way `mark_order_paid` was. I
grepped `src/` and `docker/init.sql`: nothing outside the DB hardcodes these Portuguese names as
literal strings, so this is a data-only change, no UI code to touch except `docker/init.sql`
itself (for future fresh databases).

**If you'd rather defer this:** recruitment ships with the EN names hardcoded as the canonical
list in the application code (not stored as a mapping — the recruitment tables would just use
department names that don't match `neiist.departments` yet, which breaks the "team_name is a FK"
integrity the rest of the schema relies on). I don't recommend this. Say so if you want it
anyway and I'll design around it instead.

---

## Data model

```sql
-- One row per recruitment window. Explicit, not a hardcoded date — Direção opens/closes it,
-- no deploy needed. NEIIST already runs more than one edition a year ("1ª Fase 26/27" implies
-- a 2ª), so this is a real table, not a single settings row.
CREATE TABLE IF NOT EXISTS neiist.recruitment_editions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),       -- '1ª Fase 26/27'
  opens_at   TIMESTAMPTZ NOT NULL,
  closes_at  TIMESTAMPTZ NOT NULL,
  created_by VARCHAR(10) REFERENCES neiist.users(istid),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT edition_closes_after_opens CHECK (closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS neiist.applications (
  id                 SERIAL PRIMARY KEY,
  edition_id         INT NOT NULL REFERENCES neiist.recruitment_editions(id) ON DELETE RESTRICT,
  applicant_istid    VARCHAR(10) NOT NULL REFERENCES neiist.users(istid),
  -- Fenix name/email/course are the source of truth and can change; we snapshot what the
  -- applicant saw and confirmed at submission time, same reasoning as an order's customer_name.
  name               TEXT NOT NULL CHECK (btrim(name) <> ''),
  email              TEXT NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  phone              TEXT NOT NULL,
  campus             TEXT NOT NULL CHECK (campus IN ('Alameda', 'Taguspark')),
  course             TEXT NOT NULL,
  curricular_year    SMALLINT NOT NULL CHECK (curricular_year BETWEEN 1 AND 5),
  prior_experience   TEXT CHECK (prior_experience IS NULL OR length(prior_experience) <= 2000),
  motivation         TEXT NOT NULL CHECK (length(motivation) <= 3000),
  fun_fact           TEXT NOT NULL CHECK (length(fun_fact) <= 1000),
  wants_waitlist     BOOLEAN NOT NULL DEFAULT TRUE,
  -- manual tracking only this round — no automated pipeline yet (see "deferred")
  review_status      TEXT NOT NULL DEFAULT 'new'
                      CHECK (review_status IN ('new', 'contacted', 'archived')),
  review_note        TEXT CHECK (review_note IS NULL OR length(review_note) <= 2000),
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_application_per_edition
  ON neiist.applications (edition_id, applicant_istid);
CREATE INDEX IF NOT EXISTS idx_applications_edition ON neiist.applications (edition_id, submitted_at);

-- The per-team child row — kept from day one even though nothing writes an "outcome" to it yet,
-- because it's the join surface every later slice (approval, interviews, decisions) hangs off,
-- and adding it later would mean an application-shaped migration instead of one column's worth.
CREATE TABLE IF NOT EXISTS neiist.application_teams (
  application_id  INT NOT NULL REFERENCES neiist.applications(id) ON DELETE CASCADE,
  department_name VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),
  PRIMARY KEY (application_id, department_name)
);
CREATE INDEX IF NOT EXISTS idx_application_teams_by_team ON neiist.application_teams (department_name);
```

Why no `outcome`/`status` machine on `application_teams` yet: nothing in this round *decides*
anything, so a decision column with only one possible value (`pending`) is dead weight — easy to
add as slice B's own migration line, per `CLAUDE.md` §4's "add a column" pattern being
standalone-safe.

Why `review_status` lives on `applications` and not per-team: this round's admin view is "has
Direção looked at this person yet", not a per-team decision — that distinction is exactly what's
deferred.

## Functions (all `SECURITY DEFINER`, `neiist_app_user` has no table grants — matches
`neiist_app_user` reality already verified)

| function | notes |
|---|---|
| `neiist.get_open_recruitment_edition()` | one row or none, `NOW() BETWEEN opens_at AND closes_at`. Public read (no auth needed — the apply page checks this before showing the form at all). |
| `neiist.submit_application(...)` | inserts `applications` + N `application_teams` rows in one call. Raises on: no open edition, 1–3 teams required, a department not `active`/`department_type='team'`, duplicate (`applicant_istid`, `edition_id`) → the unique index's `23505`, already mapped by `errorMapper.ts`. |
| `neiist.get_recruitment_pipeline(u_istid, edition_id)` | admin/coordinator scoped exactly like `get_user_tasks` was meant to be, except — matching the *current* codebase's actual pattern (`team-management/page.tsx`) — I'd fetch broadly and scope in the page/component, not in SQL, for consistency with how this repo already does it. Flagging this as a real choice below, not assuming it silently. |
| `neiist.set_application_review_status(id, status, note, actor_istid)` | the only "write" the admin page does this round. |
| `neiist.create_recruitment_edition(name, opens_at, closes_at, actor_istid)` | admin-only, opens a new window. |

New `errorMapper.ts` entries (plain message matching, the pattern this codebase actually uses —
not NEI-codes):
- `"No open recruitment edition"` → 409, "As candidaturas não estão abertas de momento."
- `"Application requires 1 to 3 teams"` → 400
- `"department is not an active team"` → 400
- the existing `23505` → 409 handler already covers the duplicate-application case for free.

### One real design choice to flag, not bury

`team-management/page.tsx` scopes coordinator visibility **in the page**, by fetching
memberships/roles broadly and filtering in TypeScript. The archived plan scoped it **in SQL** via
a function parameterised on the caller. For *this* data — candidate names, phone numbers, email —
I'd rather match the stricter old-plan approach than the existing team-management shape: a
`get_recruitment_pipeline(u_istid, ...)` that returns only rows the caller may see, so a bug in
the page component can't leak a candidate's phone number to a coordinator who wasn't supposed to
see it. This is the one place I'm deliberately *not* copying the closest existing pattern, and I
want that decision visible rather than something you find later in a diff. Tell me if you'd
rather I match `team-management`'s shape for consistency instead.

---

## Pages and routes

### Public: `/[locale]/recruitment` (or `/candidatura` — naming below)

- Added to `publicRoutes`? **No** — it needs to know who's logged in (to pre-fill and to attach
  `applicant_istid`), so it belongs in `guestRoutes` (`hasRequiredRole` already allows `_GUEST`
  there) exactly like `/profile` and `/shop/checkout` — logged out → proxy sends to Fenix login
  → back here. This avoids the exact public-route trap the archived plan flagged (`proxy.ts`
  denies unlisted paths to authenticated users but allows them to anonymous ones — the opposite
  problem from a page that must require login).
- If no edition is open: an empty-state page ("candidaturas fechadas, volta em breve"), not a
  404 — someone will link this page on Instagram before an edition opens.
- If the caller already has an application for the open edition: redirect to a "já te
  candidataste" confirmation view instead of a second form (the DB unique index is the backstop,
  this is the UX front line).
- Form itself: multi-step using `@neiist/ui`'s `Tabs` or a simple two-`Card` step (matching the
  Form's own two-page shape, which candidates already know) — `MultiSelect` for team choice
  (capped at 3, client-validated + server-enforced), `Field`/`Input`/`Textarea`/`Select`/`Radio`
  for the rest, `Button` for submit, `Alert` for the closed/already-applied states.
- Visual direction: the Form's pixel-art "escolhe o teu personagem" banner is a nice hook but is
  a Forms-hosted asset (temporary signed URL, not something to hardlink) — I'd rather build the
  hero using this site's actual design tokens (`@neiist/ui/tokens.css`, the same blue as the
  `nei[ist]_` logo mark you already use everywhere) than import a Google-Forms-native visual
  style wholesale. If you have the original artwork file (Visuais/Design team likely made it),
  send it over and I'll use it as a real asset instead of recreating the vibe from a screenshot.

### Admin/coordinator: `/[locale]/recruitment/manage` (or similar)

- `coordRoutes` tier (admin + coordinator), matching `/team-management`'s access tier.
- List view: `Table`, filterable by team/campus/course/year/review_status — same shape as the
  `/orders` admin page I already tested live this session (search box, filter dropdowns, click a
  row → `Modal` with full detail).
- Detail modal: full application, the chosen teams, a `review_status` dropdown +
  `review_note` field (manual tracking, no automated transitions, no emails — as agreed).
- Admin also gets a small "abrir nova edição" action (name + opens_at + closes_at) — otherwise
  nobody can turn recruitment on without a developer touching the database, which defeats the
  point of leaving Google Forms.

### Naming: `/recruitment` vs `/candidatura`

Every other route in this app is an English noun (`/shop`, `/voting`, `/team-management`) even
though the UI text is Portuguese-first — I'd default to `/recruitment` and
`/recruitment/manage` for consistency with that, not `/candidatura`. Flagging in case you have a
reason to prefer the Portuguese path.

---

## i18n

New `recruitment` section in `src/i18n/locales/{pt,en}.json` — team descriptions copied from the
Form (already written, no need to reinvent them), all the form field labels, empty/closed states,
admin table headers. `JoinUs.tsx`'s `apply_link` stops being an external URL and becomes an
internal `Link` to `/recruitment` — one-line change, same component.

## Rate limiting

`src/lib/security/rateLimitRules.ts` gets a `/api/recruitment/` rule — tighter than the default
60/min, `useUser: true` like `/api/admin/` (the caller is authenticated, so limiting per-user
makes more sense than per-IP), something like 5 submissions/hour is generous for a real
applicant and stops a compromised session from hammering the endpoint.

## Validation

`validateIstId`, `isValidEmail`, `isValidPhone` already exist in `apiValidationUtils.ts` and
cover 3 of the 4 fields that need it; team-count (1–3) and required-field checks are new but
small, same shape as the existing validators.

## What "tested" means here (this repo has no test runner)

Live, in the browser, with a real Fenix session, same method I used this session for the order
status-transition fix:
1. Submit a real application through the public form, confirm it lands correctly via the admin
   list, confirm the detail modal shows every field accurately.
2. Confirm the duplicate-application block (apply twice in the same edition → rejected).
3. Confirm the closed-edition state (no open edition → form doesn't render, shows the empty
   state).
4. Confirm route protection: logged out → redirected to Fenix login on `/recruitment`; a
   `_MEMBER`-only session → `/recruitment/manage` denies with `/unauthorized`, same as
   `/team-management` already does.
5. Clean up every test application/edition created, same as every other live-test this session.

## Rollout shape

Given the size, I'd split this the way the last 10 fixes were split — small, reviewable PRs, not
one large one:
1. **Department rename** (if you confirm it) — its own tiny PR, DB-only, before anything else.
2. **Schema + functions** (`recruitment_editions`, `applications`, `application_teams` +
   the 5 functions) — needs your approval per `CLAUDE.md` §9 before I write the DDL, same as
   `mark_order_paid`.
3. **Public application page** — the biggest slice, the actual "candidatar-se no site" ask.
4. **Admin review page** — depends on 2 and 3 existing.

---

## Open questions for you

1. ~~**Department rename**~~ — **confirmed 2026-09-16: rename now**, using the mapping table
   above. Still needs the DDL written and applied as its own small PR before anything else.
2. ~~**`get_recruitment_pipeline` scoping**~~ — **confirmed 2026-09-16: SQL-scoped.** The
   function takes the caller's istid and returns only what they may see; candidate PII never
   reaches the browser for a team the caller doesn't coordinate. This is now the one place this
   feature deliberately doesn't copy `team-management`'s shape — noted above, not hidden.
3. ~~**Route naming**~~ — **confirmed 2026-09-16: `/recruitment` for both locales**, matching
   every other route in the app (`/shop`, `/voting`, `/team-management` don't change per
   locale either — only the content does). Per-locale URL slugs stay a possible future
   improvement, not part of this work.
4. ~~**The banner artwork**~~ — **confirmed 2026-09-16**: Tomás supplied the real source files
   (`visuais_recrutamento/`), placed at `src/assets/recruitment/banner.png` (the wide Forms
   banner) and `src/assets/recruitment/teams-poster.png` (the Instagram post), matching the
   existing `src/assets/<feature>/` convention (`import x from "@/assets/recruitment/..."`,
   rendered with `next/image`, same as `about-us/page.tsx`'s `teamImage`). The Instagram poster
   turned out to have real value beyond the banner: **one pixel-art character card per team**
   (Logistics/yellow, Dev Team/green, HR/pink, Marketing & Design/purple, External
   Relations/teal), each with its own mascot — a much better source for the team-picker UI than
   generic icons. "Marketing & Design" is drawn as one card for Instagram, but the Form still
   splits it into 3 real checkboxes (Marketing/Photography/Design) — the card art can be the
   umbrella visual for that group without changing the underlying 3-team data model. Cropping
   the individual cards out of the composite poster is an implementation detail for later.
5. ~~**"Experiência prévia"**~~ — **confirmed 2026-09-16**: keep as-is, revisit later if it
   turns out unused.

## Explicitly deferred, not decided against: candidate-editable form questions

Tomás asked whether the núcleo could later edit the application form itself — add questions,
make some conditionally appear ("only show this box once they click X"). That's real and
reasonable, but it's a **form-builder**: a question schema, dynamic rendering, conditional
visibility rules — on its own roughly the size of the rest of this plan, not a checkbox to add
now. Not building it this round. What I *will* do so it isn't foreclosed: keep `applications`'
fixed columns as the fixed columns the Form has always had (name/email/phone/campus/course/
year/motivation/fun_fact), and if a real "extra questions" feature gets planned later, it's an
additive `application_answers(application_id, question_key, value)` table sitting *beside* the
fixed columns, not a rewrite of them — same "don't invent infrastructure speculatively, but
don't paint the current work into a corner" balance as everything else in this plan.

**All five open questions resolved 2026-09-16.** Plan is final. Execution follows the rollout
shape above: department rename first (own PR, DDL shown for explicit sign-off before it's
applied anywhere, even locally), then schema + functions, then the public page, then the admin
page.
