# Plan: Dual-approval decisions, interview scheduling, and decision emails

## Scope

This is the round `.claude/plans/recruitment-applications.md` deliberately deferred — the rest
of `docs/ai-workflow/how-neiist-works.md` §4-5, straight from the product owner:

- **§4 — dual approval.** A team's coordinator *and* at least one Direção member must both
  accept before an acceptance/rejection email goes out for that team. A candidate can be
  accepted by one team and rejected by another independently.
- **§5 — self-service interview scheduling.** A coordinator publishes open time slots; once a
  candidate is worth interviewing, they pick a slot themselves; the slot locks automatically;
  confirmation emails go to both the candidate and the coordinator.

**Confirmed with Tomás, 2026-09-16 — who counts as "Direção" for the board-side approval:**
active membership in the `Direção` department (any role — Presidente, Vice-Presidente, Vogal,
Diretor de Atividades Alameda/Taguspark) **plus the Dev-Team coordinator**, deliberately, so he
can help quickly — "é quase como se ele também fosse da direção." This is **not** the same
check as `is_admin` used elsewhere in recruitment: Diretor de Atividades holds `access =
'coordinator'` in `valid_department_roles`, not `admin`, so a plain admin check would wrongly
exclude him. Needs its own `is_recruitment_board_member(istid)` check.

