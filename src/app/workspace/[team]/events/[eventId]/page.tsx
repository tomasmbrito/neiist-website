import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeamWorkspace } from "@/utils/permissionUtils";
import { decodeRouteParam } from "@/lib/routeParams";
import { canForTeam, ROLE_LABELS } from "@/lib/auth/permissions";
import {
  getEventAttendees,
  getEventDocuments,
  getEventRelations,
  getInternalEventDetail,
  getTeamInternalEvents,
  getEventTeams,
} from "@/utils/db/eventQueries";
import { getAllDepartments, getAllMemberships } from "@/utils/db/userQueries";
import { groupMembershipsByMember } from "@/types/memberships";
import EventDetail from "@/components/workspace/EventDetail";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * One event or meeting in detail (#129 slice B).
 *
 * `requireTeamWorkspace` runs before anything is fetched, and every query below is keyed by
 * **both** the event id and the team — so an id belonging to another team returns nothing rather
 * than relying on this page to compare owners afterwards.
 */
export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ team: string; eventId: string }>;
}) {
  // Same decoding as the team page — a team name with an accent or a space arrives encoded.
  const { team: rawTeam, eventId: rawId } = await params;
  const team = decodeRouteParam(rawTeam);
  const session = await requireTeamWorkspace(team, "team.workspace.view");

  const eventId = Number(rawId);
  if (!Number.isInteger(eventId) || eventId <= 0) notFound();

  const event = await getInternalEventDetail(eventId, team);
  if (!event) notFound();

  const [attendees, documents, related, memberships, teamEvents, collaborators, departments] =
    await Promise.all([
      getEventAttendees(eventId, team),
      getEventDocuments(eventId, team),
      getEventRelations(eventId, team),
      getAllMemberships(),
      getTeamInternalEvents(team),
      // Keyed by event id *and* team, like every other read here (#126) — an id belonging to
      // another team returns nothing rather than trusting the route to compare owners.
      getEventTeams(eventId, team),
      getAllDepartments(),
    ]);

  // The roster, for the attendee picker. Grouped so someone holding two roles appears once (#8).
  const roster = groupMembershipsByMember(
    memberships.filter((membership) => membership.departmentName === team && membership.isActive)
  ).map((member) => ({ istid: member.userNumber, name: member.userName }));

  const canEdit = canForTeam(session.roles, session.scopes, "team.events.manage", team);
  // #219. Only the owning team decides who helps — a team viewing an event it merely collaborates
  // on cannot add a third. The route re-checks against the owner for the same reason.
  const canSetCollaborators =
    event.isOwner && canForTeam(session.roles, session.scopes, "team.events.collaborators", team);

  return (
    <>
      <header className={styles.header}>
        <nav className={styles.breadcrumb}>
          <Link href="/workspace">Espaço de Trabalho</Link> <span aria-hidden="true">/</span>{" "}
          <Link href={`/workspace/${encodeURIComponent(team)}`}>{team}</Link>{" "}
          <span aria-hidden="true">/</span> {event.name}
        </nav>
        <h1 className={styles.title}>{event.name}</h1>
        <p className={styles.subtitle}>
          {event.kind === "meeting" ? "Reunião" : "Evento"}
          {event.isPublic ? " · público" : " · interno"} · criado por {event.createdByName}
          {canEdit
            ? ""
            : ` — o teu acesso (${ROLE_LABELS[session.scopes.find((s) => s.departmentName === team)?.access ?? "member"]}) é de leitura`}
        </p>
      </header>

      <EventDetail
        team={team}
        event={event}
        initialAttendees={attendees}
        initialDocuments={documents}
        initialRelated={related}
        roster={roster}
        relatableEvents={teamEvents
          .filter((candidate) => candidate.id !== eventId)
          .map((candidate) => ({ id: candidate.id, name: candidate.name }))}
        canEdit={canEdit}
        initialCollaborators={collaborators}
        canSetCollaborators={canSetCollaborators}
        addableTeams={departments
          .filter((d) => d.active && d.name !== team)
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b, "pt"))}
      />
    </>
  );
}
