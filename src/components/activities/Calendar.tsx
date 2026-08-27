"use client";
import { useMemo, useState, useEffect } from "react";
import { Calendar as BigCalendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay, isBefore, startOfDay } from "date-fns";
import { pt } from "date-fns/locale/pt";
import "react-big-calendar/lib/css/react-big-calendar.css";
import EventDetails from "@/components/activities/EventDetails";
import { normalizeCalendarEvent } from "@/utils/calendarUtils";
import type { NormalizedCalendarEvent, CalendarEvent } from "@/types/events";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import EventIcon from "@/components/activities/EventIcon";
import { DEFAULT_EVENT_ICON_NAME } from "@/components/activities/IconRegistry";
import type { EventVisibility } from "@/types/eventVisibility";
import styles from "@/styles/components/activities/Calendar.module.css";

const locales = { pt };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

interface CalendarProps {
  events: CalendarEvent[];
  signedUpEventIds: string[];
}

interface ReactBigCalendarEvent {
  id: string;
  title: React.ReactNode;
  start: Date;
  end: Date;
  allDay?: boolean;
  resource?: CalendarEvent;
}

function getEventIconName(event: CalendarEvent): string {
  return (
    event?.extendedProperties?.private?.customIcon ||
    (event as CalendarEvent & { customIcon?: string })?.customIcon ||
    DEFAULT_EVENT_ICON_NAME
  );
}

function IconEventsCard({ event }: { event: ReactBigCalendarEvent }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {event.resource && (
        <EventIcon
          name={getEventIconName(event.resource)}
          size={18}
          style={{ marginRight: 6, verticalAlign: "middle" }}
        />
      )}
      <span>{event.title}</span>
    </span>
  );
}

function mapToBigCalendarEvent(event: NormalizedCalendarEvent) {
  return {
    id: event.id,
    title: event.summary,
    start: event.start,
    end: event.end,
    allDay: event.isAllDay,
    resource: event.raw,
  };
}

function CustomToolbar({
  label,
  onNavigate,
}: {
  label: string;
  onNavigate: (_action: "PREV" | "NEXT" | "TODAY") => void;
}) {
  const [month, year] = label.split(" ");

  return (
    <div className={styles.header}>
      <button className={styles.todayButton} onClick={() => onNavigate("TODAY")}>
        Hoje
      </button>
      <div className={styles.navigationButtons}>
        <button onClick={() => onNavigate("PREV")} aria-label="Previous Month">
          <FiChevronLeft />
        </button>
        <button onClick={() => onNavigate("NEXT")} aria-label="Next Month">
          <FiChevronRight />
        </button>
      </div>
      <span className={styles.monthLabel}>
        {month} {year}
      </span>
    </div>
  );
}