**Explicitly still out of scope, proposed to defer again:** the onboarding token,
`@neiist.pt` address reservation, and the admin screen for addresses waiting to be created in
Google Workspace (the old plan's slices D/E). Tomás's message that started this round asked
about interview scheduling and email specifically — nothing about onboarding. Flagged as an
open question below in case that's wrong.

## What's already there to build on

- `neiist.applications` / `neiist.application_teams` — the per-team child row exists precisely
  so this slice is an additive column set, not a migration of the table (see the original
  plan's reasoning, still holds).
- `neiist.get_recruitment_pipeline(u_istid, edition_id)` — already scopes reads by
  admin/coordinator; needs to also return each team's decision state, not just its name.
- `src/lib/email.ts` — `sendEmail({to, subject, html})` + a `getXTemplate()` per email, the
  exact pattern to copy (see `getOrderStatusUpdateTemplate` for a status-driven template).
  **Nothing in recruitment sends email yet** — this is the first slice that does.
- `canManageDepartment` (`src/lib/security/permissions.ts`) — already the "is this person a
  coordinator of this specific department" check; the coordinator side of the approval reuses
  it directly, no new logic needed there.

## Data model

```sql
-- Per-team decision state. Two independent sides, each own actor + timestamp. Outcome is
-- computed in queries (CASE WHEN both accepted THEN 'accepted' WHEN either rejected THEN
-- 'rejected' ELSE 'pending' END), never stored — a stored third column that must be kept in
-- sync with the two decision columns is exactly the kind of bug class worth not creating.
ALTER TABLE neiist.application_teams
  ADD COLUMN IF NOT EXISTS coordinator_decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (coordinator_decision IN ('pending', 'accepted', 'rejected')),
  ADD COLUMN IF NOT EXISTS coordinator_decided_by VARCHAR(10) REFERENCES neiist.users(istid),
  ADD COLUMN IF NOT EXISTS coordinator_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS board_decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (board_decision IN ('pending', 'accepted', 'rejected')),
  ADD COLUMN IF NOT EXISTS board_decided_by VARCHAR(10) REFERENCES neiist.users(istid),
  ADD COLUMN IF NOT EXISTS board_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_email_sent_at TIMESTAMPTZ; -- guards against a double-send

-- Self-contained — no dependency on a general "events" system (none exists in this codebase;
-- internal_events was archived-and-removed this same week). A coordinator publishes slots for
-- their own team; a candidate books one for a team they actually applied to.
CREATE TABLE IF NOT EXISTS neiist.interview_slots (
  id                  SERIAL PRIMARY KEY,
  department_name     VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),
  coordinator_istid   VARCHAR(10) NOT NULL REFERENCES neiist.users(istid),
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  location            TEXT,
  booked_application_id INT REFERENCES neiist.applications(id) ON DELETE SET NULL,
  booked_at           TIMESTAMPTZ,
  CONSTRAINT interview_slot_ends_after_starts CHECK (ends_at > starts_at)
);
-- A slot can be booked by at most one application; an application can hold at most one slot
-- per team (nothing stops the same candidate double-booking two different teams' interviews,
-- which is correct — they applied to up to 3 teams).
CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_slot_booking
  ON neiist.interview_slots (booked_application_id) WHERE booked_application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interview_slots_team ON neiist.interview_slots (department_name, starts_at);
```

### Functions

| function | notes |
|---|---|
| `is_recruitment_board_member(u_istid)` | the Direção-or-Dev-Team-coordinator check above. `LANGUAGE sql STABLE`, reused everywhere board-side authorization is needed. |
| `add_interview_slot(department_name, coordinator_istid, starts_at, ends_at, location)` | authorization: `canManageDepartment`-equivalent check inside SQL (mirrors the pattern already in `get_recruitment_pipeline`/`set_application_review_status` — a coordinator for that team, or an admin). |
| `remove_interview_slot(slot_id, actor_istid)` | only the owning coordinator or an admin; raises if already booked (cancel the booking first, don't silently orphan a candidate's confirmed slot). |
| `get_interview_slots(department_name)` | all slots (booked and free) for a team — the coordinator's own view. Scoped like the functions above. |
| `get_bookable_interview_slots(application_id, applicant_istid)` | free slots for teams *this specific application* applied to. Ownership-checked (the caller's istid must match `applicant_istid`), so a candidate only ever sees slots for their own application. |
| `book_interview_slot(slot_id, application_id, applicant_istid)` | `FOR UPDATE` lock on the slot row, same idea as `neiist.new_order`'s stock check — two candidates racing the same slot cannot both win it. Verifies the application belongs to the caller and applied to that slot's team. Returns the booked slot; the API route sends both confirmation emails after. |
| `cancel_interview_booking(slot_id, actor_istid)` | either the candidate who booked it or the owning coordinator/admin; frees the slot. |
| `set_team_decision(application_id, department_name, side, decision, actor_istid)` | `side` is `'coordinator'` or `'board'`. Authorization branches on `side` (coordinator check vs. `is_recruitment_board_member`). Returns the updated row plus whether the decision just became final (both sides non-pending) — the API route sends the decision email only on that transition, and only once (`decision_email_sent_at`). |
| `get_recruitment_pipeline` | **changed**, not new — `teams` becomes an array of objects (`{name, coordinatorDecision, boardDecision, outcome}`) instead of plain names, so the admin/coordinator UI can show decision state per team without a second round-trip. |

### Errors (plain message matching, this codebase's actual pattern)

- slot already booked → 409
- slot not found / doesn't belong to caller's application's teams → 400/404
- decision `side` invalid, or actor lacks that side's authorization → 400/403

## Email templates (new to `src/lib/email.ts`)

- `getInterviewBookedCandidateTemplate` / `getInterviewBookedCoordinatorTemplate` — sent
  together, synchronously, right after `book_interview_slot` succeeds.
- `getApplicationDecisionTemplate(outcome, teamName, ...)` — one shared template branching on
  accepted/rejected copy, sent once per team the moment `set_team_decision` reports the
  decision just became final.

No WhatsApp links, no `@neiist.pt` mention in the acceptance email — both depend on the
deferred onboarding slice. The acceptance email says "aceite" and that follow-up details are
coming, not more than that.

## Pages / UI

- **Coordinator/admin**: extend `RecruitmentPipeline`'s detail dialog — the two decision
  buttons (coordinator side always available to a team coordinator/admin; board side only to
  `is_recruitment_board_member`), and a small "Entrevistas" tab or section per team to publish/
  remove slots and see who booked what. Same component, not a new page — keeps the "one place
  to review a candidate" shape intact rather than scattering decision state across pages.
- **Candidate**: after submitting (or on a later visit while `submitted`), if any applied-to
  team has published slots and the candidate hasn't booked one yet for that team, show a slot
  picker inline on the existing confirmation view (`AlreadyApplied`-equivalent state) instead
  of a new route. Keeps the "one page to apply, one page to see status" shape from the first
  round.

## Slicing

| slice | what | depends on |
|---|---|---|
| **A** | Schema (both new/altered tables), `is_recruitment_board_member`, `set_team_decision`, decision email, extend `get_recruitment_pipeline`'s return shape, wire the two decision buttons into the existing pipeline UI. | nothing new — builds directly on the shipped pipeline. |
| **B** | Interview slots: schema, the 6 slot functions, coordinator slot management UI (in the pipeline detail dialog), candidate slot picker, booking confirmation emails. | A, for the UI it slots into — could technically ship first if you'd rather see interviews before decisions. |

Proposed as two PRs in that order, same size discipline as the last four.

## Open questions for you

1. **Onboarding/`@neiist.pt` still deferred?** Confirming — your message asked about
   interviews and email specifically, nothing about onboarding, so I've scoped this plan to
   stop there. Say so if you actually want that folded in now instead of a third round.
2. **Slot granularity** — fixed-length slots a coordinator publishes one at a time (what's
   modelled above), or a start/end availability window the candidate picks any point within
   (closer to literal Crabfit, more UI work, no clean "double-booking" prevention without
   picking a slot length anyway)? I'd default to fixed slots — simpler, and it's what "the
   slot locks automatically" in your own description implies.
3. **Cancellation notifications** — the plan lets either side cancel a booking but doesn't
   email the other side about it (kept it to the two "básico" emails you'd expect: booked,
   decided). Worth adding, or fine to leave silent for now and add later if it's actually a
   problem in practice?
4. **Decision UI**: should a coordinator/board member be able to *change* a decision after
   setting it (e.g. correct a mis-click) once the other side hasn't voted yet, or is a decision
   final the moment it's set? Leaning toward: editable until the other side also decides, locked
   (only an admin can override) once both sides are in and the email has gone out — since
   un-sending an email isn't possible.

Nothing here gets implemented until you've reviewed this and the board issues below.
