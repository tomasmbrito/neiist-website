import Calendar from "@/components/activities/Calendar";
import { getActivitiesEventsFromDb } from "@/utils/db/eventQueries";
import { syncNotionEventsToDb, isNotionConfigured } from "@/utils/eventsUtils";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { can } from "@/lib/auth/permissions";
import { getInternalNotionEvents } from "@/utils/notion/internalEvents";
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
      console.error("[activities] Notion sync failed; rendering without synced events:", error);
    }
  }

  const signedUpEventIds = istid
    ? events.filter((event) => event.subscribers?.includes(istid)).map((event) => event.id)
    : [];

  return { events, signedUpEventIds, istid, isAdmin, roles: perm.roles ?? [] };
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ eventId?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const { events, signedUpEventIds, roles } = await getEventsAndSubscriptions();
  const urlSelectdEventID = params.eventId || undefined;

  // Authorized BEFORE fetching, not filtered after. An internal meeting must never enter the
  // response payload for a caller who may not see it — filtering in the component would put it
  // there and rely on the client not to render it (#127).
  const internalEvents = can(roles, "activities.viewInternal")
    ? await getInternalNotionEvents()
    : [];

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>
        <span className={styles.primary}>Ati</span>
        <span className={styles.secondary}>vi</span>
        <span className={styles.tertiary}>da</span>
        <span className={styles.quaternary}>des</span>
      </h1>
      <Calendar
        events={events}
        signedUpEventIds={signedUpEventIds}
        initialSelectedEventId={urlSelectdEventID}
      />
      {internalEvents.length > 0 && <InternalEvents events={internalEvents} />}
    </div>
  );
}
