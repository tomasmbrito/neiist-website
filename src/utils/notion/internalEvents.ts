import { unstable_cache } from "next/cache";
import { fetchAllNotionEvents, isNotionConfigured } from "@/utils/eventsUtils";
import type { NotionEvent } from "@/types/events";

/**
 * Internal (non-public) events and meetings, read from Notion (#127).
 *
 * ## Why these do not come from the database
 *
 * `syncNotionEventsToDb` deliberately stores only public events, and *deletes* any event whose
 * `Public` checkbox is cleared (`eventsUtils.ts:170-172`). That is the right behaviour for a
 * table read by a public page, and #127 explicitly forbids new tables or schema changes — so
 * internal events are read from Notion per request instead of being persisted.
 *
 * This is a deliberate Phase-0 shape, not the end state. When Phase 1 (#129) makes the website
 * the source of truth for events, this module goes away along with the sync.
 *
 * ## Caching
 *
 * `/activities` already depends on Notion at request time, which #118 guarded but did not
 * remove. Adding a second uncached third-party call to a page render would make that worse, so
 * this one is cached: the first request after each window pays for Notion, the rest are free.
 */

/** Five minutes: internal meetings move on a human timescale, not a machine one. */
const CACHE_SECONDS = 300;

export const INTERNAL_EVENTS_CACHE_TAG = "notion-internal-events";

/**
 * Never throws.
 *
 * A third-party outage must not take `/activities` down — the same rule #118 established for
 * the public half. An unconfigured, rate-limited or unreachable Notion yields an empty list and
 * a logged warning, and the page renders without the internal section.
 */
const fetchInternalEvents = async (): Promise<NotionEvent[]> => {
  if (!isNotionConfigured()) return [];

  try {
    const all = await fetchAllNotionEvents();
    // The inverse of the public sync's filter. Both read the same parsed `public` flag, so the
    // two halves cannot disagree about what "internal" means.
    return all.filter((event) => !event.public);
  } catch (error) {
    console.error("[activities] failed to read internal events from Notion:", error);
    return [];
  }
};

export const getInternalNotionEvents = unstable_cache(
  fetchInternalEvents,
  ["notion-internal-events"],
  { revalidate: CACHE_SECONDS, tags: [INTERNAL_EVENTS_CACHE_TAG] }
);
