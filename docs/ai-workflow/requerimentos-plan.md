# Requerimentos — analysis and plan

> **Read this before touching `#131` or anything under `src/components/workspace/`.**
> Written 2026-08-27 after reading the real Notion protocol end to end. It covers what a
> requerimento actually *is* at NEIIST, what the current workspace gets right and wrong, and how
> the remaining slices should be built. It is meant to be enough for a session that has never seen
> this repository.

---

## 1. What a requerimento is

In Tomás's words:

> *"the Organização de Eventos team is starting to work on an event, and we know we're going to
> need a poster, and a story for instagram, a post too, a tv banner, whatever. so we make a
> requerimento for the visuais team, then if needed we also do a requerimento for the divulgação
> team telling them which channels we want to use, how many times we want to publish something,
> whatever, we can also do it for the Controlo e Qualidade team."*

It is **the protocol by which one team formally asks another for work on a specific event.** Not a
task, not a message: a structured request with a brief, a deadline, an owner on the receiving side,
and a definition of done.

```
Evento (Organização de Eventos)
  ├── 🎨 Requerimento → Visuais       cartaz, story, feed, TV
  ├── 📢 Requerimento → Divulgação    which channels, how many times, the copy
  ├── 📝 Requerimento → C&Q           the signup form
  ├── 🤝 Requerimento → Contacto      speakers, sponsors, catering
  └── 📸 Requerimento → Fotografia    what to photograph
```

