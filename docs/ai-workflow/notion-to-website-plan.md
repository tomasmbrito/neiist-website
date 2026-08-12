# Bringing NEIIST's Notion operations into the website

**Date:** 2026-08-12
**Status:** proposal — needs Tomás's decision on scope and sequencing
**Source:** direct analysis of the `NEIIST` Notion workspace
(`431e0256-24bb-4c40-b09e-31da8cbb279d`), accessed as tomasmbrito04@gmail.com

> **Access confirmed.** Everything below is read from the live workspace, not inferred.
> Where I could not measure something, it says so explicitly.

---

## 0. Executive summary

NEIIST does not use Notion as a wiki. It uses Notion as **an operations database with a
workflow on top**. There is one master database (`Databases`) with six linked data sources,
a cross-team request protocol ("Requerimentos"), and a task/event graph tying them together.

That workflow is the thing worth moving. It is structured, it is already normalised, it has
real approval steps, and it is currently protected by nothing stronger than "everyone in the
workspace can see and edit everything" — which is how a shared Gmail password ended up sitting
in plaintext on a team home page.

My recommendation, in one line: **do not start this until the order-integrity work
(#78/#79/#80/#100) is done**, because this plan needs transactions and a real permission model,
and both are prerequisites that the current codebase does not have. Reasoning in §10.

---

## 1. Security findings — act on these regardless of the plan

These are live now and do not depend on any migration decision.

| # | Finding | Action |
|---|---|---|
| 1 | **A shared Gmail password is in plaintext** on the *Organização de Eventos* Home page (`eventos.neiist@gmail.com`), visible to every workspace member. | **Rotate the password now.** Move it to a real secret store. Never re-add it to Notion. |
| 2 | The `Members` data source holds **name, Técnico email, personal email, phone, istid** for every member, with no access control beyond workspace membership. | This is personal data under GDPR. It is a reason to move it behind the website's role checks, not a reason to copy it around. |
| 3 | `Recrutamento` holds **interview notes and rejection outcomes** on named candidates ("Não entrou no Núcleo"), same exposure. | Restrict to Coordenação before anything else. |
| 4 | `Encomendas Sweats Verdes` holds **istid + email + payment status** for merch buyers — a second, uncontrolled copy of order data the website already owns. | Strongest single argument for migration: this data should never have left the site. |
| 5 | Team home pages embed **Google Drive links and a Drive-based credential flow** ("pedir acesso aos Coordenadores"). | Replace with role-derived access once the site owns identity. |

Finding 1 is the only one that is an emergency. Do it today.

---

## 2. What is actually in the workspace

### 2.1 Teamspaces

Nine live teamspaces: `General`, `Coord x Dir`, `Dev`, `Organização de Eventos`,
`Divulgação`, `Contacto`, `Controlo e Qualidade`, `Fotografia`, `Archive`.
(`get-teams` reports `hasMore: true`, so this list may be incomplete — one more sweep needed
before migration.) `Visuais` appears everywhere as a team in the data but has no teamspace of
its own in the joined list.

### 2.2 The master database — `Databases`

One Notion database, **six data sources**, all cross-linked. This is the schema to port.

```
Events/Meetings  ──1:N──  Tasks
       │  │  │
       │  │  └──1:N──  Requirements
       │  └─────1:N──  Inflows and Outflows
       └────self-relation "Related Events"

Businesses  ──1:N──  Contacts        (unlinked to Events today)
Members                              (standalone)
```

**`Events/Meetings`** — `collection://24a4ecf9-fdeb-81fb-bb43-000bcc6aa433`

| Property | Type | Values |
|---|---|---|
| Name | title | |
| Type | select | `Meeting` · `Event` |
| Date | date | with time, supports ranges |
| Location | multi-select | `Online` `Alameda` `Tagus` `Externo` `V1.32 (Edifício Civil)` |
| Team | select | Coordenação/Direção · Contacto · Controlo e Qualidade · Divulgação · Visuais · Dev-Team · Fotografia · Organização de Eventos |
| Attendees | person | |
| **Public** | checkbox | **this is already the public/private flag the website needs** |
| Sponsor | multi-select | Cloudflare · Critical Techworks · HackerSchool · Nokia · LAGE2 |
| Related Events | relation (self) | |
| Tasks | relation | |
| Done | formula | derived |

Four page templates: `New Event`, `New Meeting - Coord` (default), `New Meeting - Dev`,
`Reunião Organização de Eventos`.

**`Tasks`** — `collection://2ab4ecf9-fdeb-803c-a76e-000b32a4a1fd`
`Task` · `Assigned To` (person) · `Team` (multi) · `Due Date` · `Event` (relation, max 1) ·
`Status` (`Not Started` / `In Progress` / `Done`)

**`Requirements`** — `collection://2b44ecf9-fdeb-8051-bbf8-000bb0dc004c` — **the centrepiece, see §3**
`Requirement` · `Team` (Fotografia / C&Q / Divulgação / Contacto / Visuais) · `Event` (relation) ·
`Assigned to` · `Deadline` · `Status` · `Material Link` · **`Team Manager Approval`** (checkbox) ·
**`Divulgação`** (checkbox — "has this been published yet") · `Created by` · `Created time`

**`Members`** — `collection://2a34ecf9-fdeb-80e9-9d9e-000b306dda5b`
`Name` · `Position` · `Year` · **`istid` (number)** · `Phone` · `Técnico Email` · `Personal Email`

> `istid` is stored as a **number** here. The website stores it as `VARCHAR(50)` and issues
> synthetic `ext_<uuid>` ids for external users. Any import must treat the Notion value as a
> lossy legacy field — leading zeros are already gone.

**`Contacts`** / **`Businesses`** — a small CRM.
Businesses: `Name` · `Area` (10 industry options) · `Email` · `Website` · `Linkedin` · `Phone` · `Notes`
Contacts: `Name` · `Position` · `Email` · `Phone` · `Linkedin` · `Businesses` (relation) · `Reviewed`

**`Inflows and Outflows`** — `collection://2ac4ecf9-fdeb-803c-b468-000b6c55a4dc`
`Description` · `Value` (number) · `Category` (`Sweats` `Food` `Printing` `Others`) ·
`Event` (relation) · `Paid By` (person) · `Return` (checkbox) · `Absolute Value` (formula)

### 2.3 Standalone databases outside the hub

| Database | Purpose | Notable |
|---|---|---|
| `Recrutamento` | interview pipeline | `Status` 7 stages (Em Agendamento → Entrevista Marcada → Entrevista Feita → Resultado Enviado, plus `Em Ghost`, `Faltou`, `Desafio Feito`), `Resultado` (which team they joined / rejected), `Equipas` applied to, `Mensagem enviada?`. Two edition views filtered by date range (1ª: Sep–Oct 2025, 2ª: Mar 2026). Interview notes live in the page bodies. |
| `Espaços` | venue scouting for Jantar de Curso | `Contacto Realizado` → `Resposta Recebida` → `Visita marcada` → `Relatório da Visita` → `Avaliação Após Visita` (1–5). Files attached. A clean little procurement workflow. |
| `Encomendas Sweats Verdes` | merch orders **outside the shop** | `istid` · `email` · `Order` · `Select` (Pago → Pronto → Contactado → Entregue) · `New Color` (Unanswered/Agrees/Disagrees/Solved). Duplicates what `neiist.orders` should own. |
| `Final Designs` / `Visuais Prontos` | filtered view of Requirements: Team=Visuais, Status=Done, Divulgação=false — i.e. **"approved artwork not yet published"** | A *derived queue*, not new data. Port as a query, not a table. |

### 2.4 Event documentation pattern

Every event has, by convention, a `Plano de Atividades - [Nome]` page before and a
`Relatório - [Nome]` page after. Seen for: Jantar de Curso, Churrasco Tagus, Torneio de
E-Sports, Hackathon, Concurso Layout Sweats, Team Building, Pré-Venda Sweats, Recrutamento.
Plus a `Reserva de Espaços - IST` how-to.

These are **prose documents**, not records. See §8 on why they should stay documents.

---

## 3. The operating model — this is what you are really migrating

The workspace encodes a genuine inter-team protocol. It is worth stating plainly because it,
not the page count, is the requirement:

```
Organização de Eventos creates an Event
        │
        ├── raises a Requerimento to each team it needs:
        │
        │     🎨 Visuais      → artwork in specified formats
        │     📢 Divulgação   → publish to channels
        │     📝 C&Q          → build the signup form
        │     🤝 Contacto     → source sponsors / speakers / catering
        │     📸 Fotografia   → cover the event
        │
        ├── each Requerimento carries: responsible person, deadline,
        │   a team-specific structured brief, and a shared To-do List
        │
        ├── receiving team sets Status and fills in Material Link
        ├── Team Manager Approval  ← an explicit approval gate
        └── Divulgação checkbox    ← marks it actually published
```

**The five briefs are already structured forms.** They are not free text — this is the single
most important finding for building the website version, so they are reproduced in full:

**🎨 Visuais** — Campus · Data · Hora · Sala · Orador · Anfitrião · Organização · Apoio ·
língua (PT/EN/ambas) · briefing (estilo, cores, referências) · mensagem/slogan ·
**format checklist**: Cartaz A3, Cartaz A4, Panfletos, Banner Facebook, Imagem Instagram,
Stories Instagram, **Banner Ecrã Taguspark (needs 15 days notice)**, Google Forms Banner,
RNL PCs, RNL TVs, Senhas, Outros.
Ships with a **dimensions reference table** (A3 3508x4960, Ecrã Tagus 1842x960 bilingual,
Stories 1080x1920, RNL TV 4K, …).

**📢 Divulgação** — data/hora da divulgação · **channel checklist**: WhatsApp LEIC 1/2/3,
WhatsApp MEIC 1/2, Discord LEIC, Discord MEIC, Instagram Story/Publicação/Reels,
LinkedIn, presencial Tagus/Alameda · links (formulário, visuais) · texto da publicação.

**📝 C&Q** — event name/date · form deadline · **inscrição window (abertura/fecho/limite)** ·
intro text · **field checklist**: Nome, Email, Nº Aluno, Curso, Ano, Restrições Alimentares,
custom fields (name/type/options table) · confirmation email text · conditional logic notes.

**🤝 Contacto** — objetivo checklist: Oradores/Formadores, Patrocínio Financeiro,
Coffee Break/Catering, Brindes/Merch, Júri, Outro · target companies or "qualquer empresa da
área de X" · material de apoio · deadline para resposta.

**📸 Fotografia** — evento, data, hora início, local · **shot checklist**: Foto de Grupo,
Sponsors (roll-ups/logos), Oradores/Palco, Ambiente Geral, Outro · observações.

A note from a Coordenação meeting records that **C&Q is shifting towards Recursos Humanos** —
so the C&Q requerimento (form building) may move team, but the workflow shape stands.

---

## 4. Per-team needs, as the website must serve them

| Team | Needs to do on the site | Depends on |
|---|---|---|
| **Coordenação / Direção** | see everything; approve; run meetings with agendas + minutes; oversee budget; manage members and roles | roles, all modules |
| **Organização de Eventos** | create events, raise requerimentos to 5 teams, track their status, plan/report docs, budget lines, venue scouting | events, requerimentos, finance, docs |
| **Visuais** | inbox of artwork requests with format checklist + dimensions guide; upload deliverables; mark done; see the "approved but unpublished" queue | requerimentos, file storage |
| **Divulgação** | inbox with channel checklist; publication scheduling; pull approved artwork; mark published | requerimentos, calendar |
| **Controlo e Qualidade / RH** | build signup forms with custom fields and windows; collect and export inscrições; confirmation emails | **forms engine** (largest new build) |
| **Contacto** | CRM of Businesses + Contacts; sponsorship pipeline per event; track outreach deadlines | CRM module |
| **Fotografia** | shot-list inbox; upload/link galleries; per-event albums | requerimentos, file storage |
| **Dev** | own meetings and tasks; already has a `New Meeting - Dev` template | meetings, tasks |
| **All members** | personal dashboard: my tasks, my team's events, my requerimentos, upcoming meetings | tasks, events, identity |

---

## 5. Target architecture on the website

Everything below sits inside the existing Next.js app, `neiist` Postgres schema, raw SQL via
`pg`, Zod at the API boundary, `apiErrorHandler` for errors — no new stack.

### 5.1 Tiering — what moves, what mirrors, what stays

The instruction was "bring everything". I am planning for everything, but I want the
distinction on the record, because one tier is a bad trade:

- **Tier A — move fully (structured records with a workflow).** Events, Meetings, Tasks,
  Requerimentos, Members, Contacts/Businesses, Finance, Recruitment, Venues, Sweats orders.
  These are databases pretending to be pages. The website is strictly better: real permissions,
  real relations to `neiist.users`, and no second copy of order data.
- **Tier B — mirror, keep Notion as an editor.** Nothing, initially. Dual-write is the main
  way migrations like this fail. Listed only to be explicit that I am *not* proposing it.
- **Tier C — keep in Notion/Drive, link from the website.** Long-form prose:
  `Plano de Atividades`, `Relatório`, meeting minutes bodies, `Reserva de Espaços` how-to,
  onboarding guides, interview notes. **Rebuilding a rich-text collaborative editor is a
  multi-month project with no NEIIST-specific value.** The website should store the *record*
  (which event, which meeting, who attended, decisions taken) and hold a link to the document.
  If you later want them in-house, that is its own epic, not part of this one.

If you want Tier C moved as well, say so and I will plan it — but it roughly doubles the
effort and the thing you get is a worse Notion.

### 5.2 Proposed schema (all new tables, `neiist` schema)

```sql
-- teams and membership -------------------------------------------------
neiist.teams            (id, slug, name, active)
neiist.team_members     (team_id, user_istid → neiist.users, role, joined_at, left_at)

-- events and meetings --------------------------------------------------
neiist.internal_events  (id, kind 'event'|'meeting', name, description,
                         starts_at, ends_at, is_public, owner_team_id,
                         created_by → users, created_at)
neiist.event_locations  (event_id, location)          -- multi: Alameda/Tagus/Online/Externo/…
neiist.event_attendees  (event_id, user_istid, response)
neiist.event_sponsors   (event_id, business_id)       -- replaces the multi-select
neiist.event_relations  (event_id, related_event_id)  -- the self-relation
neiist.event_documents  (event_id, kind 'plano'|'relatorio'|'other', title, url)

-- tasks ----------------------------------------------------------------
neiist.tasks            (id, title, description, status, due_at,
                         event_id NULL, created_by, created_at)
neiist.task_assignees   (task_id, user_istid)
neiist.task_teams       (task_id, team_id)

-- requerimentos (the core workflow) ------------------------------------
neiist.requirements     (id, event_id, requesting_team_id, target_team_id,
                         title, deadline, status,
                         approved_by NULL, approved_at NULL,
                         published_at NULL,               -- the "Divulgação" checkbox
                         created_by, created_at)
neiist.requirement_brief_fields (requirement_id, field_key, value JSONB)
neiist.requirement_checklist    (requirement_id, item, done, done_by, done_at)
neiist.requirement_deliverables (requirement_id, url, uploaded_by, uploaded_at)

-- forms engine (C&Q) ---------------------------------------------------
neiist.forms            (id, event_id, title, intro, opens_at, closes_at,
                         capacity NULL, confirmation_email_body, created_by)
neiist.form_fields      (form_id, position, key, label, type, required, options JSONB)
neiist.form_submissions (id, form_id, user_istid NULL, submitted_at)
neiist.form_answers     (submission_id, field_key, value JSONB)

-- CRM ------------------------------------------------------------------
neiist.businesses       (id, name, area, email, website, linkedin, phone, notes)
neiist.contacts         (id, business_id, name, position, email, phone, linkedin, reviewed)
neiist.outreach         (id, event_id, business_id, objective, status, deadline, owner_istid)

-- finance --------------------------------------------------------------
neiist.ledger_entries   (id, event_id NULL, description, value_cents, category,
                         paid_by_istid, is_return, created_at)

-- recruitment ----------------------------------------------------------
neiist.applications     (id, candidate_name, email, phone, edition,
                         status, outcome, interview_at, message_sent)
neiist.application_teams(application_id, team_id)
neiist.application_notes(application_id, author_istid, body, created_at)  -- restricted

-- venues ---------------------------------------------------------------
neiist.venues           (id, name, contacted, replied, visit_scheduled,
                         rating, notes)
neiist.venue_files      (venue_id, kind 'precario'|'relatorio'|'other', url)
```

Notes on choices:
- `value_cents` as integer, not float. The Notion `Value` is a float; money in the site is
  already cents elsewhere.
- The `Sponsor` multi-select becomes a real FK to `businesses` — Cloudflare, Critical Techworks,
  HackerSchool, Nokia and LAGE2 are companies you already track in the CRM.
- `requirement_brief_fields` is JSONB-per-key rather than five hardcoded tables, because the
  five briefs differ and will keep changing. The **field definitions** live in TypeScript +
  Zod (`src/schemas/requirements/`), one schema per team, so the forms stay typed and
  validated while the storage stays flexible.
- Every multi-select in Notion becomes a join table. No comma-joined strings.

### 5.3 Permission model

This is the part that does not exist yet and gates everything.

```
_GUEST      → public events only
MEMBER      → own tasks, own team's events/requerimentos, member directory
TEAM_LEAD   → + approve requerimentos for their team, assign within team
COORD       → + all teams, finance, recruitment, member management
ADMIN       → + everything
```

Today the site has `_GUEST` / member / coord / admin via `serverCheckRoles` and `requireRoles`.
`TEAM_LEAD` and per-team scoping are **new** and must be built before any of this ships,
otherwise you reproduce Notion's "everyone sees everything" — which is the problem you are
migrating away from.

### 5.4 Calendar and Google

Keep Google Calendar. It is genuinely the right tool for "the whole núcleo sees events in the
app they already have". The direction changes: today Notion is the source of truth and syncs
out. Afterwards **the website is the source of truth** and pushes to Google Calendar
(`googleCalendar.ts` already exists) — public events to the public calendar, internal meetings
to a team calendar. Notion's webhook sync (`api/calendar/notion-webhook`) gets retired at the
end, not the beginning.

---

## 6. Delivery phases

Each phase is a shippable epic. Sizes are relative, not calendar promises.

| Phase | Contents | Size | Gated on |
|---|---|---|---|
| **0. Foundations** | `teams` + `team_members`, `TEAM_LEAD` role, per-team scoping in `requireRoles`, admin UI for team membership | M | transactions (#80) |
| **1. Events & Meetings** | `internal_events` + locations/attendees/relations, create/edit UI, meeting agendas + attendance, `is_public` drives the existing `/activities` page, push to Google Calendar | L | Phase 0 |
| **2. Tasks** | tasks with assignees/teams/due dates, per-event task list, **"My tasks" dashboard** | M | Phase 1 |
| **3. Requerimentos** | the five typed briefs, request → assign → deliver → approve → publish, checklists, deliverable links, per-team inbox, the "approved but unpublished" queue | **XL — split** | Phases 0–2 |
| **4. Forms engine (C&Q)** | form builder, custom field types, open/close windows, capacity, submissions, confirmation emails, CSV export | **XL — split** | Phase 1 |
| **5. CRM & sponsorship** | businesses, contacts, per-event outreach pipeline, sponsors on events | M | Phase 1 |
| **6. Finance** | ledger entries per event, categories, reimbursements, per-event budget rollup | M | Phase 1 |
| **7. Recruitment** | application pipeline, interview scheduling, outcomes, **restricted notes** | L | Phase 0 |
| **8. Venues** | scouting workflow with files and ratings | S | Phase 1 |
| **9. Merch reconciliation** | fold `Encomendas Sweats Verdes` into `neiist.orders`; stop the parallel spreadsheet | M | order integrity done |
| **10. Notion retirement** | archive workspace, retire the Notion webhook, redirect links | S | all above |

Phases 3 and 4 are each large enough that they must be split into stories before work starts —
they are the two that would sink a naive estimate.

---

## 7. Migration of existing data

- **Read-only export first.** Snapshot every data source to JSON before touching anything.
  Notion stays the live system until each phase's cutover.
- **Identity is the hard join.** Notion `person` properties are Notion user IDs; the website
  keys on `istid`. Build an explicit `notion_user_id → istid` mapping table, populate it by
  hand for the ~15–20 active members, and **fail the import loudly on an unmapped user** rather
  than dropping the assignment.
- `Members.istid` is a **number** — reformat to the website's string form, and expect to
  hand-fix any id with a leading zero.
- **No dual-write.** Per module: import → verify → switch → make Notion read-only. A module
  that is half-migrated is worse than either end state.
- Files (venue reports, artwork) currently live in Notion/Drive. Note that
  `public/products` is gitignored and inside the build dir — **do not add more uploads there**
  until that is fixed, or blue/green deploys will eat them.
- **Row counts are unmeasured.** Multi-source SQL needs an Enterprise plan on this workspace,
  so I could not size the tables. Do a single-source count per database before committing to
  an import approach.

---

## 8. What I recommend not doing

1. **Do not rebuild rich-text documents.** Keep `Plano de Atividades`, `Relatório` and meeting
   minutes as linked documents (§5.1, Tier C).
2. **Do not dual-write.** Stated twice on purpose.
3. **Do not start with Phase 3 or 4** because they are the most visible. They depend on
   Phase 0's permission model; built first, they get rewritten.
4. **Do not migrate `Encomendas Sweats Verdes` by copying it.** It is order data that escaped
   the shop. It should re-enter through the shop's own tables, after the order work lands.

---

## 9. Interaction with the existing roadmap

| Existing item | Effect |
|---|---|
| **#78/#79/#80/#100** order integrity | **Hard prerequisite.** Every workflow here is multi-table (event + requerimentos + tasks + ledger). Without transactions you are building new non-atomic writes on purpose. |
| **#72 / Wave 2** data-layer split | **Prerequisite.** ~10 new query modules should be written against `src/utils/db/*`, not appended to a `dbUtils.ts` that is being deleted. |
| **#52** no test runner | Escalates from P1 to **blocking**. This plan roughly doubles the app's surface area. Shipping a forms engine and an approval workflow with zero automated tests is not defensible. |
| **#111** `serverCheckRoles` swallows `DynamicServerError` | Must be fixed first — Phase 0 extends exactly this function. |
| **#124** identity decisions | Now higher-stakes: members will be assignees, approvers and authors across ten tables. Account-linking ambiguity becomes data corruption. |
| **#92** upstream voting system | **Newly relevant.** "Votação Concurso Layout Sweats" is already a Notion workflow. Upstream's voting system is a real candidate to serve it — reassess rather than defer. |
| **#46/#47/#48** ticketing + user dashboard | **Overlaps Phase 2.** The "My tasks / my team" dashboard and #47's profile page are the same page. Merge them. |
| **#49/#50** job board | **Overlaps Phase 5.** Both are a company database. Same `businesses` table. |
| **#19/#20/#21** search & pagination | Promoted. Ten new list views make pagination structural, not cosmetic. |
| **#95** upload hardening, `public/products` | Blocks any deliverable/file upload in Phases 3, 7, 8. |

---

## 10. My recommendation on sequencing

**Finish the current board first. Specifically: Wave 2 (data layer) → order integrity
(#78/#79/#80/#100) → #52 test runner → #111 → then Phase 0 of this plan.**

Three reasons, in order of weight:

1. **This plan's core operations are all multi-table writes, and the codebase cannot express a
   transaction.** "Create event with 5 requerimentos and 12 tasks" is precisely the shape that
   breaks halfway. Building it now means writing a large amount of code that has to be revisited
   the moment #80 lands.
2. **Phase 0 is an extension of the auth code that #111 is about to change**, and per-team
   scoping is a bigger permission change than anything the site has done. Doing it on top of a
   `serverCheckRoles` that is known-broken is how you get a Notion-grade permission model in a
   Postgres-grade database.
3. **The thing you are fixing about Notion is that everyone can see everything.** If the website
   version ships before per-team scoping is real, you have moved the problem, not solved it.

The counter-argument I take seriously: the board is refactoring work with no visible payoff to
the núcleo, and this plan is the first thing that would make members actually use the site.
Morale and momentum are real. So:

**Do these two things in parallel, now, without waiting:**
- **Rotate the Gmail password** (§1) — today, unrelated to everything else.
- **Phase 1 read-only:** surface events and meetings from Notion on the website as a read
  view — no writes, no new tables, using the Notion integration that already exists. It gives
  the núcleo something visible within days, validates the data model against reality, and
  throws nothing away when Phase 1 proper is built.

That gets you visible progress without laying foundations on ground that is about to move.

---

## 11. Open questions for Tomás

1. **Tier C** — do you accept keeping long-form documents in Notion/Drive with the website
   holding the record and the link? Or do you want a full in-house editor (own epic)?
2. **Recruitment notes and Members' personal data** — who exactly should see them? This decides
   the Phase 0 role table, and it is a GDPR question, not a UI one.
3. **C&Q → RH** — the Coordenação minutes say C&Q is becoming Recursos Humanos. Does the forms
   engine follow C&Q, or stay with events?
4. **`Encomendas Sweats Verdes`** — is this still running? If yes, it needs a stopgap before
   Phase 9.
5. **Hosting** — you mentioned local first, then the server. Everything here assumes the
   existing Postgres and deploy path. Blue/green currently loses `public/products`; file
   uploads across Phases 3/7/8 make that a blocker rather than an annoyance.
