# Plan: Interview confirmation, candidate self-service, discoverability

Round 3. Tracks #302 (epic), #303, #304, #305. Confirmed with Tomás, 2026-09-18:
booking a slot is a request, not a final interview, until the team's coordinator/admin
confirms it; the candidate can edit everything (personal fields, teams, interview) until any
one team has a confirmed interview, at which point the whole application locks read-only.

## #303 — interview confirmation

- `interview_slots` gains `confirmed_at TIMESTAMPTZ`, `confirmed_by VARCHAR(10)`. NULL means
  requested-but-not-confirmed; `booked_at` already marks the request.
- `confirm_interview_booking(slot_id, actor_istid)` — `is_team_coordinator_or_admin`, `FOR
  UPDATE`, raises if not booked or already confirmed.
- `cancel_interview_booking` changes shape (DROP+recreate): adds `was_confirmed` to the
  return row so the API can pick "request declined" vs "confirmed interview cancelled" copy.
- New route `POST /api/recruitment/interview-slots/[id]/confirm`.
- Email copy: booking sends "request received"; confirm sends "confirmed" (reuse
  `getInterviewBookedTemplate` with a `status` param); cancel branches on `wasConfirmed`.
- Coordinator UI: requested-not-confirmed slot shows "Pedido pendente" + Confirmar/Cancelar;
  confirmed shows "Confirmada" + Cancelar only.

## #304 — candidate review/edit + progress

- `get_my_application_full(application_id, applicant_istid)`: full row + `is_locked` (any
  team has a confirmed interview) + per-team JSONB (decision fields + `interview` sub-object
  or null).
- `update_my_application(...)`: same validation as `submit_application`; raises if locked.
  Team diffing: `DELETE ... WHERE department_name NOT IN (new list)` then `INSERT ... ON
  CONFLICT DO NOTHING` — teams that stay keep their decision state; dropped teams free any
  (necessarily unconfirmed) interview slot first.
- New route `PATCH /api/recruitment/applications/[id]/edit`.
- `AlreadyApplied` becomes a real review page: per-team stepper (Submetida → Entrevista
  pendente/confirmada → Resultado), decision badges, interview management (reuses/extends
  the existing booking picker with request semantics from #303), edit toggle revealing the
  same field set as `ApplicationForm`, prefilled, hidden once `is_locked`.
- Sync strategy: client mutations (`fetch` + `router.refresh()`) rather than hand-patched
  local state — the data model got too rich (decisions + interview + lock) for the
  optimistic-patch approach used in #297/#298's simpler UIs.

## #305 — discoverability

- Homepage: new `RecruitmentBanner` component (plain server component, dict-driven like
  `Hero`), rendered only when `getOpenRecruitmentEdition()` returns non-null.
- `UserMenu.tsx`: "A Minha Candidatura" (any logged-in user) → `/recruitment`; "Gerir
  Candidaturas" (`roles: [COORDINATOR, ADMIN]`) → `/recruitment/manage`. Same
  `menuPages`/`getAvailablePages` pattern already used for every other entry.

## Scope boundaries (deliberate, not oversights)

- Locking is gated on **confirmed interview only**, not on decision progress — a candidate
  can in principle withdraw from a team a coordinator already accepted, as long as no
  interview is confirmed yet. Matches the literal instruction; flagged here so it isn't
  "discovered" later as a gap.
- Dropping a team's pending interview request does **not** email the coordinator — silent
  cleanup, to avoid a notification for what is, from the coordinator's side, a request that
  simply stops existing.
- No coordinator-side email/notification fires just because a *request* was made (only
  request-received to the candidate, confirmed to both, cancelled/declined to both) — matches
  this app's existing pattern of no "someone did a thing, go check" pings.
- "Always" review access is scoped to *while the recruitment edition is still open* — the page
  still gates on `getOpenRecruitmentEdition()` first, unchanged from before this round. Once an
  edition closes, `/recruitment` reverts to the closed-state page for everyone, same as today;
  building a cross-edition "see my past applications" view is a materially different, separate
  feature, not implied by this round's request.

## Testing

Same rhythm as #297/#298: throwaway-database functional tests for every new/changed function
before the real local dev DB, then live in the browser with a real Fenix session, using
Tomás's own test application (#4) — reset afterward.