This is the centrepiece of the Notion migration (#131) and the thing that makes the workspace worth
using: without it, the website is a calendar and a task list, and the actual coordination stays in
Notion and WhatsApp.

---

## 2. What is really in Notion (measured, 2026-08-27)

Data source `collection://2b44ecf9-fdeb-8051-bbf8-000bb0dc004c`, **7 real requerimentos** across 4
events, plus 5 page templates.

### 2.1 The properties

| Property | Type | Used in practice? |
|---|---|---|
| `Requirement` | title | yes — always the template name, never customised |
| `Team` | select (5 teams) | yes |
| `Event` | relation → Events/Meetings | yes |
| `Assigned to` | person | **1 of 7** |
| `Deadline` | date | 5 of 7 |
| `Status` | Not started / In progress / Done | yes |
| `Team Manager Approval` | checkbox | **0 of 7** |
| `Divulgação` | checkbox | 1 of 7 |
| `Material Link` | url | **0 of 7** |
| `Created by`, `Created time` | system | yes |

**Two of the model's fields are aspirational, not used.** `Team Manager Approval` has never been
ticked, and `Material Link` has never been filled. That is a finding, not a detail — see §5.

### 2.2 The five briefs

Every brief shares a header (**Colaborador Responsável**, deadline) and ends with a shared
**To-do List**, with an explicit instruction in a callout:

> *Para quem faz o requerimento:* no final do ficheiro colocar na To-do List o que se espera
> receber. *Para quem recebe:* ir atualizando a To-do List consoante o que já foi feito.

**🎨 Visuais** — the richest.
- *Dados do Evento*: campus, data, hora, sala, orador, anfitrião, organização, apoio, língua
- *Briefing*: ideias/temas (estilo visual, cores, referências), descrição/mensagens
- *Formatos* (checklist): Cartaz A3, Cartaz A4, Panfletos, Banner Facebook, Imagem Instagram,
  Stories Instagram, **Banner Ecrã Taguspark — requer 15 dias de antecedência**, Google Forms
  Banner, RNL PCs, RNL TVs, Senhas, Outros
- *Guia de Dimensões*: a static 11-row reference table (A3 3508x4960, Stories 1080x1920,
  Banner Ecrã Taguspark 1842x960 **e bilingue**, RNL TVs 4K, …)

**📢 Divulgação**
- Data/hora da divulgação
- *Público-alvo*: WhatsApp LEIC 1/2/3, WhatsApp MEIC 1/2, Discord LEIC/MEIC · Instagram
  Story/Publicação/Reels, LinkedIn · presencial Taguspark/Alameda/outro (+ o que afixar)
- *Links*: formulário, visuais, outros
- *Texto da publicação*

**📝 C&Q**
- Nome e data do evento, data limite para criação do formulário
- *Período de inscrição*: abertura, fecho, limite de inscrições, link de contexto
- *Conteúdo*: texto de introdução; campos (nome, email, número, curso, ano, restrições
  alimentares, outros); **campos personalizados** com nome/tipo/opções
- *Pós-inscrição*: texto do email de confirmação, observações (lógica condicional)

**🤝 Contacto**
- Evento e data
- *Objetivo*: oradores/formadores, patrocínio financeiro, coffee break/catering, brindes/merch,
  júri, outro
- *Quem contactar*: empresas/pessoas específicas, ou **"qualquer empresa da área de X"**
- Material de apoio, deadline para resposta

**📸 Fotografia**
- Evento, data, hora, local
- *O que fotografar*: foto de grupo, sponsors, oradores/palco, ambiente geral, outro
- Observações

### 2.3 What a real one looks like

`Requerimento de Visuais` for the Workshop de Rust (2025-12-03):

- Formatos ticked: Cartaz A3, Imagem Instagram, Stories Instagram, RNL TVs
- To-do List: **the same four items, retyped by hand**
- Briefing filled with a real paragraph about the workshop
- Dados do Evento: campus Taguspark, 03/12/2025, 16:00, sala 1.2, orador Miguel Mendo —
  **all of which already exist on the linked event**
- Status `Done`, `Team Manager Approval` **not ticked**, `Material Link` **empty**

Three duplications visible in that one page, all of which the website can remove:

1. **The formats checklist and the to-do list are the same information**, entered twice by two
   different people.
2. **The event data is copied into the brief** although the requerimento is already linked to the
   event.
3. **"Colaborador Responsável" is a mention in the body** while `Assigned to` is a property.

---

## 3. Google Drive — not yet read

Tomás has Drive folders `Documentos` and `Eventos` in the Organização de Eventos shared drive, with
worked examples of events and requerimentos.

**The connector is attached but its token lacks read scopes** — `search_files` and
`list_recent_files` both return `Request had insufficient authentication scopes`. Nothing was read.

To unblock, re-authorise the Google Drive connector with Drive read access, then a session should
look for:

- how deliverables are actually organised per event (the folder shape), since `Material Link` is
  unused and the files clearly live somewhere
- naming conventions worth mirroring in `requirement_deliverables`
- anything in `Documentos` that is a *template* and belongs alongside the briefs

Until then, **§6 assumes deliverables are links** — which is what slice A already built, and what
the evidence supports.

---

## 4. Where the workspace is today

| | | |
|---|---|---|
| #183 | members-only boundary, `canForTeam`, per-team pages | ✅ |
| #184 | temporary delegable grants | ✅ |
| #129 | events + meetings, agenda, minutes, attendance, documents, relations | ✅ |
| #219 | collaborating teams + four visibility levels | ✅ |
| #130 | tasks and the member dashboard | ✅ |
| #134 | recruitment end to end (form → dual approval → interview → emails → onboarding) | ✅ |
| #210 | 51 Notion events imported | ✅ |
| #241 | team meetings in the calendar, all-teams filter, inline visibility | ✅ |
| #232 | requerimentos: request / assign / deliver lifecycle | ✅ |
| #233 #234 #235 | briefs · approval gates · inboxes | ⬜ |

### 4.1 What slice A got right

- The asymmetry: **the requesting team asks, the target team owns the status.** Either side may
  cancel. Six mutations confirm the guard.
- Raising N requerimentos on one event is atomic.
- A third team cannot reach the row — the `WHERE` clause cannot return it.
- #234's columns already exist, so that slice is additive.

### 4.2 What slice A does not have, and Notion does

- **No checklist.** The Notion protocol's To-do List is how "what is expected" and "what is done"
  are actually communicated. #131 listed `requirement_checklist`; slice A skipped it. This is the
  single biggest gap.
- No briefs, no approval, no inbox — by design; those are B/C/D.
- No notion of *what was requested* beyond a free-text title.

---

## 5. Findings that should change the plan

**F1 — The formats checklist IS the to-do list.** In Notion a requester ticks "Cartaz A3, Stories"
and the doer retypes them as to-dos. In the website, **ticking a brief option should generate the
checklist item**. One source, two views: the requester sees what they asked for, the doer ticks it
off. This collapses §2.3's duplication 1 and makes the brief immediately useful rather than a form
to fill and forget.

**F2 — The event data should be derived, never retyped.** Campus, data, hora, sala, orador already
live on `internal_events` (and `event_locations`). The Visuais brief should *display* them from the
linked event and let the requester override only where the artwork needs something different.
Removes duplication 2, and removes the class of bug where the poster says 16:00 and the event says
17:00.

**F3 — `Team Manager Approval` is unused (0/7).** Before building #234 as specified, ask Tomás
whether the gate is wanted. Two readings:
- *It is aspirational* — the protocol wants it, Notion made it a checkbox nobody remembers, and a
  website that surfaces it in the inbox would make it real.
- *It is dead* — the teams do not work that way and the field should not be ported.

The #217 precedent argues for building it: the dual-approval signature became meaningful precisely
because it was enforced rather than optional. But that was a decision Tomás made explicitly, and
this one has not been made. **Do not guess.**

**F4 — `Material Link` is unused (0/7).** Deliverables are not being recorded in Notion at all;
they are somewhere in Drive. Slice A's `requirement_deliverables` is the right model, but adoption
depends on it being easier than pasting a Drive link into WhatsApp. §3 should be answered before
investing more here.

**F5 — "Banner Ecrã Taguspark requires 15 days notice" is a real constraint** buried in a template.
The website can enforce it: if that format is ticked and the event is fewer than 15 days away, say
so at request time. That is the sort of thing a form can do and a Notion template cannot.

**F6 — The dimensions table is reference material, not data.** 11 rows, identical on every
requerimento. It belongs in the UI next to the format picker, not in a column.

---

## 6. The plan

### 6.1 #233 — the five typed briefs

Storage is **JSONB per key**; definitions are **Zod schemas, one per team**, in
`src/schemas/requirements/`. That split was already decided in #131 and remains right: the briefs
differ and will keep changing, so a column per field means a migration every time Visuais adds a
format — but an unvalidated blob must never reach the database.

- `requirement_brief_fields (requirement_id, field_key, value JSONB)`
- One Zod schema per team, rejecting unknown keys rather than storing them
- **The event data section renders from the linked event** (F2), with per-field override
- **Ticking a format/channel/objective creates a checklist item** (F1)
- **The 15-day rule on Banner Ecrã Taguspark is surfaced at request time** (F5)
- The dimensions table is a static component beside the Visuais form (F6)

### 6.2 #242 — the shared checklist *(new, and it should come before #233)*

`requirement_checklist (requirement_id, item, done, done_by, done_at, source)`.

`source` distinguishes an item generated by a brief option from one typed by hand, so regenerating
a brief does not delete somebody's manual note.

Rules, following the slice A asymmetry:
- The **requesting** team adds and removes items — it is their definition of done
- The **target** team ticks them — it is their work
- Progress (3/4) is what the inbox shows, because "in progress" tells nobody anything

This is small, it is the most-used part of the Notion protocol, and #233 depends on it for F1. It
was in #131's original table list and was dropped from slice A.

### 6.3 #234 — approval and publication gates

**Blocked on a decision from Tomás (F3).** If it goes ahead:
- Only a coordinator of the **target** team approves — not the requester, not the board by default
- Records **who and when**, not a boolean (the #217 precedent)
- `published_at` is independent of both status and approval, because a requerimento can be `done`
  and unapproved, or approved and unpublished, and slice D's queue depends on exactly that
  distinction

### 6.4 #235 — inboxes and the unpublished queue

- Per-team inbox: what we owe, what we are waiting on, by deadline, with checklist progress
- The "approved but unpublished" queue as a **derived query, never a table** — in Notion it is a
  filtered view, and a table would be a second place the truth lives

### 6.5 Ordering

```
#242 checklist  →  #233 briefs  →  #234 gates  →  #235 inboxes
     (small)        (needs F1)      (needs F3)      (needs #234)
```

---

## 7. Integration with the workspace as it stands

**This is the part most likely to go wrong, and it is not about requerimentos.**

`/workspace/[team]` now renders **seven panels** and runs **13 sequential queries**:

```
TeamAccessGrants · TeamRequirements · TeamTasks · TeamApplications
TeamInterviewSlots · TeamOnboarding · TeamEvents
```

Adding briefs, a checklist and an inbox to that page makes it worse, not better. Three things
should happen alongside #233–#235:

**I1 — Sections, not a scroll (#243).** The team page needs a tabbed or sectioned layout: *Equipa ·
Eventos · Requerimentos · Tarefas · Recrutamento · Acessos*. Recruitment in particular is only
relevant a few weeks a year and currently sits between events and tasks all year round.

**I2 — Fetch in parallel (#244).** 13 sequential `await`s on one page. Most are independent;
`Promise.all` is the whole fix. The authorization ordering must survive it — `requireTeamWorkspace`
runs *before* any fetch and must stay that way (#127).

**I3 — One action hook (#245).** The fetch → toast → refresh cycle is written **23 times** across 8
components. A `useWorkspaceAction` hook removes the repetition and, more importantly, makes error
handling uniform: right now each component decides for itself whether to surface the server's
message verbatim, and the ones that do not are the ones where a 403 looks like a network failure.

Also outstanding and now more relevant: **#212** (split the query modules, adopt the UI primitives,
remove inline styles — 4 workspace components still carry `style={{}}`).

---

## 8. What a new session needs to know

- **`canForTeam` is a separate type from `can()`** so a team question cannot be answered globally.
  Membership is `scopes.length > 0`, never "is logged in".
- **The app role has no table privileges.** Every query goes through a `SECURITY DEFINER` function.
  Tests connect as the owner and cannot catch a violation — `appRolePrivileges.test.ts` is the one
  that can.
- **`internal_events` has a `pg_proc` allow-list test.** A new function reading that table fails by
  name until somebody justifies it in writing. Two entries are unscoped;
  `get_all_internal_events` is guarded only at its call site and is the weakest.
- **Every guard gets a mutation pass.** A mutation that does not compile is not a surviving mutant —
  check the mutant applied before believing the result.
- **schema.sql and a migration, always both.** 31 migrations, 7,688 lines of schema.
