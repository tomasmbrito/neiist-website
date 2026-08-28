# The event lifecycle — Plano · Requerimentos · Relatório

> Written 2026-08-28 after reading the Notion Requirements database, all five brief templates, and
> the Organização de Eventos Google Drive end to end. It answers one architectural question —
> **what belongs in the website and what stays in Drive** — and then plans the build.
>
> Companion to [`requerimentos-plan.md`](requerimentos-plan.md), which covers the briefs in detail.

---

## 1. The question

NEIIST runs an event in three documents:

```
Plano de Atividades   →   the event   →   Relatório
   (before)                (during)        (after)
        └── Requerimento de Visuais / Divulgação / C&Q / Contacto / Fotografia
```

Today the middle exists in the website (#129, #219, #232, #242) and both ends live in Google Drive
as `.docx`. So: move them in, leave them out, or something else?

---

## 2. The decision

> **The website owns the process. Drive owns the files.**

- **In the website**: the Plano, the requerimentos, the to-dos, the approvals, the Relatório.
  Anything with an owner, a deadline, a status, or a "who has to do this next".
- **In Drive**: artwork, photographs, PDFs, signed documents. Anything that is a *file*.
  **One folder link per event**, held on the event.

Not a compromise — it follows from what these documents actually contain.

### 2.1 Why: they are forms, not documents

The strongest argument for leaving them in Drive would be that they need rich editing. They do not.
Here is the entire content of a real Plano de Atividades (Linux Install Party, Feb 2026):

```
Local: Alameda [LE3]; Oeiras [1.2?]     Data: dd-02-2026   Hora: 00h00
Coordenador:
Colaboradores Responsáveis: Francisco Plácido, Guilherme Carreira, Tiago Santos
Objetivo(s)      — two paragraphs of prose
Estrutura        — "---"   (empty)
Comunicação Externa:  Oradores Convidados [Nome 1] [Nome 2] · Outros [Empresa/Patrocínio]
Comunicação Interna:  Equipa de Visuais --- · Divulgação --- · Fotografia -- · Membros NEIIST --
# To Dos         — six lines, each "task — person"
```

Two paragraphs of prose and a to-do list. That is a form that happens to be a `.docx` because the
template was one. The Relatório is the same shape: eight labelled fields, two of them prose, two of
them Drive links.

### 2.2 Why: the Relatório is mostly already known

This is the finding that decides it. By the time an event ends, the website **already holds most of
the Relatório**:

| Relatório field | Where the website already has it |
|---|---|
| Data de Execução, Local | the event (`internal_events`, `event_locations`) |
| Divulgação e canais | the **Divulgação requerimento's** channel checklist |
| Organizadores específicos | the Plano's *colaboradores responsáveis* |
| Nº de participantes | `event_attendees`, or `activities_sign_up` for public events |
| Fotografias do Evento | the **Fotografia requerimento's** deliverable |
| Imagem do cartaz | the **Visuais requerimento's** deliverable |
| Descrição, Avaliação, Observações | the only genuinely new writing |

Today somebody retypes all of that from memory, weeks later, which is why reports get written late
or not at all. In the website the Relatório is **three prose boxes on a pre-filled page.** That is
not a migration of a document; it is the removal of most of the work.

### 2.3 Why not Drive-with-integration

Tempting, and wrong here. The website would have to parse `.docx` to know anything — who owes what,
which deadline has passed, whether the poster is done. Every feature we want (an inbox, a queue,
progress) needs *structure*, and a document is exactly the shape that does not have it.

The friction is already visible in Drive: Linux Install Party's files are still called
`ReqVisuais - Linux Install Party - DataEvento.docx` — the placeholder never replaced, in a file
edited three times over two months. That is what copy-a-template produces, and no integration fixes
it.

### 2.4 What Drive keeps, and why that is right

Drive is genuinely better at files: versioning, previews, big images, sharing with people outside
NEIIST. Artwork and photographs stay there.

The website holds **one `drive_folder_url` on the event**. Not a URL per requerimento — the
evidence says deliverables land in the event folder, and `Material Link` in Notion is empty on
**0 of 7** requerimentos precisely because per-requerimento links are more bookkeeping than anyone
will do.

`requirement_deliverables` (already built, #232) stays for the specific artefact a team wants to
point at — "here is the final poster" — as a convenience over the folder, never a replacement.

### 2.5 What stays in Notion/Drive by design

`Reserva de Espaços IST`, `Pedidos Divulgação IST`, `AGA 44`, the year archives. Standing procedures
and history, not per-event process. Tier C in #126, and #137 keeps them there deliberately.

---

## 3. The model

```
internal_events                       (exists)
  drive_folder_url                    ← NEW: the one link to Drive

event_plans                           ← NEW  (#247)
  event_id, objetivo, estrutura,
  coordinator_istid, created_by, updated_at
event_plan_collaborators              ← NEW: colaboradores responsáveis
event_plan_externals                  ← NEW: oradores, patrocínios, parceiros
event_plan_todos                      ← NEW: task, assignee, done, requirement_id?
                                            └── raising a requerimento IS a to-do

requirements                          (exists, #232)
requirement_checklist                 (exists, #242)
requirement_brief_fields              ← NEW  (#233)
requirement_deliverables              (exists)

event_reports                         ← NEW  (#249)
  event_id, descricao, avaliacao, observacoes,
  participantes, organizacao, photos_url,
  submitted_by, submitted_at
```

### 3.1 Three rules the model must hold

**R1 — Derive, never retype.** The Plano does not store local/data/hora; those are the event's. The
Relatório does not store the channels; those are the Divulgação requerimento's. Every field that
exists elsewhere is *rendered* from there, with an override only where the artwork genuinely differs
(a poster may say 16:00 when the event runs 15:45–18:00).

**R2 — A to-do that means "raise a requerimento" links to the requerimento it produced.**
`event_plan_todos.requirement_id` is the join. Before: an open to-do assigned to a person. After:
a live requerimento with its own checklist. One thing, two states — not two lists of the same
intent, which is the current problem.

**R3 — Everything is team-scoped in SQL, like the rest of #126.** A plan belongs to the event's
owning team; collaborating teams (#219) can read it, because a poster designer needs the objetivo.
A third team gets nothing from the `WHERE` clause, not from a route remembering.

---

## 4. The slices

| # | What | Depends on |
|---|---|---|
| **#247** | **Plano de Atividades** — objetivo, estrutura, colaboradores, externals, to-dos | — |
| #250 | `drive_folder_url` on the event, surfaced everywhere the event appears | — |
| #233 | the five typed briefs | #242 ✅ |
| #234 | approval gates publication (decided 2026-08-27) | #232 ✅ |
| #235 | inboxes and the "approved but unpublished" queue | #234 |
| **#249** | **Relatório** — pre-filled from the event, plan and requerimentos | #247, #233 |
| #243 | the team page: 7 panels, 13 sequential queries | alongside |

### 4.1 Ordering, and why

**#247 first.** It is the layer everything hangs off. Building briefs before it means the plan and
the requerimentos stay two lists of the same intent — the exact duplication this whole exercise is
removing. R2 only works if the plan exists first.

**#249 last.** It is the payoff and it needs the others: the pre-fill in §2.2 is worthless until the
briefs (#233) hold the channels and the deliverables.

**#243 alongside, not after.** The team page already renders seven panels; adding a plan, a report
and briefs to a single scroll makes it unusable. The event *detail* page is where the plan and
report belong, which relieves some of the pressure — but the team page still needs sectioning.

---

## 5. What this replaces

When #247, #233 and #249 are done, an event runs entirely in the website:

```
1. Organização de Eventos creates the event                      (exists)
2. …writes the Plano: objetivo, estrutura, who is responsible    #247
3. …adds to-dos: "reserva de espaços — Guilherme"                #247
4. …adds "requerimento de visuais — Guilherme", which BECOMES
   the requerimento when he raises it                            #247 + #232
5. Visuais fills the brief, ticks the checklist, delivers        #233 + #242
6. Divulgação publishes once approved                            #234
7. After the event, the Relatório is three boxes on a page that
   already knows the rest                                        #249
```

Notion's Events, Tasks and Requirements databases become read-only at that point — which is #137,
and the reason it is blocked on exactly these slices.
