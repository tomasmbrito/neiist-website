# How NEIIST actually works

**Written 2026-08-25 from what Tomás told me directly.** Everything here is domain knowledge that
cannot be derived from the code, and several items contradict what the code currently assumes.

Read this before designing anything in the workspace. Where it disagrees with the code, **this
file is right and the code has an open issue.**

---

## 1. The goal is to leave Notion completely

> *"the idea is that once the import is completed and the NEIIST workspace is finished in the
> website, we stop using Notion... we basically want to just rely on the NEIIST website and not on
> Notion anymore, the idea is to have everything centralized in the website."*

This is why the plan is so large. It is not "put some of Notion on the site" — it is a migration
with an end state where Notion is switched off (#137).

**The constraint that comes with it:** Notion is members-only by construction. The website is
public. So every page that moves across has to grow an access rule it never needed before, and
"we'll sort out permissions later" is not available.

---

## 2. Events belong to one team but are worked on by several

> *"The events are managed by the Organização de Eventos team, usually some of the members are
> assigned to each event... this team that starts in the Organização de Eventos (or directly at the
> board for some more important events), can actually grow to other teams — for example if there's
> some poster or story needed we need to add someone from the Visual team and from the Divulgação
> team."*

So an event has:

- **one owner** — usually Organização de Eventos, sometimes the board for bigger events;
- **a set of collaborating teams that grows over time**, as the work needs them.

**The code does not model this yet** (#219). `internal_events.owner_department_name` is a single
column, so a Visuais member brought in to make the poster cannot see the event they are working on.

It also explains a puzzle in the Notion data: 24 of 52 events have no `Team`. They are not
team-less — Notion had no way to express "Organização de Eventos owns this, Visuais is helping".

---

## 3. Event visibility is a choice, not a boolean

> *"in each event the board or the Diretor de Atividades... should be able to choose who can see
> those events (non-members (everyone), just members, or teams (for example Organização de Eventos
> team, or Board team, etc))"*

Four levels, not two:

| level | who sees it |
|---|---|
| everyone | including non-members — the public calendar |
| members | any NEIIST member — **the code cannot express this today** |
| teams | the owner and its collaborators |
| owner | the owning team only |

The missing **members** level is the important one: *"every member should see the Jantar de Curso,
but it is not for the public."* Several of the 24 Notion events are exactly that.

**Who chooses:** the board, or the **Diretor de Atividades (TagusPark / Alameda)**.

### `Coordenador de Eventos` no longer exists

> *"we used to have a Coordenador de Eventos but now we just have the roles Diretor de Atividades
> TagusPark or Diretor de Atividades Alameda"*

If that role is still in `valid_department_roles`, it is stale.

---

## 4. Recruitment needs two approvals, not one

> *"in order for the emails (of rejection or acceptance) to be sent, both the coordinator of that
> team and at least one member of the board should accept their candidatura"*

A single coordinator does **not** decide. The team's coordinator **and** a board member both have
to accept before anything is sent. Tracked in #217, and it is a **prerequisite for the acceptance
email** — the model built in #215 records one outcome per team, which is too permissive the moment
sending exists.

A candidate at interview stage appears in **two places**: on each applied-to team's coordinator
page, and on the board's recruiting page.

---

## 5. Interviews should be self-service, Crabfit-style

> *"the teams coordinators could put their availability in their crabfits, and then when someone
> passes the first part of the candidatura, and goes to mark an interview, it could already show
> the available slots... the person chooses their slot there, and it automatically locks the slot,
> and sends a confirmation email for the person and also sends an email for the coordinator"*

Tracked in #218. Tomás noted the same mechanism would be useful for ordinary meetings — but
recruitment is the first real consumer, so it gets built for that first.

---

## 6. Notion's "Coordenação/Direção" is a visibility marker, not a team

> *"when we say Coordenação/Direção it means that both coordinators and board members have access"*

And specifically:

> *"about what's under Coordenação/Direção in Notion I think all the pages should only be accessible
> by Direção **except Recrutamento**, which should be accessible by Direção and Coordenação"*

So when importing, do not map `Coordenação/Direção` to the `Direção` department and stop there —
it describes *who could see the page*, and the answer differs per page.

---

## 7. Meetings are invite-based

> *"in the website you should be able to create a meeting and select the ones who are invited to
> the meeting, this should appear in those people's calendar on the website"*

`internal_events` + `event_attendees` already support this (#129). What is missing is that
attendees do not yet see meetings on a personal calendar view.

---

## 8. `@neiist.pt` is arriving via Google Workspace

Members will get `@neiist.pt` addresses. The site reserves a unique address when a member is added
(#213); **creating the mailbox in Workspace stays manual** — the Directory API needs admin
credentials with a far larger blast radius than anything the site holds, and it can delete accounts
as well as create them.

---

## What this file is for

Each of these was learned from one sentence in one conversation. None of it is recoverable from the
code, and three items — collaborating teams, the members visibility level, and dual approval —
describe things the code currently gets **wrong**.

If you are about to design something in this area and it is not mentioned here, that is worth
asking about rather than assuming.
