import {
  CalendarEvent,
  EventSubscriber,
  DbActivityRow,
  mapDbRowToCalendarEvent,
  ActivityProperties,
  ActivityEvent,
} from "@/types/events";
import { db_query, type Querier } from "@/utils/db/dbClient";

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
  isPublic: boolean;
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