export default function Calendar({
  events,
  signedUpEventIds,
  initialSelectedEventId,
  canSetVisibility = false,
  visibilityById = {},
}: CalendarProps & {
  initialSelectedEventId?: string;
  /** #241 — whether to OFFER the visibility control. The API decides whether it takes effect. */
  canSetVisibility?: boolean;
  visibilityById?: Record<string, EventVisibility>;
}) {
  const [selectedEvent, setSelectedEvent] = useState<NormalizedCalendarEvent | null>(null);
  const [signUps, setSignUps] = useState<Set<string>>(new Set(signedUpEventIds));
  const [eventList, setEventList] = useState<CalendarEvent[]>(events);
  /**
   * The visible month, held here rather than inside react-big-calendar.
   *
   * The navigation always worked — clicking "<" really did move from agosto 2026 to julho 2026.
   * It LOOKED broken, and the reason is worth writing down: every one of NEIIST's imported events
   * is from the 2025/26 academic year, so the calendar opens on today's month, which is empty, and
   * so is every month either side of it. Pressing an arrow changed a small label and nothing else.
   *
   * Taking control of the date is what lets the empty state below offer to jump somewhere useful.
   */
  const [visibleDate, setVisibleDate] = useState<Date>(new Date());

  useEffect(() => {
    setEventList(events);
  }, [events]);
  useEffect(() => {
    setSignUps(new Set(signedUpEventIds));
  }, [signedUpEventIds]);

  const normalizedEvents = useMemo<NormalizedCalendarEvent[]>(
    () =>
      eventList.map(normalizeCalendarEvent).filter((e): e is NormalizedCalendarEvent => e !== null),
    [eventList]
  );
  const calendarEvents = useMemo<ReactBigCalendarEvent[]>(
    () => normalizedEvents.map(mapToBigCalendarEvent),
    [normalizedEvents]
  );
  useEffect(() => {
    if (initialSelectedEventId) {
      const normalized = normalizedEvents.find((e) => e.id === initialSelectedEventId);
      if (normalized) setSelectedEvent(normalized);
    }
  }, [initialSelectedEventId, normalizedEvents]);
  const handleEventUpdate = (updatedEvent: CalendarEvent) => {
    setEventList((prev) => prev.map((evt) => (evt.id === updatedEvent.id ? updatedEvent : evt)));
    setSelectedEvent((current) =>
      current && current.id === updatedEvent.id ? normalizeCalendarEvent(updatedEvent) : current
    );
  };
  /**
   * Memoised. As a fresh object literal this made `toolbar` a NEW component type on every render,
   * so React unmounted and remounted the whole toolbar each time the month changed — which is why
   * the arrows felt inert even when they were working.
   */
  const components = useMemo(
    () => ({
      toolbar: (props: {
        label: string;
        onNavigate: (_action: "PREV" | "NEXT" | "TODAY") => void;
      }) => <CustomToolbar label={props.label} onNavigate={props.onNavigate} />,
      event: IconEventsCard,
    }),
    []
  );

  /** Does the visible month contain anything? Drives the hint below. */
  const monthHasEvents = useMemo(
    () =>
      calendarEvents.some(
        (event) =>
          event.start.getFullYear() === visibleDate.getFullYear() &&
          event.start.getMonth() === visibleDate.getMonth()
      ),
    [calendarEvents, visibleDate]
  );

  /**
   * The month with an event closest to the one being viewed, in either direction.
   *
   * Nearest rather than "next", because NEIIST's calendar is seasonal: in August everything is
   * behind you, in September everything is ahead. A "next" link would be dead half the year.
   */
  const nearestEventDate = useMemo(() => {
    if (calendarEvents.length === 0 || monthHasEvents) return null;
    const target = visibleDate.getTime();
    return calendarEvents.reduce((closest, event) =>
      Math.abs(event.start.getTime() - target) < Math.abs(closest.start.getTime() - target)
        ? event
        : closest
    ).start;
  }, [calendarEvents, visibleDate, monthHasEvents]);

  const monthName = (date: Date) =>
    date.toLocaleDateString("pt-PT", { month: "long", year: "numeric" });

  const dayPropGetter = (date: Date) => {
    const now = startOfDay(new Date());
    if (isBefore(date, now)) {
      return {
        className: "rbc-past-day",
      };
    }
    return {};
  };

  const eventPropGetter = (event: ReactBigCalendarEvent) => {
    const now = new Date();
    if (isBefore(event.end, now)) {
      return {
        className: "rbc-past-event",
      };
    }
    return {};
  };

  return (
    <>
      <div className={styles.calendarWrapper}>
        <BigCalendar
          localizer={localizer}
          events={calendarEvents}
          startAccessor="start"
          endAccessor="end"
          titleAccessor="title"
          popup
          views={["month"]}
          showAllEvents={true}
          onSelectEvent={(event: ReactBigCalendarEvent) => {
            const normalized = normalizedEvents.find((e) => e.id === event.id);
            setSelectedEvent(normalized ?? null);
          }}
          components={components}
          dayPropGetter={dayPropGetter}
          eventPropGetter={eventPropGetter}
          culture="pt"
          date={visibleDate}
          onNavigate={(date: Date) => setVisibleDate(date)}
        />
      </div>

      {/* An empty month with no explanation reads as a broken calendar — which is exactly how this
          was reported. Saying so, and offering the nearest month that has something, turns it into
          an answer. */}
      {!monthHasEvents && calendarEvents.length > 0 && nearestEventDate ? (
        <p className={styles.emptyMonth}>
          Não há atividades em {monthName(visibleDate)}.{" "}
          <button type="button" onClick={() => setVisibleDate(nearestEventDate)}>
            Ver {monthName(nearestEventDate)}
          </button>
        </p>
      ) : null}

      {selectedEvent && (
        <EventDetails
          event={selectedEvent}
          canSetVisibility={canSetVisibility}
          visibilityById={visibilityById}
          onClose={() => setSelectedEvent(null)}
          isSignedUp={signUps.has(selectedEvent.id)}
          onSignUpChange={(eventId: string, signedUp: boolean) => {
            setSignUps((prev) => {
              const newSet = new Set(prev);
              if (signedUp) {
                newSet.add(eventId);
              } else {
                newSet.delete(eventId);
              }
              return newSet;
            });
          }}
          onUpdate={(updatedEvent?: CalendarEvent) =>
            handleEventUpdate(updatedEvent ?? selectedEvent!.raw)
          }
        />
      )}
    </>
  );
}
