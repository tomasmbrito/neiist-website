import {
  CalendarEvent,
  EventSubscriber,
  DbActivityRow,
  mapDbRowToCalendarEvent,
  ActivityProperties,
  ActivityEvent,
} from "@/types/events";
import { db_query } from "@/utils/db/dbClient";

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
