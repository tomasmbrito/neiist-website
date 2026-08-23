import Link from "next/link";
import type { MemberInternalEvent } from "@/utils/db/eventQueries";
import styles from "@/styles/components/activities/InternalEvents.module.css";

/**
 * Internal events and meetings, for members only (#127).
 *
 * A Server Component with no interactivity: the authorization decision is made on the page
 * before the data is fetched, so this component never receives events the caller may not see.
 * Keeping it server-side means there is no client bundle carrying internal event data either.
 *
 * Reads the **database**, not Notion, as of #129 slice C — the first time a member-facing panel
 * stopped depending on a third party at request time. It is also narrower than the Notion version
 * it replaces: that one showed every team's internal events to anyone with `activities.viewInternal`,
 * which predates the team boundary #183 established.
 *
 * Read-only here on purpose. Editing lives in the workspace, and each row links to it.
 */

const dateFormatter = new Intl.DateTimeFormat("pt-PT", {
  day: "2-digit",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

const formatWhen = (event: MemberInternalEvent): string => {
  const start = new Date(event.startsAt);
  if (Number.isNaN(start.getTime())) return "Sem data";
  return dateFormatter.format(start);
};

export default function InternalEvents({ events }: { events: MemberInternalEvent[] }) {
  // Soonest first. `starts_at` is NOT NULL now, so the undated case the Notion version had to
  // handle cannot occur — but an unparseable value still sorts last rather than to the top on NaN.
  const sorted = [...events].sort((a, b) => {
    const at = new Date(a.startsAt).getTime() || Number.POSITIVE_INFINITY;
    const bt = new Date(b.startsAt).getTime() || Number.POSITIVE_INFINITY;
    return at - bt;
  });

  return (
    <section className={styles.container} aria-labelledby="internal-events-heading">
      <h2 id="internal-events-heading" className={styles.title}>
        Eventos internos
      </h2>
      <p className={styles.intro}>
        Reuniões e eventos das tuas equipas. Geridos no{" "}
        <Link href="/workspace">Espaço de Trabalho</Link>.
      </p>

      <ul className={styles.list}>
        {sorted.map((event) => (
          <li key={event.id} className={styles.item}>
            <div className={styles.when}>{formatWhen(event)}</div>
            <div className={styles.details}>
              <span className={styles.name}>
                <Link
                  href={`/workspace/${encodeURIComponent(event.departmentName)}/events/${event.id}`}>
                  {event.name}
                </Link>
              </span>
              <span className={styles.meta}>
                <span className={styles.type}>
                  {event.kind === "meeting" ? "Reunião" : "Evento"}
                </span>
                <span>{event.departmentName}</span>
                {event.isPublic ? <span>público</span> : null}
                {event.locations.length > 0 ? <span>{event.locations.join(" · ")}</span> : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
