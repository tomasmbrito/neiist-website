import type { NotionEvent } from "@/types/events";
import styles from "@/styles/components/activities/InternalEvents.module.css";

/**
 * Internal events and meetings, for members only (#127).
 *
 * A Server Component with no interactivity: the authorization decision is made on the page
 * before the data is fetched, so this component never receives events the caller may not see.
 * Keeping it server-side means there is no client bundle carrying internal event data either.
 *
 * Read-only by design. Phase 1 (#129) is where events become editable on the website; this view
 * exists to validate the data model against real Notion records first.
 */

const dateFormatter = new Intl.DateTimeFormat("pt-PT", {
  day: "2-digit",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

const formatWhen = (event: NotionEvent): string => {
  if (!event.date) return "Sem data";
  const start = new Date(event.date);
  if (Number.isNaN(start.getTime())) return "Sem data";
  return dateFormatter.format(start);
};

export default function InternalEvents({ events }: { events: NotionEvent[] }) {
  // Soonest first, and undated last rather than sorted to the top by a NaN comparison.
  const sorted = [...events].sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.date ? new Date(b.date).getTime() : Number.POSITIVE_INFINITY;
    return at - bt;
  });

  return (
    <section className={styles.container} aria-labelledby="internal-events-heading">
      <h2 id="internal-events-heading" className={styles.title}>
        Eventos internos
      </h2>
      <p className={styles.intro}>
        Reuniões e eventos que não são públicos. Visíveis apenas a membros do núcleo.
      </p>

      <ul className={styles.list}>
        {sorted.map((event) => (
          <li key={event.id} className={styles.item}>
            <div className={styles.when}>{formatWhen(event)}</div>
            <div className={styles.details}>
              <span className={styles.name}>{event.title}</span>
              <span className={styles.meta}>
                {event.type ? <span className={styles.type}>{event.type}</span> : null}
                {event.teams.length > 0 ? <span>{event.teams.join(" · ")}</span> : null}
                {event.location.length > 0 ? <span>{event.location.join(" · ")}</span> : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
