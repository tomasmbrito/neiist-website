import {
  CalendarEvent,
  EventSubscriber,
  DbActivityRow,
  mapDbRowToCalendarEvent,
  ActivityProperties,
  ActivityEvent,
  NotionEvent,
} from "@/types/events";
import { db_query, type Querier } from "@/utils/db/dbClient";
import type { EventVisibility } from "@/types/eventVisibility";

export const updateActivitiesEvent = async (
  activity: Partial<ActivityEvent> & { id: string }
): Promise<void> => {
  await db_query(`SELECT neiist.update_activities($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
    activity.id,
    activity.title,
    activity.description,
    activity.url,
    activity.location,
    activity.type,
    activity.teams,
    activity.attendees,
    activity.start,
    activity.end,
    activity.allDay,
    activity.lastEditedTime,
  ]);
};

export const signUpToEvent = async (eventId: string, istid: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.sign_up_to_event($1, $2)", [eventId, istid]);
    return true;
  } catch (error) {
    console.error("Error subscribing to event:", error);
    return false;
  }
};

export const removeSignUpFromEvent = async (eventId: string, istid: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_sign_up_from_event($1, $2)", [eventId, istid]);
    return true;
  } catch (error) {
    console.error("Error unsubscribing from event:", error);
    return false;
  }
};

export const updateActivityProperties = async (
  properties: Partial<ActivityProperties> & { eventId: string }
): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.update_activity_properties($1, $2, $3, $4, $5, $6)", [
      properties.eventId,
      properties.signupEnabled ?? false,
      properties.signupDeadline,
      properties.maxAttendees,
      properties.customIcon,
      properties.description ?? null,
    ]);
    return true;
  } catch (error) {
    console.error("Error updating activity properties:", error);
    return false;
  }
};

export const getEventSubscribers = async (eventId: string): Promise<EventSubscriber[]> => {
  try {
    const { rows } = await db_query<EventSubscriber>(
      "SELECT * FROM neiist.get_event_subscribers($1)",
      [eventId]
    );
    return rows;
  } catch (error) {
    console.error("Error fetching event subscribers:", error);
    return [];
  }
};

export const getActivitiesEventsFromDb = async (): Promise<CalendarEvent[]> => {
  const { rows } = await db_query<DbActivityRow>(`SELECT * FROM neiist.get_all_activities()`);
  return rows.map(mapDbRowToCalendarEvent);
};

export const deleteActivitiesEvent = async (id: string): Promise<void> => {
  await db_query(`SELECT neiist.delete_activities($1)`, [id]);
};

/** An internal event or meeting owned by a team (#129). */
export type InternalEvent = {
  id: number;
  kind: "event" | "meeting";
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  /** Kept in step with `visibility` by a trigger until #137 removes it. Prefer `visibility`. */
  isPublic: boolean;
  /** Who can see it (#219). `is_public` was only ever two of these four. */
  visibility: EventVisibility;
  /** False when this team is a collaborator rather than the owner — it is not theirs to delete. */
  isOwner: boolean;
  createdByIstid: string;
  createdByName: string;
  locations: string[];
  attendeeCount: number;
};

/**
 * Create an event or meeting with its locations and attendees, atomically.
 *
 * **Errors throw.** The SQL function raises NEI14/NEI15 with messages written for the person who
 * hit them; a `catch { return null }` here would collapse "the end date is before the start" into
 * an indistinguishable falsy value, and the route would answer a generic 500. Most of this file
 * still swallows — that is the thing to stop doing, not to copy.
 *
 * Takes an optional trailing `Querier` so Phase 3 (requerimentos) can compose this inside a larger
 * `withTransaction` without a second implementation.
 */
export const createInternalEvent = async (
  input: {
    kind: "event" | "meeting";
    name: string;
    description?: string | null;
    startsAt: string;
    endsAt?: string | null;
    isPublic: boolean;
    departmentName: string;
    createdByIstid: string;
    locations?: string[];
    attendees?: string[];
  },
  q: Querier = db_query
): Promise<number> => {
  const { rows } = await q<{ create_internal_event: number }>(
    `SELECT neiist.create_internal_event(
       $1::TEXT, $2::TEXT, $3::TEXT, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6::BOOLEAN,
       $7::VARCHAR(30), $8::VARCHAR(50), $9::TEXT[], $10::VARCHAR(50)[]
     )`,
    [
      input.kind,
      input.name,
      input.description ?? null,
      input.startsAt,
      input.endsAt ?? null,
      input.isPublic,
      input.departmentName,
      input.createdByIstid,
      input.locations ?? [],
      input.attendees ?? [],
    ]
  );
  return rows[0].create_internal_event;
};

/**
 * One team's events and meetings.
 *
 * There is deliberately **no "all events" reader** in this slice. Every function that touches
 * `internal_events` takes a department and filters on it, so a caller cannot receive another
 * team's internal meetings by forgetting a filter — the structural half of the `is_public`
 * boundary, asserted by a test that introspects `pg_proc`.
 */
export const getTeamInternalEvents = async (departmentName: string): Promise<InternalEvent[]> => {
  const { rows } = await db_query<{
    id: number;
    kind: "event" | "meeting";
    name: string;
    description: string | null;
    starts_at: string;
    ends_at: string | null;
    is_public: boolean;
    visibility: EventVisibility;
    is_owner: boolean;
    created_by_istid: string;
    created_by_name: string;
    locations: string[];
    attendee_count: number;
  }>("SELECT * FROM neiist.get_team_internal_events($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPublic: row.is_public,
    visibility: row.visibility,
    isOwner: row.is_owner,
    createdByIstid: row.created_by_istid,
    createdByName: row.created_by_name,
    locations: row.locations,
    attendeeCount: Number(row.attendee_count),
  }));
};

/**
 * Which team owns this event.
 *
 * Read before any mutation so authorization runs against the **row's real owner**, never a
 * department name supplied in the request — that substitution is the IDOR shape.
 */
export const getInternalEventOwner = async (eventId: number): Promise<string | null> => {
  const { rows } = await db_query<{ get_internal_event_owner: string | null }>(
    "SELECT neiist.get_internal_event_owner($1::INT)",
    [eventId]
  );
  return rows[0]?.get_internal_event_owner ?? null;
};

/** Delete an event. Errors throw, as above. */
export const deleteInternalEvent = async (eventId: number): Promise<void> => {
  await db_query("SELECT neiist.delete_internal_event($1::INT)", [eventId]);
};

/** One event in full, for its detail page (#129 slice B). */
export type InternalEventDetail = InternalEvent & {
  agenda: string | null;
  minutes: string | null;
};

export type EventAttendee = {
  userIstid: string;
  userName: string;
  response: "invited" | "accepted" | "declined" | "attended";
};

export type EventDocument = {
  id: number;
  kind: "plano" | "relatorio" | "ata" | "other";
  title: string;
  url: string;
};

export type RelatedEvent = {
  id: number;
  name: string;
  kind: "event" | "meeting";
  startsAt: string;
};

/**
 * One event, **keyed by id AND department**.
 *
 * The department is not decoration: passing an id alone would be an object reference with no
 * tenancy check, leaving the caller to compare the owner afterwards and to remember to. A
 * mismatched pair simply returns `null` here, so the IDOR case fails closed at the query rather
 * than at whoever wrote the route.
 */
export const getInternalEventDetail = async (
  eventId: number,
  departmentName: string
): Promise<InternalEventDetail | null> => {
  const { rows } = await db_query<{
    id: number;
    kind: "event" | "meeting";
    name: string;
    description: string | null;
    agenda: string | null;
    minutes: string | null;
    starts_at: string;
    ends_at: string | null;
    is_public: boolean;
    created_by_istid: string;
    created_by_name: string;
    locations: string[];
  }>("SELECT * FROM neiist.get_internal_event_detail($1::INT, $2::VARCHAR(30))", [
    eventId,
    departmentName,
  ]);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    agenda: row.agenda,
    minutes: row.minutes,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPublic: row.is_public,
    createdByIstid: row.created_by_istid,
    createdByName: row.created_by_name,
    locations: row.locations,
    // The detail reader (013) predates #219 and does not select these. Sensible defaults rather
    // than widening that function here: the detail page shows one event whose team is already
    // known, so neither field changes what it renders. #219's follow-up can add them properly.
    visibility: row.is_public ? "public" : "teams",
    isOwner: true,
    // The detail page lists attendees individually, so the count is redundant there.
    attendeeCount: 0,
  };
};

export const getEventAttendees = async (
  eventId: number,
  departmentName: string
): Promise<EventAttendee[]> => {
  const { rows } = await db_query<{
    user_istid: string;
    user_name: string;
    response: EventAttendee["response"];
  }>("SELECT * FROM neiist.get_event_attendees($1::INT, $2::VARCHAR(30))", [
    eventId,
    departmentName,
  ]);
  return rows.map((row) => ({
    userIstid: row.user_istid,
    userName: row.user_name,
    response: row.response,
  }));
};

export const getEventDocuments = async (
  eventId: number,
  departmentName: string
): Promise<EventDocument[]> => {
  const { rows } = await db_query<EventDocument>(
    "SELECT * FROM neiist.get_event_documents($1::INT, $2::VARCHAR(30))",
    [eventId, departmentName]
  );
  return rows;
};

export const getEventRelations = async (
  eventId: number,
  departmentName: string
): Promise<RelatedEvent[]> => {
  const { rows } = await db_query<{
    id: number;
    name: string;
    kind: "event" | "meeting";
    starts_at: string;
  }>("SELECT * FROM neiist.get_event_relations($1::INT, $2::VARCHAR(30))", [
    eventId,
    departmentName,
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    startsAt: row.starts_at,
  }));
};

/** Agenda and minutes. Errors throw — NEI14/NEI15 carry messages meant to be read. */
export const updateEventNotes = async (
  eventId: number,
  agenda: string | null,
  minutes: string | null
): Promise<void> => {
  await db_query("SELECT neiist.update_event_notes($1::INT, $2::TEXT, $3::TEXT)", [
    eventId,
    agenda,
    minutes,
  ]);
};

export const setEventAttendance = async (
  eventId: number,
  istid: string,
  response: EventAttendee["response"]
): Promise<void> => {
  await db_query("SELECT neiist.set_event_attendance($1::INT, $2::VARCHAR(50), $3::TEXT)", [
    eventId,
    istid,
    response,
  ]);
};

export const removeEventAttendee = async (eventId: number, istid: string): Promise<void> => {
  await db_query("SELECT neiist.remove_event_attendee($1::INT, $2::VARCHAR(50))", [eventId, istid]);
};

export const addEventDocument = async (
  eventId: number,
  kind: EventDocument["kind"],
  title: string,
  url: string
): Promise<number> => {
  const { rows } = await db_query<{ add_event_document: number }>(
    "SELECT neiist.add_event_document($1::INT, $2::TEXT, $3::TEXT, $4::TEXT)",
    [eventId, kind, title, url]
  );
  return rows[0].add_event_document;
};

export const removeEventDocument = async (documentId: number): Promise<void> => {
  await db_query("SELECT neiist.remove_event_document($1::INT)", [documentId]);
};

/** Relate two events. The function normalises the pair, so callers need not know the ordering. */
export const relateEvents = async (eventA: number, eventB: number): Promise<void> => {
  await db_query("SELECT neiist.relate_events($1::INT, $2::INT)", [eventA, eventB]);
};

export const unrelateEvents = async (eventA: number, eventB: number): Promise<void> => {
  await db_query("SELECT neiist.unrelate_events($1::INT, $2::INT)", [eventA, eventB]);
};

/** A public event, as the students' calendar needs it (#129 slice C). */
export type PublicInternalEvent = {
  id: number;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  /** Last change, so the calendar sync can tell an edited event from an unchanged one (#129 D). */
  updatedAt: string;
  locations: string[];
};

/** What a member sees of their own teams' events on /activities. */
export type MemberInternalEvent = {
  id: number;
  kind: "event" | "meeting";
  name: string;
  departmentName: string;
  startsAt: string;
  endsAt: string | null;
  isPublic: boolean;
  /** #219's four levels. Carried so the calendar can offer the control to whoever may change it. */
  visibility: EventVisibility;
  locations: string[];
};

/**
 * The public calendar's view of workspace events.
 *
 * **The only function in the codebase that reads `internal_events` without a department**, and it
 * earns that by filtering `WHERE is_public` in SQL. The introspection test in
 * `internalEvents.test.ts` allows exactly this shape and fails on anything else, so adding a
 * second unscoped reader is a test failure rather than a silent leak.
 */
export const getPublicInternalEvents = async (): Promise<PublicInternalEvent[]> => {
  const { rows } = await db_query<{
    id: number;
    name: string;
    description: string | null;
    starts_at: string;
    ends_at: string | null;
    updated_at: string;
    locations: string[];
  }>("SELECT * FROM neiist.get_public_internal_events()");

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    updatedAt: row.updated_at,
    locations: row.locations,
  }));
};

/**
 * Upcoming events for the teams this member belongs to.
 *
 * Scoped through `get_user_team_scopes`, so temporary grants (#184) are honoured without this
 * function knowing they exist. Narrower than the Notion view it replaces, on purpose — see the
 * migration comment.
 */
export const getMemberInternalEvents = async (
  istid: string,
  /**
   * The calendar needs the past; the "próximos eventos" list does not. Defaults to the list's
   * behaviour so the existing caller is unaffected (#241).
   */
  includePast = false
): Promise<MemberInternalEvent[]> => {
  const { rows } = await db_query<{
    id: number;
    kind: "event" | "meeting";
    name: string;
    department_name: string;
    starts_at: string;
    ends_at: string | null;
    is_public: boolean;
    visibility: EventVisibility;
    locations: string[];
  }>("SELECT * FROM neiist.get_member_internal_events($1::VARCHAR(50), $2::BOOLEAN)", [
    istid,
    includePast,
  ]);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    departmentName: row.department_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPublic: row.is_public,
    visibility: row.visibility,
    locations: row.locations,
  }));
};

/**
 * Every internal event, for the board's "all teams" filter (#241).
 *
 * **Unscoped, and therefore only safe because of where it is called.** Unlike
 * `getPublicInternalEvents`, which earns its lack of a department parameter by filtering
 * `WHERE visibility = 'public'`, this returns everything — including a team's `owner`-only
 * meetings. `/activities` calls it only when `isBoardSignatory` says so.
 *
 * A second call site must repeat that check. There is no guard inside the function, on purpose:
 * re-deriving "is this person the board" there would be the same rule in two places, and #185 is
 * about that rule living in exactly one.
 */
export const getAllInternalEvents = async (): Promise<MemberInternalEvent[]> => {
  const { rows } = await db_query<{
    id: number;
    kind: "event" | "meeting";
    name: string;
    department_name: string;
    starts_at: string;
    ends_at: string | null;
    is_public: boolean;
    visibility: EventVisibility;
    locations: string[];
  }>("SELECT * FROM neiist.get_all_internal_events()");

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    departmentName: row.department_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isPublic: row.is_public,
    visibility: row.visibility,
    locations: row.locations,
  }));
};

/**
 * A team event in the shape the calendar speaks (#241).
 *
 * The id is prefixed `internal-` so it cannot collide with a public workspace event
 * (`workspace-<id>`) or a Notion-synced activity, and so the calendar can tell at a glance which
 * kind of thing it is holding — the styling and the visibility control both depend on that.
 *
 * The team name goes in `location` rather than the title: the title is what a member scans, and
 * "Reunião Organização de Eventos — Organização de Eventos" reads badly. For the board's all-teams
 * view the team is the thing they are looking for, so it is prefixed there instead.
 */
export const internalEventToCalendarEvent = (
  event: MemberInternalEvent,
  options: { showTeam?: boolean } = {}
): CalendarEvent => ({
  id: `internal-${event.id}`,
  summary: options.showTeam ? `${event.departmentName} · ${event.name}` : event.name,
  description: undefined,
  location: [event.departmentName, ...event.locations].filter(Boolean).join(" · ") || undefined,
  start: { dateTime: event.startsAt },
  end: { dateTime: event.endsAt ?? event.startsAt },
});

/**
 * A workspace event rendered as a calendar entry, so `/activities` can show one list.
 *
 * The public calendar has two sources during the migration: `neiist.activities`, which the Notion
 * sync fills, and workspace events. Merging in the adapter rather than in SQL keeps the two
 * tables independent — the Notion sync deletes rows it does not recognise, and a UNION view would
 * put workspace events in its path.
 *
 * The `workspace-` id prefix matters: `neiist.activities` ids are Notion page ids, and a bare
 * integer could collide with one. It also makes the source obvious in the DOM while both exist.
 */
export const publicEventToCalendarEvent = (event: PublicInternalEvent): CalendarEvent => ({
  id: `workspace-${event.id}`,
  summary: event.name,
  description: event.description ?? undefined,
  location: event.locations.join(", ") || undefined,
  start: { dateTime: event.startsAt },
  end: { dateTime: event.endsAt ?? event.startsAt },
});

/**
 * A public workspace event in the shape the Google Calendar sync already speaks (#129 slice D).
 *
 * Adapting to `NotionEvent` rather than teaching `syncEventToCalendar` a second type. That
 * function carries real logic — date handling, the meeting/attendee rule, the stable Google id,
 * update-versus-insert against what is already on the calendar — and a parallel implementation
 * for workspace events would be a second place for all of it to drift. The Notion shape is that
 * sync's de facto interface, so this converts to it and the sync stays one path.
 *
 * `lastEditedTime` carries `updated_at`, which the sync stores and compares to decide whether an
 * existing entry needs rewriting. Without it, editing an event in the workspace would leave a
 * stale entry on every member's calendar forever.
 *
 * `public: true` is safe *because of where these come from*: `getPublicInternalEvents()` filters
 * `WHERE is_public` in SQL and is the only unscoped reader. It is set explicitly rather than left
 * to a default so the sink's own filter (#202) still has a value to act on.
 */
export const publicEventToNotionShape = (event: PublicInternalEvent): NotionEvent => ({
  // Prefixed: `neiist.activities` ids are Notion page ids and both sources reach the same
  // calendar, so a bare integer could collide with one.
  id: `workspace-${event.id}`,
  title: event.name,
  date: event.startsAt,
  end: event.endsAt,
  url: "",
  location: event.locations,
  // "Event", never "Meeting": syncEventToCalendar only includes a Meeting when the user is one of
  // its attendees, and these are public events that belong on every member's calendar.
  type: "Event",
  teams: [],
  attendees: [],
  lastEditedTime: event.updatedAt,
  public: true,
});

/**
 * Re-exported so server code has one import for events (#219).
 *
 * The definitions live in `src/types/eventVisibility.ts` and MUST stay there: they are needed by
 * `TeamEvents.tsx`, a `"use client"` component, and importing a *value* from this module drags
 * `db_query` and therefore `pg` into the browser bundle. That broke `yarn build` with seven
 * "Can't resolve 'dns'" errors pointing only at the component.
 */
export {
  EVENT_VISIBILITY,
  VISIBILITY_LABELS,
  visibilityRank,
  type EventVisibility,
} from "@/types/eventVisibility";

/** Add or remove a collaborating team. Errors throw — a silent no-op would be worse than a 400. */
export const setEventCollaborator = async (
  eventId: number,
  departmentName: string,
  add: boolean
): Promise<void> => {
  await db_query("SELECT neiist.set_event_collaborator($1::INT, $2::VARCHAR(30), $3::BOOLEAN)", [
    eventId,
    departmentName,
    add,
  ]);
};

/** Every team that can see this event: the owner, plus collaborators. */
export const getEventTeams = async (
  eventId: number,
  askingDepartment: string
): Promise<string[]> => {
  const { rows } = await db_query<{ department_name: string }>(
    "SELECT * FROM neiist.event_teams($1::INT, $2::VARCHAR(50))",
    [eventId, askingDepartment]
  );
  return rows.map((row) => row.department_name);
};

/** Set an event's visibility. The trigger keeps `is_public` in step until #137 removes it. */
export const setEventVisibility = async (
  eventId: number,
  visibility: EventVisibility
): Promise<void> => {
  await db_query("SELECT neiist.set_event_visibility($1::INT, $2::neiist.event_visibility_enum)", [
    eventId,
    visibility,
  ]);
};
