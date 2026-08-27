import Calendar from "@/components/activities/Calendar";
import { isFrameworkSignal } from "@/lib/errors/frameworkSignal";
import {
  getActivitiesEventsFromDb,
  getAllInternalEvents,
  getMemberInternalEvents,
  getPublicInternalEvents,
  internalEventToCalendarEvent,
  publicEventToCalendarEvent,
} from "@/utils/db/eventQueries";
import { isBoardSignatory } from "@/utils/db/recruitmentQueries";
import TeamEventsFilter from "@/components/activities/TeamEventsFilter";
import { syncNotionEventsToDb, isNotionConfigured } from "@/utils/eventsUtils";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { can } from "@/lib/auth/permissions";
import InternalEvents from "@/components/activities/InternalEvents";
import styles from "@/styles/pages/Activities.module.css";

async function getEventsAndSubscriptions() {
  let istid: string | null = null;
  let isAdmin = false;

  const perm = await serverCheckRoles([]); // authenticate
  if (perm.isAuthorized && perm.user) {
    istid = perm.user.istid;
    isAdmin = perm.roles?.includes(UserRole._ADMIN) ?? false;
  }

  let events = await getActivitiesEventsFromDb();

  // The public calendar now has two sources (#129 slice C): `neiist.activities`, which the Notion
  // sync fills, and public events created in the workspace. Both are read from the database —
  // this page no longer depends on Notion at request time for anything a *student* sees.
  //
  // Merged here rather than in a SQL view because the Notion sync deletes rows it does not
  // recognise, and a UNION would put workspace events in its path. The two tables stay
  // independent until Phase 10 (#137) retires the sync.
  const publicWorkspaceEvents = (await getPublicInternalEvents()).map(publicEventToCalendarEvent);

  // An empty table triggers a sync from Notion. That is a third-party call inside a page
  // render, so it must not be able to take the page down: an unconfigured, rate-limited or
  // unreachable Notion should leave the calendar empty, not return a 500 for the whole route.
  //
  // This was not hypothetical — on a database with no events yet, `/activities` returned 500
  // with Notion's `invalid_request_url`, because DATABASE_ID was unset and the error escaped
  // the render.
  if (events.length === 0 && isNotionConfigured()) {
    try {
      await syncNotionEventsToDb();
      events = await getActivitiesEventsFromDb();
    } catch (error) {
      // Neither call above can throw a framework signal today — one is a Notion request, the
      // other a database read. The re-throw is here so that stays true if a line is added: the
      // rule is "no blanket catch on a Server Component path swallows a digest" (#111, #153),
      // and a rule with an exception is one people stop checking.
      if (isFrameworkSignal(error)) throw error;

      console.error("[activities] Notion sync failed; rendering without synced events:", error);
    }
  }

  events = [...events, ...publicWorkspaceEvents];

  const signedUpEventIds = istid
    ? events.filter((event) => event.subscribers?.includes(istid)).map((event) => event.id)
    : [];

  return { events, signedUpEventIds, istid, isAdmin, roles: perm.roles ?? [] };
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ eventId?: string; equipas?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const { events, signedUpEventIds, roles, istid } = await getEventsAndSubscriptions();
  const urlSelectdEventID = params.eventId || undefined;

  // Authorized BEFORE fetching, not filtered after. An internal meeting must never enter the
  // response payload for a caller who may not see it — filtering in the component would put it
  // there and rely on the client not to render it (#127).
  // Reads the database, not Notion (#129 slice C). Narrower than what it replaced: the Notion
  // view showed every team's internal events to anyone holding `activities.viewInternal`, which
  // predates the team boundary #183 established. Now a member sees their own teams' events —
  // including any reached through a temporary grant, since the SQL goes through
  // `get_user_team_scopes`.
  //
  // Still authorized BEFORE fetching, not filtered after: an internal meeting must never enter
  // the response payload for a caller who may not see it (#127).
  const mayViewInternal = Boolean(istid) && can(roles, "activities.viewInternal");

  // The board can widen this to every team (#241). Asked BEFORE fetching, and the answer decides
  // which query runs — `getAllInternalEvents` is unscoped and returns other teams' owner-only
  // meetings, so it must never be reachable by anyone else.
  //
  // A URL parameter rather than client state on purpose: the widening is an authorization
  // decision, and keeping it in the request means the server decides what to fetch. A checkbox
  // that filtered an already-fetched list would have put every team's meetings in the payload of
  // someone who may not see them, which is the mistake #127 records.
  const isBoard = istid ? await isBoardSignatory(istid) : false;
  const wantsAllTeams = isBoard && params.equipas === "todas";

  const internalEvents = !mayViewInternal
    ? []
    : wantsAllTeams
      ? await getAllInternalEvents()
      : // `true`: the calendar is navigated backwards, so it needs past events too. The list
        // panel below still shows only what is upcoming — filtered from this same fetch rather
        // than queried twice.
        await getMemberInternalEvents(istid!, true);

  // Merged into the calendar rather than living only in the list below it. A member's meetings are
  // part of their week; keeping them in a separate panel meant the calendar showed a student's
  // view of NEIIST to somebody who is running it.
  //
  // Public workspace events are already in `events` via `publicEventToCalendarEvent`, so a public
  // event would otherwise appear twice — once from each source. Excluded by id.
  const alreadyOnCalendar = new Set(events.map((event) => event.id));
  const internalCalendarEvents = internalEvents
    .map((event) => internalEventToCalendarEvent(event, { showTeam: wantsAllTeams }))
    .filter((event) => !alreadyOnCalendar.has(event.id.replace("internal-", "workspace-")));

  const calendarEvents = [...events, ...internalCalendarEvents];

  // The panel under the calendar is "what is coming", so it keeps the old horizon. Filtered from
  // the fetch above rather than asking the database a second time.
  // Current visibility per calendar id, so the modal can show the right value without a fetch.
  // Only workspace events have one.
  const visibilityById = Object.fromEntries(
    internalEvents.map((event) => [`internal-${event.id}`, event.visibility])
  );

  const upcomingInternalEvents = internalEvents.filter(
    (event) => new Date(event.startsAt).getTime() >= Date.now() - 86_400_000
  );

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>
        <span className={styles.primary}>Ati</span>
        <span className={styles.secondary}>vi</span>
        <span className={styles.tertiary}>da</span>
        <span className={styles.quaternary}>des</span>
      </h1>
      {isBoard ? <TeamEventsFilter showingAllTeams={wantsAllTeams} /> : null}
      <Calendar
        events={calendarEvents}
        signedUpEventIds={signedUpEventIds}
        initialSelectedEventId={urlSelectdEventID}
        canSetVisibility={isBoard}
        visibilityById={visibilityById}
      />
      {upcomingInternalEvents.length > 0 && <InternalEvents events={upcomingInternalEvents} />}
    </div>
  );
}
